//! `/bookmarks` — server-side persistence for the UI's favorite devices, so
//! saved hosts roam across browsers instead of living in each one's
//! localStorage.
//!
//! The whole store is one JSON document, fetched and replaced wholesale
//! (`GET` / `PUT`). The proxy deliberately does not parse it: under the
//! minimal-dependency constraint (no serde) it stores an opaque, size-capped
//! blob whose schema is owned by the UI — the only authorized writer. Writes
//! are atomic (sibling temp file + rename), so readers never see a
//! half-written document and a crash mid-write leaves the previous one intact.
//!
//! Unlike the WebSocket endpoints these are plain `fetch()` calls from the
//! UI's origin, so the handler answers CORS preflights; it enforces the same
//! Origin allowlist and Bearer-token auth as `/connect`. Error responses also
//! carry the CORS headers — without them the browser can't read the status,
//! and the UI needs 401-vs-404 to tell "bad token" from "feature disabled".

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::{
    Config, Request, authorized, origin_allowed, reject, reject_with_headers, write_response_full,
};

/// Largest accepted `PUT /bookmarks` body. Generous: even hundreds of saved
/// devices stay well under this.
const MAX_BODY_BYTES: usize = 64 * 1024;
/// What `GET` serves before anything has been saved.
const EMPTY_DOC: &str = "{\"version\":1,\"bookmarks\":[]}\n";

pub async fn handle(
    mut stream: TcpStream,
    peer: SocketAddr,
    config: Arc<Config>,
    request: Request,
) -> std::io::Result<()> {
    // Same Origin policy as the WebSocket endpoints; disallowed origins get a
    // bare 403 (no CORS headers) and learn nothing more.
    if !origin_allowed(&request, &config) {
        return reject(&mut stream, peer, "403 Forbidden", "origin not allowed\n").await;
    }
    let cors = cors_headers(&request);

    match request.method.as_str() {
        // Preflights are credential-less by spec, so no token check here.
        "OPTIONS" => {
            let mut headers = cors;
            headers.push(("Access-Control-Allow-Methods", "GET, PUT, OPTIONS".into()));
            headers.push((
                "Access-Control-Allow-Headers",
                "Authorization, Content-Type".into(),
            ));
            headers.push(("Access-Control-Max-Age", "86400".into()));
            write_response_full(&mut stream, "200 OK", "text/plain", &headers, b"").await
        }
        "GET" | "PUT" => {
            if !authorized(&request, &config) {
                return reject_with_headers(
                    &mut stream,
                    peer,
                    "401 Unauthorized",
                    &cors,
                    "unauthorized\n",
                )
                .await;
            }
            let Some(path) = config.bookmarks_path.as_deref() else {
                return reject_with_headers(
                    &mut stream,
                    peer,
                    "404 Not Found",
                    &cors,
                    "bookmarks are disabled (set BOOKMARKS_PATH)\n",
                )
                .await;
            };
            if request.method == "GET" {
                get(&mut stream, peer, path, &cors).await
            } else {
                put(&mut stream, peer, path, &cors, &request).await
            }
        }
        _ => {
            reject_with_headers(
                &mut stream,
                peer,
                "405 Method Not Allowed",
                &cors,
                "method not allowed\n",
            )
            .await
        }
    }
}

async fn get(
    stream: &mut TcpStream,
    peer: SocketAddr,
    path: &Path,
    cors: &[(&str, String)],
) -> std::io::Result<()> {
    let body = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => EMPTY_DOC.as_bytes().to_vec(),
        Err(err) => {
            eprintln!("[{peer}] bookmarks read failed ({}): {err}", path.display());
            return reject_with_headers(
                stream,
                peer,
                "500 Internal Server Error",
                cors,
                "failed to read bookmarks\n",
            )
            .await;
        }
    };
    write_response_full(
        stream,
        "200 OK",
        "application/json; charset=utf-8",
        cors,
        &body,
    )
    .await
}

async fn put(
    stream: &mut TcpStream,
    peer: SocketAddr,
    path: &Path,
    cors: &[(&str, String)],
    request: &Request,
) -> std::io::Result<()> {
    let length = request
        .headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok());
    let length = match length {
        Some(length) => length,
        None => {
            return reject_with_headers(
                stream,
                peer,
                "411 Length Required",
                cors,
                "Content-Length is required\n",
            )
            .await;
        }
    };
    if length > MAX_BODY_BYTES {
        return reject_with_headers(
            stream,
            peer,
            "413 Payload Too Large",
            cors,
            "bookmarks document too large\n",
        )
        .await;
    }

    // The head reader stopped exactly at the blank line, so the body is the
    // next `length` bytes on the socket.
    let mut body = vec![0u8; length];
    stream.read_exact(&mut body).await?;

    if !looks_like_json_object(&body) {
        return reject_with_headers(
            stream,
            peer,
            "400 Bad Request",
            cors,
            "body must be a JSON object\n",
        )
        .await;
    }

    if let Err(err) = store(path, &body).await {
        eprintln!(
            "[{peer}] bookmarks write failed ({}): {err}",
            path.display()
        );
        return reject_with_headers(
            stream,
            peer,
            "500 Internal Server Error",
            cors,
            "failed to write bookmarks\n",
        )
        .await;
    }

    eprintln!("[{peer}] bookmarks updated ({length} bytes)");
    write_response_full(stream, "200 OK", "text/plain; charset=utf-8", cors, b"ok\n").await
}

/// Echo the (already validated) Origin back rather than `*`, with `Vary` so
/// nothing caches one origin's response for another.
fn cors_headers(request: &Request) -> Vec<(&'static str, String)> {
    let mut headers = vec![("Vary", "Origin".to_string())];
    if let Some(origin) = request.headers.get("origin") {
        headers.push(("Access-Control-Allow-Origin", origin.clone()));
    }
    headers
}

/// Cheap sanity check standing in for JSON parsing (no serde by design): the
/// body must be UTF-8 and shaped like an object. Good enough to catch garbage
/// from a confused client; the schema itself is the UI's responsibility.
fn looks_like_json_object(body: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(body) else {
        return false;
    };
    let trimmed = text.trim();
    trimmed.starts_with('{') && trimmed.ends_with('}')
}

/// Replace the document atomically: write a sibling temp file (same
/// filesystem, so the rename can't cross a mount), fsync, rename over the old.
async fn store(path: &Path, body: &[u8]) -> std::io::Result<()> {
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);

    let mut file = tokio::fs::File::create(&tmp).await?;
    file.write_all(body).await?;
    file.sync_all().await?;
    drop(file);
    tokio::fs::rename(&tmp, path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("adb-ws-proxy-tests-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn json_object_check_accepts_objects_only() {
        assert!(looks_like_json_object(br#"{"version":1,"bookmarks":[]}"#));
        assert!(looks_like_json_object(b" \n{ }\n"));
        assert!(!looks_like_json_object(b"[]"));
        assert!(!looks_like_json_object(b"null"));
        assert!(!looks_like_json_object(b"{unterminated"));
        assert!(!looks_like_json_object(b""));
        assert!(!looks_like_json_object(&[0x7b, 0xff, 0xfe, 0x7d])); // not UTF-8
    }

    #[tokio::test]
    async fn store_round_trips_and_replaces() {
        let path = temp_path("bookmarks.json");
        let first = br#"{"version":1,"bookmarks":[]}"#;
        let second = br#"{"version":1,"bookmarks":[{"id":"a"}]}"#;

        store(&path, first).await.unwrap();
        assert_eq!(tokio::fs::read(&path).await.unwrap(), first);

        store(&path, second).await.unwrap();
        assert_eq!(tokio::fs::read(&path).await.unwrap(), second);

        // The temp file must not linger after a successful rename.
        assert!(!path.with_file_name("bookmarks.json.tmp").exists());
    }

    #[tokio::test]
    async fn store_fails_cleanly_on_missing_directory() {
        let path = temp_path("no-such-dir").join("bookmarks.json");
        assert!(store(&path, b"{}").await.is_err());
    }
}

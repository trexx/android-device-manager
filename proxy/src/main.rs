//! adb-ws-proxy — a stateless WebSocket-to-TCP relay for ADB over the network.
//!
//! The browser opens `wss://<proxy>/connect?host=<ip>&port=<port>&token=<token>`;
//! the proxy validates the auth token, checks the target IP against the subnet
//! allowlist, opens a TCP connection to `<ip>:<port>`, and shuffles raw bytes
//! between the WebSocket and the TCP socket. It does not understand the ADB
//! protocol — it's a dumb, bidirectional byte pipe.
//!
//! It is never an open relay: every upgrade requires a valid token, `/connect`
//! targets must sit inside the configured private subnets, and concurrency is
//! capped. The `/adb-server` endpoint instead relays to a fixed local `adb`
//! server (`ADB_SERVER_ADDR`) for ADB-server-mode clients.
//!
//! Kubernetes probes (`/healthz`, `/readyz`, `/startupz`) are unauthenticated,
//! plain-text, and served on the same port as the WebSocket endpoint.
//!
//! One optional stateful extra: `/bookmarks` (enabled by `BOOKMARKS_PATH`)
//! persists a small JSON document of saved devices so the UI's favorites roam
//! across browsers — see `bookmarks.rs`.

mod bookmarks;

use std::collections::HashMap;
use std::env;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;

/// Maximum size of the HTTP request head we'll read before giving up.
const MAX_HEAD_BYTES: usize = 16 * 1024;
/// Relay copy buffer for the TCP -> WebSocket direction.
const RELAY_BUF_BYTES: usize = 16 * 1024;

struct Config {
    listen_addr: String,
    auth_token: String,
    /// (network address, prefix length) pairs.
    allowed_subnets: Vec<(IpAddr, u8)>,
    /// If set, the WebSocket `Origin` header must match one of these exactly.
    allowed_origins: Option<Vec<String>>,
    max_connections: usize,
    /// Fixed target for the `/adb-server` relay (an `adb server` smart-socket port).
    adb_server_addr: String,
    /// Where `/bookmarks` persists its JSON document; `None` disables the endpoint.
    bookmarks_path: Option<PathBuf>,
}

#[tokio::main]
async fn main() {
    let config = match load_config() {
        Ok(config) => Arc::new(config),
        Err(err) => {
            eprintln!("configuration error: {err}");
            std::process::exit(1);
        }
    };

    let listener = match TcpListener::bind(&config.listen_addr).await {
        Ok(listener) => listener,
        Err(err) => {
            eprintln!("failed to bind {}: {err}", config.listen_addr);
            std::process::exit(1);
        }
    };

    eprintln!("adb-ws-proxy listening on {}", config.listen_addr);
    eprintln!("  max connections: {}", config.max_connections);
    eprintln!(
        "  allowed subnets: {}",
        format_subnets(&config.allowed_subnets)
    );
    match &config.allowed_origins {
        Some(origins) => eprintln!("  allowed origins: {}", origins.join(", ")),
        None => eprintln!("  allowed origins: (any — set ALLOWED_ORIGIN to restrict)"),
    }
    eprintln!(
        "  adb-server target: {} (/adb-server)",
        config.adb_server_addr
    );
    match &config.bookmarks_path {
        Some(path) => eprintln!("  bookmarks: {} (/bookmarks)", path.display()),
        None => eprintln!("  bookmarks: (disabled — set BOOKMARKS_PATH to enable)"),
    }

    let permits = Arc::new(Semaphore::new(config.max_connections));

    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(err) => {
                eprintln!("accept error: {err}");
                continue;
            }
        };

        let config = config.clone();
        let permits = permits.clone();
        tokio::spawn(async move {
            if let Err(err) = handle_connection(stream, peer, config, permits).await {
                eprintln!("[{peer}] io error: {err}");
            }
        });
    }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

fn load_config() -> Result<Config, String> {
    let listen_addr = env::var("LISTEN_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());

    let auth_token = env::var("AUTH_TOKEN").map_err(|_| {
        "AUTH_TOKEN is required (refusing to run without authentication)".to_string()
    })?;
    if auth_token.is_empty() {
        return Err("AUTH_TOKEN must not be empty".to_string());
    }

    let allowed_subnets = match env::var("ALLOWED_SUBNETS") {
        Ok(value) if !value.trim().is_empty() => parse_subnets(&value)?,
        _ => default_private_subnets(),
    };

    let allowed_origins = match env::var("ALLOWED_ORIGIN") {
        Ok(value) if !value.trim().is_empty() => Some(
            value
                .split(',')
                .map(|origin| origin.trim().to_string())
                .filter(|origin| !origin.is_empty())
                .collect(),
        ),
        _ => None,
    };

    let max_connections = match env::var("MAX_CONNECTIONS") {
        Ok(value) => value
            .trim()
            .parse::<usize>()
            .map_err(|_| format!("MAX_CONNECTIONS is not a valid number: {value}"))?,
        Err(_) => 20,
    };
    if max_connections == 0 {
        return Err("MAX_CONNECTIONS must be at least 1".to_string());
    }

    let adb_server_addr =
        env::var("ADB_SERVER_ADDR").unwrap_or_else(|_| "127.0.0.1:5037".to_string());

    let bookmarks_path = env::var("BOOKMARKS_PATH")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);

    Ok(Config {
        listen_addr,
        auth_token,
        allowed_subnets,
        allowed_origins,
        max_connections,
        adb_server_addr,
        bookmarks_path,
    })
}

fn default_private_subnets() -> Vec<(IpAddr, u8)> {
    vec![
        ("10.0.0.0".parse().unwrap(), 8),
        ("172.16.0.0".parse().unwrap(), 12),
        ("192.168.0.0".parse().unwrap(), 16),
    ]
}

fn parse_subnets(value: &str) -> Result<Vec<(IpAddr, u8)>, String> {
    let mut subnets = Vec::new();
    for entry in value.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let (addr_part, prefix) = match entry.split_once('/') {
            Some((addr, prefix)) => {
                let prefix = prefix
                    .parse::<u8>()
                    .map_err(|_| format!("invalid prefix length in subnet: {entry}"))?;
                (addr, prefix)
            }
            // No prefix means a single host.
            None => (entry, 0u8),
        };
        let addr: IpAddr = addr_part
            .parse()
            .map_err(|_| format!("invalid IP address in subnet: {entry}"))?;
        let prefix = if entry.contains('/') {
            prefix
        } else if addr.is_ipv4() {
            32
        } else {
            128
        };
        let max = if addr.is_ipv4() { 32 } else { 128 };
        if prefix > max {
            return Err(format!("prefix length out of range in subnet: {entry}"));
        }
        subnets.push((addr, prefix));
    }
    if subnets.is_empty() {
        return Err("ALLOWED_SUBNETS contained no valid entries".to_string());
    }
    Ok(subnets)
}

fn format_subnets(subnets: &[(IpAddr, u8)]) -> String {
    subnets
        .iter()
        .map(|(addr, prefix)| format!("{addr}/{prefix}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Returns true if `ip` falls inside the CIDR block `net/prefix`.
fn ip_in_subnet(ip: IpAddr, net: IpAddr, prefix: u8) -> bool {
    match (ip, net) {
        (IpAddr::V4(ip), IpAddr::V4(net)) => {
            if prefix == 0 {
                return true;
            }
            if prefix > 32 {
                return false;
            }
            let mask: u32 = u32::MAX << (32 - prefix);
            (u32::from(ip) & mask) == (u32::from(net) & mask)
        }
        (IpAddr::V6(ip), IpAddr::V6(net)) => {
            if prefix == 0 {
                return true;
            }
            if prefix > 128 {
                return false;
            }
            let mask: u128 = u128::MAX << (128 - prefix);
            (u128::from(ip) & mask) == (u128::from(net) & mask)
        }
        // Mixed families never match.
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// HTTP request handling
// ---------------------------------------------------------------------------

struct Request {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
}

async fn handle_connection(
    mut stream: TcpStream,
    peer: SocketAddr,
    config: Arc<Config>,
    permits: Arc<Semaphore>,
) -> std::io::Result<()> {
    let head = read_http_head(&mut stream, MAX_HEAD_BYTES).await?;
    let head = String::from_utf8_lossy(&head);

    let request = match parse_request(&head) {
        Some(request) => request,
        None => return write_response(&mut stream, "400 Bad Request", "bad request\n").await,
    };

    match request.path.as_str() {
        // Unauthenticated probes, plain-text bodies, served on the same port.
        "/healthz" | "/startupz" => write_response(&mut stream, "200 OK", "ok\n").await,
        "/readyz" => {
            if permits.available_permits() > 0 {
                write_response(&mut stream, "200 OK", "ok\n").await
            } else {
                write_response(&mut stream, "503 Service Unavailable", "unavailable\n").await
            }
        }
        "/connect" => handle_connect(stream, peer, config, permits, request).await,
        "/adb-server" => handle_adb_server(stream, peer, config, permits, request).await,
        "/bookmarks" => bookmarks::handle(stream, peer, config, request).await,
        _ => write_response(&mut stream, "404 Not Found", "not found\n").await,
    }
}

/// Log and send an HTTP error for a rejected `/connect` attempt, so the cause is
/// visible in the proxy's stderr.
async fn reject(
    stream: &mut TcpStream,
    peer: SocketAddr,
    status: &str,
    body: &str,
) -> std::io::Result<()> {
    reject_with_headers(stream, peer, status, &[], body).await
}

/// `reject` with extra response headers — `/bookmarks` errors carry CORS
/// headers so the browser is allowed to read the status code.
async fn reject_with_headers(
    stream: &mut TcpStream,
    peer: SocketAddr,
    status: &str,
    extra_headers: &[(&str, String)],
    body: &str,
) -> std::io::Result<()> {
    eprintln!("[{peer}] reject {status}: {}", body.trim_end());
    write_response_full(
        stream,
        status,
        "text/plain; charset=utf-8",
        extra_headers,
        body.as_bytes(),
    )
    .await
}

/// Validate method, WebSocket upgrade, optional Origin allowlist, and auth token —
/// shared by every upgrade endpoint. On rejection the HTTP error is written and
/// `None` is returned; on success returns the `Sec-WebSocket-Key`.
async fn precheck_ws(
    stream: &mut TcpStream,
    peer: SocketAddr,
    request: &Request,
    config: &Config,
) -> std::io::Result<Option<String>> {
    if request.method != "GET" {
        reject(
            stream,
            peer,
            "405 Method Not Allowed",
            "method not allowed\n",
        )
        .await?;
        return Ok(None);
    }

    let is_upgrade = request
        .headers
        .get("upgrade")
        .map(|value| value.to_ascii_lowercase().contains("websocket"))
        .unwrap_or(false);
    let ws_key = match (is_upgrade, request.headers.get("sec-websocket-key")) {
        (true, Some(key)) => key.clone(),
        _ => {
            reject(
                stream,
                peer,
                "426 Upgrade Required",
                "expected a websocket upgrade\n",
            )
            .await?;
            return Ok(None);
        }
    };

    // Optional Origin allowlist (CORS for WebSocket = validate the Origin header).
    if !origin_allowed(request, config) {
        reject(stream, peer, "403 Forbidden", "origin not allowed\n").await?;
        return Ok(None);
    }

    if !authorized(request, config) {
        reject(stream, peer, "401 Unauthorized", "unauthorized\n").await?;
        return Ok(None);
    }

    Ok(Some(ws_key))
}

/// When `ALLOWED_ORIGIN` is configured the `Origin` header must match one of
/// the entries exactly (a missing header is rejected); with no allowlist any
/// origin passes. Shared by the WebSocket endpoints and `/bookmarks`.
fn origin_allowed(request: &Request, config: &Config) -> bool {
    match &config.allowed_origins {
        Some(allowed) => {
            let origin = request
                .headers
                .get("origin")
                .map(String::as_str)
                .unwrap_or("");
            allowed.iter().any(|candidate| candidate == origin)
        }
        None => true,
    }
}

/// Auth: `Authorization: Bearer <token>` or `?token=<token>`, compared in
/// constant time. Browsers can't set request headers on a WebSocket, so the
/// query param is the usual path there; `fetch()` callers use the header.
fn authorized(request: &Request, config: &Config) -> bool {
    let provided_token = request
        .headers
        .get("authorization")
        .and_then(|value| {
            value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("bearer "))
        })
        .or_else(|| request.query.get("token").map(String::as_str));
    provided_token
        .map(|token| constant_time_eq(token.as_bytes(), config.auth_token.as_bytes()))
        .unwrap_or(false)
}

/// Acquire a connection permit, connect to `target`, complete the WebSocket
/// handshake by hand, and pump bytes until either side closes.
async fn upgrade_and_relay(
    mut stream: TcpStream,
    peer: SocketAddr,
    config: &Config,
    permits: Arc<Semaphore>,
    request: &Request,
    ws_key: &str,
    target: &str,
) -> std::io::Result<()> {
    let permit = match permits.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            return reject(
                &mut stream,
                peer,
                "503 Service Unavailable",
                "too many connections\n",
            )
            .await;
        }
    };

    // Connect upstream BEFORE upgrading, so failures surface as a clean HTTP error.
    let tcp = match TcpStream::connect(target).await {
        Ok(tcp) => tcp,
        Err(err) => {
            return reject(
                &mut stream,
                peer,
                "502 Bad Gateway",
                &format!("upstream connection failed: {err}\n"),
            )
            .await;
        }
    };

    // Complete the WebSocket handshake by hand (we already consumed the request
    // head, so we can't hand it to tungstenite's accept path).
    let accept_key = derive_accept_key(ws_key.as_bytes());
    let mut response = String::new();
    response.push_str("HTTP/1.1 101 Switching Protocols\r\n");
    response.push_str("Upgrade: websocket\r\n");
    response.push_str("Connection: Upgrade\r\n");
    response.push_str(&format!("Sec-WebSocket-Accept: {accept_key}\r\n"));
    if config.allowed_origins.is_some()
        && let Some(origin) = request.headers.get("origin")
    {
        response.push_str(&format!("Access-Control-Allow-Origin: {origin}\r\n"));
    }
    response.push_str("\r\n");
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await?;

    let ws = WebSocketStream::from_raw_socket(stream, Role::Server, None).await;
    eprintln!("[{peer}] relay open -> {target}");
    relay(ws, tcp).await;
    drop(permit);
    eprintln!("[{peer}] relay closed -> {target}");
    Ok(())
}

/// `/adb-server` — relay to the configured `adb server` smart-socket port. Same
/// token/origin checks as `/connect`, but a fixed target (no subnet check).
async fn handle_adb_server(
    mut stream: TcpStream,
    peer: SocketAddr,
    config: Arc<Config>,
    permits: Arc<Semaphore>,
    request: Request,
) -> std::io::Result<()> {
    let ws_key = match precheck_ws(&mut stream, peer, &request, &config).await? {
        Some(key) => key,
        None => return Ok(()),
    };
    let target = config.adb_server_addr.clone();
    upgrade_and_relay(stream, peer, &config, permits, &request, &ws_key, &target).await
}

async fn handle_connect(
    mut stream: TcpStream,
    peer: SocketAddr,
    config: Arc<Config>,
    permits: Arc<Semaphore>,
    request: Request,
) -> std::io::Result<()> {
    let ws_key = match precheck_ws(&mut stream, peer, &request, &config).await? {
        Some(key) => key,
        None => return Ok(()),
    };

    // Target host + port.
    let host = request.query.get("host").cloned();
    let port = request
        .query
        .get("port")
        .and_then(|value| value.parse::<u16>().ok());
    let (host, port) = match (host, port) {
        (Some(host), Some(port)) => (host, port),
        _ => {
            return reject(
                &mut stream,
                peer,
                "400 Bad Request",
                "host and port query parameters are required\n",
            )
            .await;
        }
    };

    let target_ip: IpAddr = match host.parse() {
        Ok(ip) => ip,
        Err(_) => {
            return reject(
                &mut stream,
                peer,
                "400 Bad Request",
                "host must be an IP address\n",
            )
            .await;
        }
    };

    if !config
        .allowed_subnets
        .iter()
        .any(|(net, prefix)| ip_in_subnet(target_ip, *net, *prefix))
    {
        return reject(
            &mut stream,
            peer,
            "403 Forbidden",
            "target is not in an allowed subnet\n",
        )
        .await;
    }

    let target = SocketAddr::new(target_ip, port).to_string();
    upgrade_and_relay(stream, peer, &config, permits, &request, &ws_key, &target).await
}

/// Read the HTTP request head (up to and including the blank line) one byte at a
/// time, so we never overshoot into WebSocket frame data on the same socket.
async fn read_http_head(stream: &mut TcpStream, max: usize) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    loop {
        let n = stream.read(&mut byte).await?;
        if n == 0 {
            break; // EOF before headers completed.
        }
        buf.push(byte[0]);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
        if buf.len() >= max {
            break;
        }
    }
    Ok(buf)
}

fn parse_request(head: &str) -> Option<Request> {
    let mut lines = head.split("\r\n");

    let request_line = lines.next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?;

    let (path, query_str) = match target.split_once('?') {
        Some((path, query)) => (path.to_string(), query),
        None => (target.to_string(), ""),
    };
    let query = parse_query(query_str);

    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            break; // End of headers.
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    Some(Request {
        method,
        path,
        query,
        headers,
    })
}

fn parse_query(query: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = match pair.split_once('=') {
            Some((key, value)) => (key, value),
            None => (pair, ""),
        };
        map.insert(percent_decode(key), percent_decode(value));
    }
    map
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex_value(bytes[i + 1]), hex_value(bytes[i + 2]))
        {
            out.push((hi << 4) | lo);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

async fn write_response(stream: &mut TcpStream, status: &str, body: &str) -> std::io::Result<()> {
    write_response_full(
        stream,
        status,
        "text/plain; charset=utf-8",
        &[],
        body.as_bytes(),
    )
    .await
}

/// `write_response` with a caller-chosen content type and extra headers —
/// `/bookmarks` needs `application/json` bodies and CORS headers.
async fn write_response_full(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    extra_headers: &[(&str, String)],
    body: &[u8],
) -> std::io::Result<()> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (name, value) in extra_headers {
        response.push_str(name);
        response.push_str(": ");
        response.push_str(value);
        response.push_str("\r\n");
    }
    response.push_str("\r\n");
    stream.write_all(response.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

/// Bidirectional byte pump between a WebSocket and a TCP socket. Ping/Pong are
/// handled internally by tungstenite (the split sink shares the connection), so
/// we only forward Binary/Text payloads and stop on Close or either-side error.
async fn relay(ws: WebSocketStream<TcpStream>, tcp: TcpStream) {
    let (mut ws_tx, mut ws_rx) = ws.split();
    let (mut tcp_rd, mut tcp_wr) = tcp.into_split();

    let client_to_server = async {
        while let Some(message) = ws_rx.next().await {
            let message = match message {
                Ok(message) => message,
                Err(_) => break,
            };
            let payload: &[u8] = match &message {
                Message::Binary(data) => data.as_ref(),
                Message::Text(text) => text.as_bytes(),
                Message::Close(_) => break,
                // Ping/Pong/Frame: tungstenite manages control frames for us.
                _ => continue,
            };
            if tcp_wr.write_all(payload).await.is_err() {
                break;
            }
        }
        let _ = tcp_wr.shutdown().await;
    };

    let server_to_client = async {
        let mut buf = vec![0u8; RELAY_BUF_BYTES];
        loop {
            match tcp_rd.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    if ws_tx
                        .send(Message::binary(buf[..n].to_vec()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = ws_tx.close().await;
    };

    tokio::select! {
        _ = client_to_server => {}
        _ = server_to_client => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> Config {
        Config {
            listen_addr: "127.0.0.1:0".into(),
            auth_token: "secret".into(),
            allowed_subnets: default_private_subnets(),
            allowed_origins: Some(vec!["https://ui.example".into()]),
            max_connections: 1,
            adb_server_addr: "127.0.0.1:5037".into(),
            bookmarks_path: None,
        }
    }

    fn request(headers: &[(&str, &str)], query: &[(&str, &str)]) -> Request {
        Request {
            method: "GET".into(),
            path: "/".into(),
            query: query
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    #[test]
    fn authorized_accepts_bearer_header_or_query_param() {
        let config = test_config();
        assert!(authorized(
            &request(&[("authorization", "Bearer secret")], &[]),
            &config
        ));
        assert!(authorized(&request(&[], &[("token", "secret")]), &config));
        assert!(!authorized(
            &request(&[("authorization", "Bearer wrong")], &[]),
            &config
        ));
        assert!(!authorized(&request(&[], &[("token", "")]), &config));
        assert!(!authorized(&request(&[], &[]), &config));
    }

    #[test]
    fn origin_allowlist_requires_exact_match_when_configured() {
        let config = test_config();
        assert!(origin_allowed(
            &request(&[("origin", "https://ui.example")], &[]),
            &config
        ));
        assert!(!origin_allowed(
            &request(&[("origin", "https://evil.example")], &[]),
            &config
        ));
        // A missing Origin header is rejected while an allowlist is set...
        assert!(!origin_allowed(&request(&[], &[]), &config));
        // ...and anything goes when it isn't.
        let open = Config {
            allowed_origins: None,
            ..test_config()
        };
        assert!(origin_allowed(&request(&[], &[]), &open));
    }
}

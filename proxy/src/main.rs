//! adb-ws-proxy — a stateless WebSocket-to-TCP relay for ADB over the network.
//!
//! The browser opens `wss://<proxy>/connect?host=<ip>&port=<port>`, offering the
//! auth token as a WebSocket subprotocol (`adm-token-<hex>`, see
//! `token_protocol`); the proxy validates the token, checks the target IP against
//! the subnet allowlist, opens a TCP connection to `<ip>:<port>`, and shuffles
//! raw bytes between the WebSocket and the TCP socket. It does not understand
//! the ADB protocol — it's a dumb, bidirectional byte pipe.
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
use std::fmt::Write as _;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio::time::{MissedTickBehavior, timeout};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Bytes, Message};

/// Maximum size of the HTTP request head we'll read before giving up.
const MAX_HEAD_BYTES: usize = 16 * 1024;
/// Relay copy buffer for the TCP -> WebSocket direction.
const RELAY_BUF_BYTES: usize = 16 * 1024;
/// How long a client gets to deliver its HTTP request head (and, for
/// `/bookmarks`, its body). Nothing before this point holds a permit, so
/// without a bound idle sockets could pile up without limit.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Server-initiated WebSocket ping cadence (see `relay`).
const PING_INTERVAL: Duration = Duration::from_secs(30);
/// A relay whose client sends nothing at all — not even a Pong — for this long
/// is closed and its permit released.
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Largest WebSocket message (and frame) accepted from a client. ADB never puts
/// more than its 1 MiB maxdata into one write, so this is generous; it bounds
/// what a token holder can make the proxy buffer per connection.
const MAX_WS_MESSAGE_BYTES: usize = 4 << 20;
/// tungstenite's eagerly allocated per-connection read buffer (default 128 KiB).
const WS_READ_BUFFER_BYTES: usize = 32 * 1024;

struct Config {
    listen_addr: String,
    auth_token: String,
    /// `auth_token` in its WebSocket-subprotocol form (see `token_protocol`).
    token_protocol: String,
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

    let started_adb = maybe_start_adb_server().await;

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

    // Run until SIGTERM/SIGINT. The proxy is PID 1 in the container image, and
    // PID 1 gets no default signal dispositions, so without an explicit handler
    // `docker stop` would sit out its grace period and then SIGKILL us (and the
    // adb server we started).
    tokio::select! {
        _ = serve(listener, config, permits) => {}
        _ = shutdown_signal() => eprintln!("shutdown signal received; exiting"),
    }

    if started_adb {
        stop_adb_server().await;
    }
}

/// Accept loop: one task per connection, forever.
async fn serve(listener: TcpListener, config: Arc<Config>, permits: Arc<Semaphore>) {
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

/// Resolves on SIGINT (Ctrl-C) or, on Unix, SIGTERM.
async fn shutdown_signal() {
    #[cfg(unix)]
    let sigterm = async {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                term.recv().await;
            }
            Err(err) => {
                eprintln!("warning: cannot listen for SIGTERM ({err})");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let sigterm = std::future::pending::<()>();

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = sigterm => {}
    }
}

// ---------------------------------------------------------------------------
// adb server startup
// ---------------------------------------------------------------------------

/// Best-effort start of a local `adb server` for `/adb-server` mode. Skipped
/// when `START_ADB_SERVER` is set to anything other than `1` (e.g. because
/// `ADB_SERVER_ADDR` points at an external server). The runtime image has no
/// shell, so this replaces what used to be a `docker-entrypoint.sh` wrapper —
/// `/connect` doesn't need `adb` at all, so a failure here only warns, it
/// never aborts startup. Returns whether a server was started (so shutdown
/// knows to stop it again).
async fn maybe_start_adb_server() -> bool {
    let enabled = env::var("START_ADB_SERVER").unwrap_or_else(|_| "1".to_string()) == "1";
    if !enabled {
        return false;
    }
    match Command::new("adb").arg("start-server").output().await {
        Ok(output) if output.status.success() => true,
        Ok(output) => {
            eprintln!(
                "warning: adb start-server exited with {}; /adb-server mode unavailable",
                output.status
            );
            false
        }
        Err(err) => {
            eprintln!("warning: could not start adb server ({err}); /adb-server mode unavailable");
            false
        }
    }
}

/// Counterpart of `maybe_start_adb_server` for shutdown: stop the server we
/// started so it doesn't outlive the container. Best effort and bounded.
async fn stop_adb_server() {
    let kill = Command::new("adb")
        .arg("kill-server")
        .kill_on_drop(true)
        .output();
    match timeout(Duration::from_secs(5), kill).await {
        Ok(Ok(output)) if output.status.success() => eprintln!("adb server stopped"),
        Ok(Ok(output)) => eprintln!("warning: adb kill-server exited with {}", output.status),
        Ok(Err(err)) => eprintln!("warning: could not run adb kill-server ({err})"),
        Err(_) => eprintln!("warning: adb kill-server timed out"),
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
    let token_protocol = token_protocol(&auth_token);

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
        token_protocol,
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
    let head = match timeout(
        HANDSHAKE_TIMEOUT,
        read_http_head(&mut stream, MAX_HEAD_BYTES),
    )
    .await
    {
        Ok(head) => head?,
        Err(_) => {
            return reject(
                &mut stream,
                peer,
                "408 Request Timeout",
                "request head not received in time\n",
            )
            .await;
        }
    };
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

/// Auth, in order of precedence: `Authorization: Bearer <token>`, the token
/// subprotocol (`Sec-WebSocket-Protocol: adm-token-<hex>`, see
/// `token_protocol`), then `?token=<token>`. Comparisons are constant time.
///
/// Browsers can't set request headers on a WebSocket but can offer
/// subprotocols, so the UI uses the subprotocol: it keeps the token out of the
/// request line and therefore out of reverse-proxy access logs. `fetch()`
/// callers use the header; the query form remains for curl-style clients.
fn authorized(request: &Request, config: &Config) -> bool {
    if let Some(token) = request.headers.get("authorization").and_then(|value| {
        value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
    }) {
        return constant_time_eq(token.as_bytes(), config.auth_token.as_bytes());
    }
    if offered_token_protocol(request, config) {
        return true;
    }
    request
        .query
        .get("token")
        .map(|token| constant_time_eq(token.as_bytes(), config.auth_token.as_bytes()))
        .unwrap_or(false)
}

/// Whether the client offered the token subprotocol in `Sec-WebSocket-Protocol`
/// (a comma-separated list). When it did, the 101 response must echo it back
/// or the browser aborts the connection.
fn offered_token_protocol(request: &Request, config: &Config) -> bool {
    request
        .headers
        .get("sec-websocket-protocol")
        .map(|value| {
            value.split(',').map(str::trim).any(|candidate| {
                constant_time_eq(candidate.as_bytes(), config.token_protocol.as_bytes())
            })
        })
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
    // A client that offered the token subprotocol expects it selected in the
    // response (browsers abort the connection otherwise).
    if offered_token_protocol(request, config) {
        response.push_str(&format!(
            "Sec-WebSocket-Protocol: {}\r\n",
            config.token_protocol
        ));
    }
    response.push_str("\r\n");
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await?;

    let ws_config = WebSocketConfig::default()
        .max_message_size(Some(MAX_WS_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_WS_MESSAGE_BYTES))
        .read_buffer_size(WS_READ_BUFFER_BYTES);
    let ws = WebSocketStream::from_raw_socket(stream, Role::Server, Some(ws_config)).await;
    eprintln!("[{peer}] relay open -> {target}");
    let end = relay(ws, tcp).await;
    drop(permit);
    match end {
        RelayEnd::Closed => eprintln!("[{peer}] relay closed -> {target}"),
        RelayEnd::Idle => eprintln!(
            "[{peer}] relay closed (idle: no frames for {}s) -> {target}",
            IDLE_TIMEOUT.as_secs()
        ),
    }
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

/// The WebSocket subprotocol name that carries the token: `adm-token-` plus the
/// token's bytes in lowercase hex, which keeps any token inside RFC 6455's
/// token charset. The UI encodes the same way; the proxy never decodes, it just
/// compares encoded forms.
fn token_protocol(token: &str) -> String {
    let mut out = String::with_capacity(10 + token.len() * 2);
    out.push_str("adm-token-");
    for byte in token.bytes() {
        let _ = write!(out, "{byte:02x}");
    }
    out
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

/// Why a relay ended: the normal way (either side closed or errored) or
/// because the client went silent.
enum RelayEnd {
    Closed,
    Idle,
}

/// Bidirectional byte pump between a WebSocket and a TCP socket. Ping/Pong are
/// handled internally by tungstenite (the split sink shares the connection), so
/// we only forward Binary/Text payloads and stop on Close or either-side error.
///
/// Liveness: the proxy pings every `PING_INTERVAL`, and a client that sends
/// nothing at all for `IDLE_TIMEOUT` — not even the Pong tungstenite delivers to
/// our reader — is dropped. Without this a peer that vanished without a FIN
/// (laptop lid closed, NAT entry expired) would hold its permit until the
/// kernel's TCP keepalive fired, hours later.
async fn relay(ws: WebSocketStream<TcpStream>, tcp: TcpStream) -> RelayEnd {
    let (mut ws_tx, mut ws_rx) = ws.split();
    let (mut tcp_rd, mut tcp_wr) = tcp.into_split();

    let client_to_server = async {
        loop {
            let message = match timeout(IDLE_TIMEOUT, ws_rx.next()).await {
                Err(_) => return RelayEnd::Idle,
                Ok(Some(Ok(message))) => message,
                Ok(Some(Err(_))) | Ok(None) => break,
            };
            let payload: &[u8] = match &message {
                Message::Binary(data) => data.as_ref(),
                Message::Text(text) => text.as_bytes(),
                Message::Close(_) => break,
                // Ping/Pong/Frame: tungstenite manages control frames for us;
                // for liveness their arrival is all that matters.
                _ => continue,
            };
            if tcp_wr.write_all(payload).await.is_err() {
                break;
            }
        }
        let _ = tcp_wr.shutdown().await;
        RelayEnd::Closed
    };

    let server_to_client = async {
        let mut buf = vec![0u8; RELAY_BUF_BYTES];
        let mut ping = tokio::time::interval(PING_INTERVAL);
        ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
        ping.tick().await; // The first tick completes immediately; skip it.
        loop {
            tokio::select! {
                read = tcp_rd.read(&mut buf) => match read {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if ws_tx.send(Message::binary(buf[..n].to_vec())).await.is_err() {
                            break;
                        }
                    }
                },
                _ = ping.tick() => {
                    if ws_tx.send(Message::Ping(Bytes::new())).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = ws_tx.close().await;
        RelayEnd::Closed
    };

    tokio::select! {
        end = client_to_server => end,
        end = server_to_client => end,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> Config {
        Config {
            listen_addr: "127.0.0.1:0".into(),
            auth_token: "secret".into(),
            token_protocol: token_protocol("secret"),
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

    #[test]
    fn token_protocol_is_prefixed_lowercase_hex() {
        assert_eq!(token_protocol("secret"), "adm-token-736563726574");
        assert_eq!(token_protocol(""), "adm-token-");
    }

    #[test]
    fn authorized_accepts_the_token_subprotocol() {
        let config = test_config();
        let ok = config.token_protocol.as_str();
        assert!(authorized(
            &request(&[("sec-websocket-protocol", ok)], &[]),
            &config
        ));
        // Anywhere in the comma-separated list, whitespace tolerated.
        let listed = format!("foo , {ok}, bar");
        assert!(authorized(
            &request(&[("sec-websocket-protocol", listed.as_str())], &[]),
            &config
        ));
        assert!(!authorized(
            &request(&[("sec-websocket-protocol", "adm-token-deadbeef")], &[]),
            &config
        ));
        // A Bearer header takes precedence; a wrong one isn't rescued by the
        // subprotocol.
        assert!(!authorized(
            &request(
                &[
                    ("authorization", "Bearer wrong"),
                    ("sec-websocket-protocol", ok)
                ],
                &[]
            ),
            &config
        ));
    }

    #[test]
    fn subnets_parse_hosts_and_cidrs() {
        let subnets = parse_subnets("192.168.1.5, 10.0.0.0/8,, ::1").unwrap();
        assert_eq!(
            subnets,
            vec![
                ("192.168.1.5".parse().unwrap(), 32),
                ("10.0.0.0".parse().unwrap(), 8),
                ("::1".parse().unwrap(), 128),
            ]
        );
        assert!(parse_subnets("10.0.0.0/33").is_err());
        assert!(parse_subnets("not-an-ip").is_err());
        assert!(parse_subnets(" , ").is_err());
    }

    #[test]
    fn ip_in_subnet_matches_by_prefix() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert!(ip_in_subnet(ip("192.168.7.9"), ip("192.168.0.0"), 16));
        assert!(!ip_in_subnet(ip("192.169.0.1"), ip("192.168.0.0"), 16));
        assert!(ip_in_subnet(ip("8.8.8.8"), ip("0.0.0.0"), 0));
        assert!(ip_in_subnet(ip("10.1.2.3"), ip("10.1.2.3"), 32));
        assert!(!ip_in_subnet(ip("10.1.2.4"), ip("10.1.2.3"), 32));
        assert!(ip_in_subnet(ip("fd00::1"), ip("fd00::"), 8));
        assert!(!ip_in_subnet(ip("fe80::1"), ip("fd00::"), 8));
        // Mixed families never match, so an IPv4-mapped IPv6 literal can't
        // slip past an IPv4 allowlist.
        assert!(!ip_in_subnet(
            ip("::ffff:192.168.1.1"),
            ip("192.168.0.0"),
            16
        ));
    }

    #[test]
    fn request_parsing_decodes_query_and_lowercases_headers() {
        let head = "GET /connect?host=10.0.0.1&port=5555&token=a%20b&flag HTTP/1.1\r\n\
                    Host: proxy\r\nSec-WebSocket-Key: abc==\r\n\r\n";
        let request = parse_request(head).unwrap();
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/connect");
        assert_eq!(
            request.query.get("host").map(String::as_str),
            Some("10.0.0.1")
        );
        assert_eq!(request.query.get("token").map(String::as_str), Some("a b"));
        assert_eq!(request.query.get("flag").map(String::as_str), Some(""));
        assert_eq!(
            request.headers.get("sec-websocket-key").map(String::as_str),
            Some("abc==")
        );
        assert!(parse_request("garbage").is_none());
        assert!(parse_request("").is_none());
    }

    #[test]
    fn percent_decoding_is_lenient() {
        assert_eq!(percent_decode("%41%62c"), "Abc");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz%4"), "%zz%4");
        assert_eq!(percent_decode("a+b"), "a+b"); // '+' is not a space here
    }

    // ---- end to end, through the real accept loop ----

    async fn spawn_echo_upstream() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let (mut rd, mut wr) = socket.split();
                    let _ = tokio::io::copy(&mut rd, &mut wr).await;
                });
            }
        });
        addr
    }

    /// Boots `serve` on a random port with loopback targets allowed.
    async fn spawn_proxy() -> (SocketAddr, Arc<Config>) {
        let config = Arc::new(Config {
            allowed_subnets: parse_subnets("127.0.0.0/8").unwrap(),
            allowed_origins: None,
            max_connections: 4,
            ..test_config()
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let permits = Arc::new(Semaphore::new(config.max_connections));
        tokio::spawn(serve(listener, config.clone(), permits));
        (addr, config)
    }

    fn ws_request(
        url: &str,
        protocol: Option<&str>,
    ) -> tokio_tungstenite::tungstenite::handshake::client::Request {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut request = url.into_client_request().unwrap();
        if let Some(protocol) = protocol {
            request
                .headers_mut()
                .insert("Sec-WebSocket-Protocol", protocol.parse().unwrap());
        }
        request
    }

    #[tokio::test]
    async fn connect_relays_bytes_and_selects_the_token_subprotocol() {
        let upstream = spawn_echo_upstream().await;
        let (proxy, config) = spawn_proxy().await;
        let url = format!(
            "ws://{proxy}/connect?host=127.0.0.1&port={}",
            upstream.port()
        );
        let tcp = TcpStream::connect(proxy).await.unwrap();
        let (mut ws, response) =
            tokio_tungstenite::client_async(ws_request(&url, Some(&config.token_protocol)), tcp)
                .await
                .unwrap();
        assert_eq!(
            response.headers().get("sec-websocket-protocol").unwrap(),
            config.token_protocol.as_str()
        );

        ws.send(Message::binary(b"hello adbd".to_vec()))
            .await
            .unwrap();
        let echoed = ws.next().await.unwrap().unwrap();
        assert_eq!(echoed.into_data().as_ref(), b"hello adbd");
    }

    #[tokio::test]
    async fn connect_rejects_bad_token_disallowed_target_and_dead_upstream() {
        let (proxy, config) = spawn_proxy().await;
        let status_of = |url: String, protocol: Option<String>| async move {
            let tcp = TcpStream::connect(proxy).await.unwrap();
            match tokio_tungstenite::client_async(ws_request(&url, protocol.as_deref()), tcp).await
            {
                Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                    response.status().as_u16()
                }
                Err(other) => panic!("expected an HTTP rejection, got {other}"),
                Ok(_) => panic!("expected an HTTP rejection, got an upgrade"),
            }
        };
        let target = format!("ws://{proxy}/connect?host=127.0.0.1&port=1");
        assert_eq!(
            status_of(target.clone(), Some("adm-token-00".into())).await,
            401
        );
        assert_eq!(status_of(target.clone(), None).await, 401);
        assert_eq!(
            status_of(
                format!("ws://{proxy}/connect?host=8.8.8.8&port=5555"),
                Some(config.token_protocol.clone())
            )
            .await,
            403
        );
        // Query-param auth still works; nothing listens on port 1 -> 502.
        assert_eq!(status_of(format!("{target}&token=secret"), None).await, 502);
    }

    #[tokio::test]
    async fn probes_are_served_without_auth() {
        let (proxy, _config) = spawn_proxy().await;
        let mut tcp = TcpStream::connect(proxy).await.unwrap();
        tcp.write_all(b"GET /healthz HTTP/1.1\r\nHost: proxy\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        tcp.read_to_end(&mut response).await.unwrap();
        let response = String::from_utf8(response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"), "{response}");
        assert!(response.ends_with("\r\n\r\nok\n"), "{response}");
    }
}

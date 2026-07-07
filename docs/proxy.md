# The proxy

`proxy/` is a stateless WebSocket-to-TCP byte relay written in Rust (Tokio +
tokio-tungstenite, plus `futures-util` for the Stream/Sink glue — three crates,
no more). It does not understand the ADB protocol; it shuffles bytes between a
WebSocket and a TCP socket. TLS is intentionally kept out of the binary — front
it with Caddy/nginx for `wss://`.

## Build and run

```bash
cd proxy
cargo build --release
AUTH_TOKEN=secret ALLOWED_SUBNETS=192.168.0.0/16,10.0.0.0/8 \
  ./target/release/adb-ws-proxy
```

`AUTH_TOKEN` is required — the proxy refuses to start without it.

## Configuration (environment variables)

| Variable | Default | Notes |
|---|---|---|
| `LISTEN_ADDR` | `0.0.0.0:8080` | Address to bind. |
| `AUTH_TOKEN` | _(required)_ | Shared secret for every upgrade. Refuses to start if unset/empty. |
| `ALLOWED_SUBNETS` | `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` | Comma-separated CIDRs. `/connect` targets must be IP literals inside one of these. |
| `MAX_CONNECTIONS` | `20` | Concurrent relay cap. `/readyz` returns 503 at capacity. Server mode + scrcpy open several connections, so size accordingly. |
| `ALLOWED_ORIGIN` | _(unset = any)_ | Comma-separated origins; if set, the `Origin` header must match (WebSocket upgrades and `/bookmarks` alike). |
| `ADB_SERVER_ADDR` | `127.0.0.1:5037` | Target for the `/adb-server` endpoint (a local `adb` server). |
| `BOOKMARKS_PATH` | _(unset = disabled)_ | File where `/bookmarks` persists the UI's saved devices (e.g. `/data/bookmarks.json`). The directory must exist and be writable. |

## Endpoints

### `GET /connect?host=<ip>&port=<port>&token=<token>`
WebSocket upgrade that relays raw bytes to `<ip>:<port>` (a device's `adbd`).
`host` must be an IP literal inside `ALLOWED_SUBNETS`. The token may instead be
sent as `Authorization: Bearer <token>` (browsers can only use the query param).

### `GET /adb-server?token=<token>`
WebSocket upgrade that relays to the configured `ADB_SERVER_ADDR` (a local `adb`
server). No subnet check (fixed target). Used by ADB-server mode; each adb
smart-socket opens its own WebSocket.

### `GET /bookmarks`, `PUT /bookmarks`
Plain HTTP (not WebSocket): the UI's favorite devices as one JSON document,
fetched and replaced wholesale. Enabled only when `BOOKMARKS_PATH` is set
(`404` otherwise). Same auth as the relays — `Authorization: Bearer <token>`
or `?token=` — and the same `ALLOWED_ORIGIN` check; CORS preflights are
answered so the UI can call this cross-origin. The proxy stores the document
as an opaque, size-capped (64 KiB) blob and writes it atomically (temp file +
rename); the schema belongs to the UI. `GET` returns
`{"version":1,"bookmarks":[]}` before the first save.

### `GET /healthz`, `/readyz`, `/startupz`
Unauthenticated, plain-text Kubernetes probes:

- `/healthz` (liveness) → `200 ok`
- `/readyz` (readiness) → `200 ok`, or `503 unavailable` at `MAX_CONNECTIONS`
- `/startupz` (startup) → `200 ok`

## Rejection reasons

Failed `/connect` and `/adb-server` upgrades log the cause to stderr and return a
plain-text HTTP error: `401` (bad/missing token), `403` (origin or subnet not
allowed), `426` (not a WebSocket upgrade), `400` (bad host/port), `502` (couldn't
reach the upstream), `503` (at capacity). The browser can't read a failed
WebSocket handshake's body, so the **proxy log** is where you diagnose connection
problems.

## Security model

- **`/connect`** — token + subnet allowlist + concurrency cap. A token holder can
  reach any device inside the allowlist.
- **`/adb-server`** — token only; the target is fixed. But this exposes the
  **whole adb server**, so a token holder can control every device it manages — a
  broader blast radius than `/connect`. Keep the token secret, serve over
  `wss://`, and treat the adb-server host as a trusted control point. Subnet /
  origin allowlists don't constrain this endpoint's target.
- **`/bookmarks`** — token + origin allowlist. The document holds device names
  and private IPs (no credentials), so its sensitivity is low, but it is only
  as private as the token.
- Always run behind TLS in production (`wss://`); never expose the raw proxy to
  untrusted networks.

## ADB-server mode requirements

For `/adb-server` to work there must be an `adb` server reachable at
`ADB_SERVER_ADDR`. The provided Docker image bundles `adb` and starts a server in
the container (see [deployment.md](./deployment.md)); the container then needs LAN
line-of-sight to the devices (e.g. `--network host`) and, to keep pairing across
restarts, a volume on the adb key directory.

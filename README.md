# Android Device Manager

A static web UI for managing Android devices over ADB, built on the
[Tango](https://github.com/yume-chan/ya-webadb) library. Works over direct USB
(WebUSB) and over the network via a Rust WebSocket-to-TCP proxy. Manages multiple
devices at once.

See [`docs/`](./docs) for full documentation — [architecture](./docs/architecture.md),
[usage](./docs/usage.md), the [proxy](./docs/proxy.md),
[deployment](./docs/deployment.md), and [development](./docs/development.md).

## Status

All planned phases are implemented — **Phase 1** (USB + Shell + Device Info),
**Phase 2** (network transport: Rust proxy + WebSocket), **Phase 3** (File
Browser), **Phase 4** (App Manager), **Phase 5** (Logcat), and **Phase 6**
(Screen mirror / scrcpy):

- USB connection via WebUSB, plus quick reconnect to authorized devices.
- **Network connection** two ways, both producing the same `Adb` and panels as
  USB: direct-to-`adbd` (classic `adb tcpip`) and **ADB-server mode**, where a
  real `adb` server behind the relay does USB, discovery, and **Android 11+
  wireless pairing** (pair from the UI — no terminal, no browser crypto).
- Multi-device support from the start — a tab bar of connected devices, each
  with its own isolated `Adb` instance (any mix of USB and network).
- Device Info panel — manufacturer, model, Android version/SDK, serial, battery,
  storage, resolution.
- Interactive shell terminal (xterm.js).
- File browser (`adb.sync()`) — browse with breadcrumbs, download, upload
  (button or drag-and-drop), and delete.
- App manager (`pm`/`dumpsys`) — list packages (third-party / system / all) with
  search and details; install/uninstall, enable/disable, force-stop, clear data.
- Logcat viewer — streamed `logcat -v threadtime`, color-coded levels, level/tag/
  PID filters, search highlight, pause/clear, auto-scroll, virtualized list.
- Screen mirror (scrcpy) — live video decoded to a `<canvas>` via WebCodecs;
  touch + keyboard input, Back/Home/Recents/Volume/Power, rotate, screenshot, and
  resolution/bitrate controls. Works over USB or the network.

> The scrcpy server binary is downloaded at install time by a `postinstall`
> hook (`fetch-scrcpy-server`) and bundled as a static asset; pushing it to the
> device needs network access during `npm install`. Screen mirror needs WebCodecs
> (Chromium 94+).

## Components

- `web/`   — Static site (Vite + React + TypeScript). The device manager UI.
- `proxy/` — Rust WebSocket-to-TCP relay (Tokio + tokio-tungstenite) for the
  network transport.

## Web UI

Requirements: **Node** `^20.19.0 || >=22.12.0`. USB needs a **Chromium-based
browser** (Chrome, Edge) over **HTTPS or `http://localhost`**; the network path
works in any browser.

```bash
cd web
npm install
npm run dev        # dev server at http://localhost:5173
npm run build      # static output in web/dist/
npm run preview    # serve the production build locally
npm run typecheck  # type-check without emitting
```

On first connection the device shows an RSA "Allow USB debugging?" prompt —
accept it. The RSA key is generated in-browser and stored only in IndexedDB; it
is never sent to any server.

- **USB:** enable USB debugging, run `adb kill-server` first (only one process
  can claim the device), click *Connect via USB*.
- **Network:** enable wireless debugging on the device (`adb tcpip 5555`), run
  the proxy (below), fill in the proxy URL + token once in the **Proxy**
  section, then the device IP and port.

## Proxy

The proxy is a stateless byte relay: it validates an auth token, checks the
target IP against a subnet allowlist, opens a TCP connection to the device's
`adbd`, and shuffles raw bytes between the WebSocket and TCP. It never parses
ADB and is never an open relay.

```bash
cd proxy
cargo build --release
AUTH_TOKEN=secret ALLOWED_SUBNETS=192.168.0.0/16,10.0.0.0/8 \
  ./target/release/adb-ws-proxy
```

Configuration (environment variables):

| Variable | Default | Notes |
|---|---|---|
| `LISTEN_ADDR` | `0.0.0.0:8080` | Address to bind. |
| `AUTH_TOKEN` | _(required)_ | Refuses to start if unset/empty. |
| `ALLOWED_SUBNETS` | `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` | Comma-separated CIDRs. Targets must be IP literals inside one of these. |
| `MAX_CONNECTIONS` | `20` | Concurrent relay cap (`/readyz` reports 503 at capacity). Server mode opens one connection per ADB socket, so size accordingly. |
| `ALLOWED_ORIGIN` | _(unset = any)_ | Comma-separated origins; if set, the WebSocket `Origin` must match. |
| `ADB_SERVER_ADDR` | `127.0.0.1:5037` | Target for the `/adb-server` endpoint (the local `adb` server). |

Endpoints: `GET /connect?host=<ip>&port=<port>&token=<token>` (direct-to-`adbd`
WebSocket relay; token may also be sent as `Authorization: Bearer <token>`),
`GET /adb-server?token=<token>` (relay to the configured `adb` server — see
below), plus unauthenticated plain-text Kubernetes probes `/healthz` (liveness),
`/readyz` (readiness), `/startupz` (startup).

**TLS:** terminate it in front (e.g. Caddy auto-HTTPS) and point the UI at
`wss://`. TLS is intentionally kept out of the binary.

```bash
# Docker
cd proxy
docker build -t adb-ws-proxy .
docker run -p 8080:8080 -e AUTH_TOKEN=secret adb-ws-proxy
```

### ADB server mode (`/adb-server`)

For Android 11+ **Wireless debugging** (pairing) — and to let a real `adb` do USB
and mDNS discovery — run an `adb` server on the proxy host and use the UI's **ADB
server** section instead of the direct device fields:

```bash
adb start-server                       # listens on 127.0.0.1:5037
AUTH_TOKEN=secret ./target/release/adb-ws-proxy   # ADB_SERVER_ADDR defaults to 127.0.0.1:5037
```

In the UI: enter the relay URL + token, **Connect to server**, then *Pair / connect
a device* — enter the device's IP, pairing port, and 6-digit code (from
Developer options → Wireless debugging → *Pair device with pairing code*), then
**Connect** with the device's connect port. The device appears in the list;
**Connect** it to open the panels. The browser does no crypto — the `adb` server
performs SPAKE2/TLS — and the device trusts the `adb` server's key, not the
browser.

> **Security:** unlike `/connect` (one allowlisted device), the `/adb-server`
> endpoint exposes the **whole adb server** — a token holder can control every
> device it manages. The relay only ever targets the fixed `ADB_SERVER_ADDR`;
> keep the token secret, serve over `wss://`, and treat the adb-server host as a
> trusted control point. Subnet/origin allowlists don't apply to this endpoint.

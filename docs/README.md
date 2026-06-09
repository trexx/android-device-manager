# Android Device Manager — Documentation

A static web UI for managing Android devices over ADB, built on the
[Tango](https://github.com/yume-chan/ya-webadb) library (`ya-webadb`). It connects
to devices three ways — all producing the same `Adb` instance, so every feature
works identically:

- **USB** — directly from the browser via WebUSB.
- **Network (daemon)** — to a device's `adbd` over a TCP port (`adb tcpip`),
  bridged by a small Rust WebSocket-to-TCP proxy.
- **ADB server** — to a real `adb` server behind the proxy, which handles USB,
  mDNS discovery, and **Android 11+ wireless pairing** natively (no browser-side
  crypto).

Multiple devices (any mix of transports) can be connected at once, each with its
own isolated state and panels: **Device Info, Shell, Files, Apps, Logcat, and
Screen mirror (scrcpy)**.

## Components

| Path | What it is |
|---|---|
| [`web/`](../web) | Static site — Vite + React + TypeScript. The device manager UI. |
| [`proxy/`](../proxy) | Rust WebSocket-to-TCP relay (Tokio + tokio-tungstenite) for the network and ADB-server transports. |

## Documentation

| Doc | Contents |
|---|---|
| [architecture.md](./architecture.md) | System design, the three transports, components, multi-device model. |
| [usage.md](./usage.md) | Running the UI; connecting over USB / network / ADB-server (+ wireless pairing); each feature panel. |
| [proxy.md](./proxy.md) | The Rust proxy: endpoints, configuration, security model, ADB-server mode. |
| [deployment.md](./deployment.md) | Building and shipping both components (Docker), TLS, a compose example. |
| [development.md](./development.md) | Project layout, build/run, conventions and constraints, gotchas. |

## Quick start (local)

```bash
# Proxy (network + ADB-server transports)
cd proxy && cargo build --release
AUTH_TOKEN=secret ./target/release/adb-ws-proxy        # listens on :8080

# Web UI
cd web && npm install && npm run dev                   # http://localhost:5173
```

Open the dev server in a Chromium-based browser. For USB, run `adb kill-server`
first and click **Connect via USB**. For network/ADB-server, see
[usage.md](./usage.md).

## Requirements at a glance

- **Browser:** Chromium-based (Chrome, Edge). USB (WebUSB) and Screen mirror
  (WebCodecs) are Chromium-only; the network/ADB-server transports work in any
  browser but the page should be served over **HTTPS** (or `http://localhost`).
- **Node** `^20.19 || >=22.12` to build the web UI.
- **Rust** (stable) to build the proxy; **`adb`** on the proxy host for
  ADB-server mode.

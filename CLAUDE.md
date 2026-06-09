# Android Device Manager

A static web UI for managing Android devices over ADB (built on Tango /
`ya-webadb`), with a Rust WebSocket-to-TCP proxy for the network and ADB-server
transports.

- `web/`   — Vite + React + TypeScript UI.
- `proxy/` — Rust (Tokio + tokio-tungstenite) relay.

**Full documentation is in [`docs/`](./docs/)** — architecture, usage, the proxy,
deployment, and `docs/development.md` (project layout, conventions, dependency
inventory, gotchas). Read it before non-trivial work.

## Hard constraints (don't violate without justifying)

- **Minimal dependencies.** Web runtime: React, xterm.js, and the required
  `@yume-chan/*` Tango packages. Proxy: `tokio` + `tokio-tungstenite` +
  `futures-util`. No CSS/UI/state/router libraries. Stop and justify any new dep.
- **Pin `@yume-chan/*` to exact versions** — Tango's API isn't stable; read the
  actual `.d.ts` when unsure rather than relying on memory.
- Every transport must produce an identical `Adb` (panels are transport-agnostic).
- Styling is plain CSS with custom properties in the single `web/src/App.css`.
- The proxy is never an open relay: require the token on every upgrade, check
  `/connect` targets against the subnet allowlist, cap concurrency.
- Add the scrcpy packages to `optimizeDeps.exclude` in `vite.config.ts` (see
  `docs/development.md` for the full Vite/scrcpy gotchas).

## Build

- Web:   `cd web && npm install && npm run dev` · build `npm run build` · `npm run typecheck`
- Proxy: `cd proxy && cargo build --release` · run `AUTH_TOKEN=… ./target/release/adb-ws-proxy`

## Reminders

- WebUSB needs HTTPS (or `http://localhost`) and a Chromium browser; run
  `adb kill-server` before a USB connect.
- The app speaks only classic plain ADB; Android 11+ wireless pairing goes through
  ADB-server mode (a real `adb` does the pairing). See `docs/usage.md`.

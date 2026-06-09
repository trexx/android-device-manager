# Development

## Build & run

```bash
# Web (Node ^20.19 || >=22.12)
cd web
npm install            # postinstall downloads the scrcpy server binary
npm run dev            # dev server, http://localhost:5173
npm run build          # tsc -b && vite build  ->  web/dist/
npm run typecheck      # tsc -b
npm run preview        # serve the production build

# Proxy (Rust, stable)
cd proxy
cargo build --release
cargo clippy --all-targets
cargo fmt
```

## Project structure

```
web/
├── src/
│   ├── lib/            # transports, adb helpers, per-feature logic (no JSX)
│   ├── context/        # DeviceContext (multi-device state)
│   ├── components/     # ConnectionManager, DeviceSwitcher, one per panel
│   ├── App.tsx         # layout + panel tabs
│   ├── App.css         # all styles (one stylesheet, CSS custom properties)
│   └── main.tsx
├── vite.config.ts      # React plugin + scrcpy optimizeDeps handling
├── tsconfig*.json
├── Dockerfile, nginx.conf, .dockerignore
proxy/
├── src/main.rs         # listener, HTTP routing, manual WS handshake, relay
├── Cargo.toml, Cargo.lock
├── Dockerfile, docker-entrypoint.sh
docs/                   # this documentation
```

The transport layer is split so a single `Adb` works everywhere:
`lib/adb-manager.ts` owns the shared RSA credential store and `authenticate()`;
`lib/usb-transport.ts`, `lib/ws-transport.ts`, and `lib/adb-server-transport.ts`
each produce an `Adb`. `lib/ws-stream.ts` is the shared WebSocket⇄byte-duplex
helper (with correct backpressure) used by the two network transports.

## Conventions

- **Minimal dependencies — a hard constraint, not a preference.** Justify any new
  dependency before adding it.
  - Web runtime deps: React, xterm.js (+ `@xterm/addon-fit`), the required
    `@yume-chan/*` Tango packages (adb, USB, stream-extra, credential-web, scrcpy,
    adb-scrcpy, scrcpy-decoder-webcodecs). No CSS framework, component library,
    state library, or router.
  - Proxy crates: `tokio`, `tokio-tungstenite`, `futures-util` only.
- **Pin `@yume-chan/*` packages to exact versions** — Tango's API is not yet
  stable. When updating, read the actual `.d.ts` rather than trusting memory.
- **Styling is plain CSS** with custom properties in the single `App.css`. Dark
  mode follows `prefers-color-scheme`.
- **Every transport produces an identical `Adb`**, so panels stay
  transport-agnostic. Multi-device is built in via `DeviceContext`.
- **The proxy is never an open relay**: validate the token on every upgrade,
  check `/connect` targets against the subnet allowlist, cap concurrency.
- Add the scrcpy packages to `optimizeDeps.exclude` in `vite.config.ts` (see
  gotchas).

## Dependency inventory

**Web runtime:** `react`, `react-dom`, `@xterm/xterm`, `@xterm/addon-fit`,
`@yume-chan/{adb, adb-daemon-webusb, adb-credential-web, stream-extra, scrcpy,
adb-scrcpy, scrcpy-decoder-webcodecs}`.
**Web dev:** `vite`, `@vitejs/plugin-react`, `typescript`, `@types/*`,
`@yume-chan/fetch-scrcpy-server` (downloads the scrcpy server binary at install).
**Proxy:** `tokio`, `tokio-tungstenite`, `futures-util`.

## Gotchas

**Browser / ADB**
- WebUSB is **Chromium-only** and needs **HTTPS or `http://localhost`**.
- Kill any local ADB server (`adb kill-server`) before a USB connect — only one
  process can claim the device.
- `adb tcpip 5555` resets on reboot.
- The browser's Tango transport speaks only the **classic plain** ADB protocol —
  no TLS/SPAKE2/mDNS. Android 11+ Wireless debugging (TLS + pairing) therefore
  can't be used directly; use ADB-server mode (a real `adb` does the pairing) or
  bootstrap a plain `adb tcpip` port. See [usage.md](./usage.md#wireless-pairing).

**Vite + scrcpy**
- The scrcpy decoder family is added to `optimizeDeps.exclude`, and
  `fetch-scrcpy-server` too (its `new URL('./server.bin', import.meta.url)` asset
  reference breaks if pre-bundled).
- Excluding those leaves their CJS transitive deps served raw, breaking the
  default import (`does not provide an export named 'default'`). Fix:
  `optimizeDeps.include: ["yuv-buffer", "yuv-canvas"]` forces esbuild to convert
  them. (`tinyh264` ships an ESM build and is fine.)

**scrcpy runtime**
- Default tunnel is **reverse** (device dials back), which isn't supported over
  the adb-server relay — pass `tunnelForward: true` (works over USB + relay).
- The latest `injectTouch` message requires an `actionButton` field.
- The **WebGL renderer** can't upload hardware-decoded (YUV, external-sampling)
  `VideoFrame`s to a GL texture on **ANGLE's Vulkan backend** — it fails silently
  (a GL error, not an exception; the incomplete texture samples as opaque black,
  indistinguishable from a dark screen) and shows a blank canvas. `ScreenMirror`
  probes `WEBGL_debug_renderer_info` once and uses the **Bitmap renderer** on
  Vulkan backends; WebGL elsewhere.

## Status

All planned phases are implemented and verified on real hardware: USB, network
(`adb tcpip`), and ADB-server mode with wireless pairing; Device Info, Shell,
Files, Apps, Logcat, and Screen mirror. There is no automated test suite yet —
validation is manual against real devices. Add Vitest if the codebase grows.

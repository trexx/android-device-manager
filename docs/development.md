# Development

## Build & run

```bash
# Web (Node ^20.19 || >=22.12)
cd web
npm install            # postinstall downloads the scrcpy server binary
npm run dev            # dev server, http://localhost:5173
npm run build          # tsc -b && vite build  ->  web/dist/
npm run typecheck      # tsc -b
npm test               # Vitest unit tests (parsers, pure helpers, key store)
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
│   ├── components/     # DeviceSwitcher + one per panel; connection/ = landing sections
│   ├── App.tsx         # per-device workspaces (tab strip + persistent panels)
│   ├── App.css         # all styles (one stylesheet, CSS custom properties)
│   └── main.tsx
├── vite.config.ts      # React plugin + scrcpy optimizeDeps handling
├── tsconfig*.json
├── Dockerfile, .dockerignore   # data-only scratch image (see deployment.md)
proxy/
├── src/main.rs         # listener, HTTP routing, manual WS handshake, relay
├── Cargo.toml, Cargo.lock
├── Dockerfile           # multi-stage: build, adb-fetch, distroless runtime
docs/                   # this documentation
```

The transport layer is split so a single `Adb` works everywhere:
`lib/adb-manager.ts` owns the shared RSA credential store (backed by
`lib/key-storage.ts`, our own IndexedDB key store — see the Tango 3 notes) and
`authenticate()`;
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
  The family is currently on Tango's **3.0.0 prerelease stream**
  (`3.0.0-beta.3`), which is what brings scrcpy 4.x support; all `@yume-chan/*`
  packages must move together, and Renovate follows prereleases from a
  prerelease pin (the group stays manual-review).
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
adb-scrcpy, scrcpy-decoder-webcodecs, fetch-scrcpy-server}` (the last one
downloads the scrcpy server binary at install and exports its URL + version).
**Web dev:** `vite`, `@vitejs/plugin-react`, `typescript`, `@types/*`, `vitest`,
`fake-indexeddb` (in-memory IndexedDB for the key-store tests). All dev-only;
tests run in CI.
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
- Tango 3's WebCodecs decoder no longer pulls in CJS packages (`tinyh264`,
  `yuv-canvas`), so the old `optimizeDeps.include: ["yuv-buffer", "yuv-canvas"]`
  workaround is gone. If a `does not provide an export named 'default'` error
  reappears after a dependency bump, an excluded package has grown a CJS
  transitive dep again — force-prebundle that dep with `optimizeDeps.include`.

**Tango 3 API notes** (things that changed from 2.x and are easy to misremember)
- Auth: `adbDaemonAuthenticate({ serial, connection, credentialManager })` with
  `AdbWebCryptoCredentialManager(storage, name)`. The storage is **our own**
  `lib/key-storage.ts` (`IndexedDbKeyStorage`), not Tango's
  `TangoIndexedDbStorage`: in 3.0.0-beta.3 that class's `load()` returns a
  promise from the callback of its transaction helper, which the helper rejects
  (`callback must not be an async function`, plus a stray `AbortError` from the
  orphaned request), so every connect failed at auth. It also caches one
  connection and closes it after each use. Upstream `main` still had both bugs
  on 2026-09-21. Ours writes the identical layout (database `Tango` version 2,
  store `Authentication`, `{ privateKey, name }` records, auto-increment keys)
  and migrates Tango 2's version-1 layout (bare key bytes) in place, so earlier
  authorizations survive and going back to Tango's storage is a one-line change
  in `adb-manager.ts` once a fixed release exists. `key-storage.test.ts` covers
  it against `fake-indexeddb` (fresh origin, round trips, the version-1
  migration, early exit from `load()`); after a Tango bump still verify in a
  browser: connect, accept the prompt, reload, reconnect — no second prompt.
- `adb.sync` is a **pooled service property** (`adb.sync.readdir/read/write/
  isDirectory`), not a factory; there is nothing to dispose per call.
- Subprocess: `adb.subprocess.shellProtocol.spawn(cmd).wait().toString()` →
  `{ stdout, stderr, exitCode }`; the none protocol yields a string. `spawn`
  joins array commands **unescaped** (`sh -c`), so quote user-derived arguments
  with `escapeArg` — the array form is not a quoting mechanism.
- Renderers take an options object: `new WebGLVideoFrameRenderer({ canvas })`.

**Content-Security-Policy**
- Production builds carry a `<meta>` CSP injected by the inline `adm-csp` plugin
  in `vite.config.ts` (build only — the dev server injects styles and HMR code
  inline). `style-src` needs `'unsafe-inline'` because xterm injects `<style>`
  elements; `connect-src` allows any host because the proxy URL is user-entered.
  Extend it if a new external resource is ever introduced, and re-check the
  Screen panel under `npm run preview` (the console reports violations).

**scrcpy runtime**
- Default tunnel is **reverse** (device dials back), which isn't supported over
  the adb-server relay — pass `tunnelForward: true` (works over USB + relay).
- The latest `injectTouch` message requires an `actionButton` field.
- `ScrcpyOptions4_1.Init` makes `videoCodec` a required field; pass `"h264"`
  unless the user picked another encoder.
- The **WebGL renderer** can't upload hardware-decoded (YUV, external-sampling)
  `VideoFrame`s to a GL texture on **ANGLE's Vulkan backend** — it fails silently
  (a GL error, not an exception; the incomplete texture samples as opaque black,
  indistinguishable from a dark screen) and shows a blank canvas. `ScreenMirror`
  probes `WEBGL_debug_renderer_info` once and uses the **Bitmap renderer** on
  Vulkan backends; WebGL elsewhere.

## Status

All planned phases are implemented and verified on real hardware: USB, network
(`adb tcpip`), and ADB-server mode with wireless pairing; Device Info, Shell,
Files, Apps, Logcat, and Screen mirror. Pure parsing and helper logic (the
logcat/`dumpsys`/`df` parsers, package-id validation, path and URL helpers, the
proxy-config migration) and the IndexedDB key store (against `fake-indexeddb`)
have Vitest unit tests (`npm test`, `src/**/*.test.ts`, run in CI); everything
that touches a device is validated by hand against real hardware.

# Using the app

## Run it

```bash
cd web
npm install        # also downloads the scrcpy server binary (postinstall)
npm run dev        # http://localhost:5173
# or: npm run build  -> static files in web/dist/
```

Open it in a **Chromium-based browser** (Chrome, Edge). USB and Screen mirror are
Chromium-only and require **HTTPS or `http://localhost`**.

On the device, enable **USB debugging** (Developer options). On first connection
the device shows an RSA "Allow USB debugging?" prompt — accept it (tick "Always
allow"). The RSA key is generated in-browser and stored only in IndexedDB; it is
never sent to a server.

## Connecting

The landing screen has three sections.

### USB

Run `adb kill-server` first (only one process can claim the device's USB
interface). Click **Connect via USB** and pick the device. Previously authorized
devices show as quick-reconnect chips.

### Network (direct / `adb tcpip`)

Connects straight to the device's `adbd` through the proxy. The device must
expose a **plain** ADB port:

```bash
adb tcpip 5555            # over USB once, or over an existing adb session
```

Then run the [proxy](./proxy.md), fill in the shared **Proxy** section once
(**Proxy URL** — `ws://localhost:8080`, or `wss://…` in production — and
**Auth token**, which must match the proxy's `AUTH_TOKEN`), and enter the
**Device IP** + **Port** (5555) in the **Network** section.

`adb tcpip` resets on reboot.

### ADB server

Connects through a real `adb` server running on the proxy host — this is the path
for **USB-via-server, discovery, and Android 11+ wireless pairing**.

```bash
adb start-server          # on the proxy host (or use the proxy Docker image)
AUTH_TOKEN=secret ./adb-ws-proxy
```

With the **Proxy** section filled in, click **Connect to server** in the
**ADB server** section, then use *Pair / connect a device* (below). Connected
devices appear in a live list; click **Connect** on one to open its panels.

## Wireless pairing

Android 11+ **Wireless debugging** uses mDNS + a SPAKE2 pairing code and a
TLS-wrapped connection. The browser's daemon transport can't speak that, so
pairing is done by the real `adb` server in **ADB server** mode:

1. On the device: Developer options → **Wireless debugging** → on → **Pair device
   with pairing code**. Note the IP + **pairing port** and the 6-digit code.
2. In the UI (ADB server section) → *Pair / connect a device* → **Pair**: enter
   the IP, pairing port, and code.
3. On the device's Wireless debugging main screen, note the **connect port** (it
   differs from the pairing port, and changes per session). In the UI →
   **Connect**: enter the IP and connect port.
4. The device appears in the list → **Connect** it.

The browser never participates in pairing — the adb server holds the trust.

### Without ADB-server mode (direct network)

If you'd rather use the direct **Network** transport, you still need a *plain*
port: pair + connect once with desktop `adb` (no USB needed), then `adb tcpip
5555`, and point the **Network** section at `<device-ip>:5555`. The first browser
connection then shows the on-device RSA prompt.

## Feature panels

Each connected device has its own tab; switching tabs switches the active `Adb`.
Panels are isolated per device.

### Device Info
Manufacturer, model, Android version + SDK, serial, battery (level + charging
state), `/data` storage usage, and display resolution. Reads `getprop` plus
`dumpsys battery`, `df -h /data`, and `wm size`. **Refresh** re-reads.

### Shell
A full interactive shell (xterm.js) wired to a device PTY (`adb.subprocess`).
Colors, cursor movement, and on-device tab completion work. Each device gets its
own terminal; opening the panel starts a fresh session.

### Files
Browse the filesystem via `adb.sync()`. Click folders to navigate, use the
breadcrumb / **Up** to go back. Per file: **download** (↓, saved by the browser)
and **delete** (×, with confirm). **Upload** with the button or by dragging files
onto the list. Starts at `/sdcard`; breadcrumb to `/` for elsewhere
(permission-denied directories show an inline error).

### Apps
List packages (**Third-party / System / All**) with live search. Expand a package
for details (`dumpsys package`: version, path, install/update times) and actions:
**Enable/Disable** (`pm enable` / `pm disable-user --user 0`, no confirm — it's
reversible), **Force stop** (`am force-stop`), **Clear data** (`pm clear`,
confirm), **Uninstall** (`pm uninstall`, confirm). **Install APK** pushes the file
to a temp path and runs `pm install -r`.

### Logcat
Streams `logcat -v threadtime`, color-coded by level, into a virtualized list
(capped at 5000 lines). Filter by **min level / tag / PID**, **search** to
highlight, **Pause** / **Clear**. Auto-scroll follows the tail and pauses while
you scroll up (so incoming lines never shift what you're reading); **↓ Jump to
bottom** resumes. The level dropdown is a client-side display filter — it changes
nothing on the device.

### Screen (scrcpy)
Live screen mirroring via `@yume-chan/adb-scrcpy` + the WebCodecs decoder. Pick
**Resolution** and **Bitrate**, then **Start**. Controls: **touch** (click/drag
on the canvas) and **keyboard** input, **Back / Home / Recents / Vol± / Power**,
**Rotate**, and **Screenshot** (saves a PNG). Works over USB or the network /
ADB-server transports.

- Needs **WebCodecs** (Chromium 94+).
- The renderer prefers WebGL but auto-falls back to the Bitmap renderer on ANGLE's
  Vulkan backend, which can't import hardware YUV frames into a GL texture (it
  would render a silent black canvas). See
  [development.md](./development.md#gotchas).
- Over the network/ADB-server path, scrcpy uses a forward tunnel (it opens a few
  sockets through the relay); raise `MAX_CONNECTIONS` if you run several at once.

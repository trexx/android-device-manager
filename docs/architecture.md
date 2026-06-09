# Architecture

## Overview

```
                       ┌───────────────────────────────────────────┐
                       │        Static Web UI (Vite + React)       │
                       │   Device Info · Shell · Files · Apps ·    │
                       │        Logcat · Screen (scrcpy)           │
                       │                  Adb                       │
                       │            (@yume-chan/adb)                │
                       ├───────────────────────────────────────────┤
                       │            Transport layer                │
                       │  ┌────────┐  ┌──────────┐  ┌────────────┐ │
                       │  │ WebUSB │  │ WS daemon│  │ WS adb-srv │ │
                       │  └───┬────┘  └────┬─────┘  └─────┬──────┘ │
                       └──────┼────────────┼──────────────┼────────┘
                          USB │       wss://│         wss://│
                              │      ┌──────┴──────────────┴──────┐
                              │      │      Rust WS→TCP proxy      │
                              │      │  /connect      /adb-server  │
                              │      └──────┬──────────────┬───────┘
                              │       TCP   │          TCP │ :5037
                              │      :5555  │              │
                              │             │        ┌─────┴──────┐
                              │             │        │ adb server │
                              │             │        └─────┬──────┘
                          ┌───┴─────────────┴──────────────┴───┐
                          │           Android device(s)         │
                          │               (adbd)                │
                          └─────────────────────────────────────┘
```

The browser always ends up with a Tango **`Adb`** instance. Every feature panel
is written against `Adb` only, so it is transport-agnostic — USB, network, and
ADB-server connections are interchangeable.

## The three transports

| Transport | Browser side | Path to device | Auth | Notes |
|---|---|---|---|---|
| **USB** | `AdbDaemonWebUsbDevice` → `AdbDaemonTransport` | WebUSB → cable → `adbd` | Browser RSA key + on-device prompt | Chromium only; HTTPS/localhost; `adb kill-server` first |
| **Network (daemon)** | `AdbDaemonTransport` over a WebSocket | WS → proxy `/connect` → TCP → `adbd` | Browser RSA key + on-device prompt | Device must expose a plain port (`adb tcpip 5555`) |
| **ADB server** | `AdbServerClient` over a WebSocket | WS → proxy `/adb-server` → TCP → local `adb` server → device | The **adb server's** key | Real `adb` does USB, mDNS, and Android 11+ wireless pairing |

### USB (daemon)

`AdbDaemonWebUsbDeviceManager.BROWSER.requestDevice()` prompts the user to pick a
device; `device.connect()` yields a raw ADB packet stream that
`AdbDaemonTransport.authenticate({ serial, connection, credentialStore })` turns
into an `Adb`. The RSA credential (in IndexedDB) is shared with the network
transport.

### Network / daemon (`/connect`)

Browsers can't open raw TCP, so a WebSocket carries the raw ADB byte stream to
the proxy, which relays it to the device's `adbd` over TCP. On the browser side
(`web/src/lib/ws-transport.ts`) the WebSocket is wrapped as an
`AdbDaemonConnection`: incoming bytes are deserialized with
`StructDeserializeStream(AdbPacket)` and outgoing packets serialized with
`AdbPacketSerializeStream`, then fed to the same `authenticate()` as USB. This
only speaks the **classic plain** ADB protocol, so the device must expose a plain
port via `adb tcpip 5555` (Android 11+ Wireless debugging is TLS — see below).

### ADB server (`/adb-server`)

A real `adb` server runs on the proxy host and does all the native work — USB,
mDNS discovery, **Android 11+ wireless pairing** (SPAKE2 + TLS), and TLS connect.
The browser drives it with Tango's `AdbServerClient`
(`web/src/lib/adb-server-transport.ts`), whose `ServerConnector.connect()` opens
a WebSocket per smart-socket to the proxy `/adb-server` endpoint, which relays to
the adb server's port (`127.0.0.1:5037`). `client.createAdb(device)` yields a
standard `Adb`. This is how the UI offers **wireless pairing with no browser-side
crypto**: the real `adb` performs the pairing.

> **Why three transports?** Tango's browser (daemon) transport speaks only the
> classic plain ADB protocol — it has no TLS/SPAKE2/mDNS. Android 11+ Wireless
> debugging is TLS-wrapped and pairing-gated, so it can't be used directly from
> the browser. The ADB-server transport delegates that to a real `adb`. See
> [usage.md](./usage.md#wireless-pairing) for the practical recipes.

## The proxy

`proxy/` is a stateless WebSocket-to-TCP byte relay (Rust, Tokio +
tokio-tungstenite). It does **not** parse ADB — it shuffles bytes between a
WebSocket and a TCP socket. It exposes:

- `GET /connect?host=<ip>&port=<port>&token=<token>` — relay to a device's
  `adbd`, validated against a subnet allowlist.
- `GET /adb-server?token=<token>` — relay to the configured adb server
  (`ADB_SERVER_ADDR`, default `127.0.0.1:5037`).
- `GET /healthz`, `/readyz`, `/startupz` — unauthenticated Kubernetes probes.

It is never an open relay: every upgrade needs a valid token; `/connect` targets
must be inside the allowlist; concurrency is capped. See [proxy.md](./proxy.md).

## Multi-device

A React context + reducer (`web/src/context/DeviceContext.tsx`) holds the list of
connected devices and the active one. Each device is:

```ts
interface ConnectedDevice {
  id: string;        // serial or host:port
  label: string;
  adb: Adb;          // independent Adb instance
  transport: AdbTransport;
  mode: "usb" | "network";
}
```

The tab bar switches the active device; panels are keyed by device id so each
device keeps its own shell, file browser, logcat, scrcpy session, etc. A device
is removed automatically when its `adb.disconnected` resolves (unplug / drop).

## Components map

```
web/src/
├── lib/
│   ├── adb-manager.ts          # shared RSA credential store + authenticate()
│   ├── usb-transport.ts        # WebUSB connect
│   ├── ws-stream.ts            # WebSocket ⇄ byte-duplex helper (backpressure)
│   ├── ws-transport.ts         # network/daemon transport (/connect)
│   ├── adb-server-transport.ts # AdbServerClient connector (/adb-server)
│   ├── device-info.ts          # getprop / dumpsys / df parsing + runCommand
│   ├── file-browser.ts         # adb.sync() list/pull/push + rm
│   ├── app-manager.ts          # pm / dumpsys / am
│   ├── logcat.ts               # spawn logcat + threadtime parse
│   └── scrcpy-client.ts        # push server, start session, video + control
├── context/DeviceContext.tsx
├── components/                 # ConnectionManager, DeviceSwitcher, + one per panel
└── App.tsx                     # layout + panel tabs

proxy/src/main.rs               # listener, HTTP routing, WS handshake, relay
```

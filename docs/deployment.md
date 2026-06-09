# Deployment

Two artifacts: the static web UI (any HTTPS static host) and the Rust proxy. Both
have Dockerfiles. **TLS is not built into either** — terminate it with a reverse
proxy (Caddy gives automatic HTTPS with near-zero config).

## Web UI

### Static build

```bash
cd web
npm ci          # runs postinstall: downloads the scrcpy server binary
npm run build   # -> web/dist/
```

Serve `web/dist/` from any static host. WebUSB and `wss://` require the page to be
served over **HTTPS** (or `http://localhost` for local dev).

### Docker

[`web/Dockerfile`](../web/Dockerfile) builds the static site and serves it with
nginx:

```bash
cd web
docker build -t adm-web .
docker run -p 8080:80 adm-web        # then front with TLS
```

The build needs network access (the `postinstall` hook fetches the scrcpy server
binary from GitHub).

## Proxy

### Docker

[`proxy/Dockerfile`](../proxy/Dockerfile) builds the binary and bundles `adb` (so
ADB-server mode works out of the box); its entrypoint starts a local adb server
then runs the proxy.

```bash
cd proxy
docker build -t adb-ws-proxy .
docker run -p 8080:8080 -e AUTH_TOKEN=secret adb-ws-proxy
```

For **ADB-server mode**, the container's adb server must reach devices on your
LAN, and you'll want pairing keys to persist:

```bash
docker run --network host \
  -e AUTH_TOKEN=secret \
  -v adb-keys:/root/.android \
  --init \
  adb-ws-proxy
```

- `--network host` — so the in-container adb can reach LAN devices (and mDNS).
- `-v adb-keys:/root/.android` — persist the adb server's key across restarts (so
  paired devices stay paired).
- `--init` — reap the adb daemon if it exits.
- `START_ADB_SERVER=0` — set if you point `ADB_SERVER_ADDR` at an external adb
  server instead of running one in the container.

## TLS

Put a TLS terminator in front of both and point the UI at `wss://`:

```bash
# Caddy — automatic HTTPS
caddy reverse-proxy --from app.example.com   --to localhost:8080   # web UI
caddy reverse-proxy --from proxy.example.com --to localhost:8081   # proxy
```

In the UI, use the proxy as `wss://proxy.example.com`. Set the proxy's
`ALLOWED_ORIGIN` to the UI's origin (`https://app.example.com`).

## docker-compose example

```yaml
services:
  proxy:
    build: ./proxy
    network_mode: host          # for ADB-server mode (LAN/mDNS reach)
    init: true
    environment:
      AUTH_TOKEN: "change-me"
      ALLOWED_SUBNETS: "192.168.0.0/16"
      # ADB_SERVER_ADDR: "127.0.0.1:5037"   # default; in-container adb server
    volumes:
      - adb-keys:/root/.android

  web:
    build: ./web
    ports:
      - "8080:80"

volumes:
  adb-keys:
```

Then front `web` and `proxy` with TLS. (With `network_mode: host`, the proxy
listens on `:8080` on the host; expose/route it as needed.)

## Kubernetes

Wire the unauthenticated probes into the pod spec:

```yaml
livenessProbe:  { httpGet: { path: /healthz,  port: 8080 } }
readinessProbe: { httpGet: { path: /readyz,   port: 8080 } }
startupProbe:   { httpGet: { path: /startupz, port: 8080 } }
```

`/readyz` returns 503 at `MAX_CONNECTIONS`, so the readiness probe sheds load when
the proxy is full. Provide `AUTH_TOKEN` from a Secret. ADB-server mode in
Kubernetes is awkward (the in-pod adb server needs LAN/mDNS reach); the direct
`/connect` relay is the more natural fit there.

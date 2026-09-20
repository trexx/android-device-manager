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

[`web/Dockerfile`](../web/Dockerfile) builds the static site into a **data-only
image**: a `scratch` stage holding `dist/` at `/` and nothing else — no web
server, no shell, no exposed port. Serve it from a container that can read that
filesystem:

- **Kubernetes `image` volume** — how the published
  `ghcr.io/trexx/android-device-manager-web` image is meant to be used. Needs the
  `image` volume source (beta since Kubernetes 1.33):

  ```yaml
  spec:
    containers:
      - name: web
        image: busybox:stable
        command: ["httpd", "-f", "-p", "8080", "-h", "/www"]
        ports: [{ containerPort: 8080 }]
        volumeMounts:
          - { name: site, mountPath: /www, readOnly: true }
    volumes:
      - name: site
        image:
          reference: ghcr.io/trexx/android-device-manager-web:2.3.0
          pullPolicy: IfNotPresent
  ```

- **Your own image:** `COPY --from=ghcr.io/trexx/android-device-manager-web:2.3.0 / /www`
  in a Dockerfile based on any static server.
- **Extract to the host:** `docker create --name adm-web ghcr.io/trexx/android-device-manager-web:2.3.0`
  then `docker cp adm-web:/. ./site`, and serve `./site` with Caddy's
  `file_server` or similar.

Build locally with `cd web && docker build -t adm-web .` — the build needs
network access (the `postinstall` hook fetches the scrcpy server binary from
GitHub). Whatever serves the files must be fronted with TLS.

## Proxy

### Docker

[`proxy/Dockerfile`](../proxy/Dockerfile) builds the binary and bundles `adb`
(so ADB-server mode works out of the box) by fetching a checksum-pinned
official Google platform-tools release — not the distro package, which is too
old to support Android 11+ wireless pairing. The runtime image is
`distroless/cc:nonroot` (glibc + libgcc only, no shell or package manager,
running as uid 65532 with `HOME=/home/nonroot`); the proxy binary itself starts
the local adb server at boot (`START_ADB_SERVER`, below) before serving, and
stops it again on SIGTERM.

```bash
cd proxy
docker build -t adb-ws-proxy .
docker run -p 8080:8080 -e AUTH_TOKEN=secret adb-ws-proxy
```

To bump the pinned `adb` version, pass a new checksum at build time (see the
comment above the `ARG PLATFORM_TOOLS_SHA256` line in the Dockerfile for how
to compute it): `docker build --build-arg PLATFORM_TOOLS_SHA256=<hash> -t
adb-ws-proxy .`

For **ADB-server mode**, the container's adb server must reach devices on your
LAN, and you'll want pairing keys to persist:

```bash
docker run --network host \
  -e AUTH_TOKEN=secret \
  -v adb-keys:/home/nonroot/.android \
  --init \
  adb-ws-proxy
```

- `--network host` — so the in-container adb can reach LAN devices (and mDNS).
- `-v adb-keys:/home/nonroot/.android` — persist the adb server's key across
  restarts (so paired devices stay paired). The container runs as uid 65532, so
  a bind-mounted directory must be writable by that uid; a named volume is
  initialised with the right owner.
- `--init` — reap the adb daemon if it dies on its own. The proxy handles
  SIGTERM itself (it stops the adb server it started and exits promptly), so
  `docker stop` is quick either way.
- `START_ADB_SERVER=0` — set if you point `ADB_SERVER_ADDR` at an external adb
  server instead of running one in the container.
- USB devices passed into the container (`--device`) would additionally need to
  be readable by uid 65532 (udev rule or `--group-add`); the wireless and mDNS
  paths are unaffected.

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
      - adb-keys:/home/nonroot/.android

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

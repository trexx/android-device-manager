# --- Build stage ---------------------------------------------------------
FROM rust:1-slim AS builder
WORKDIR /app

# Cache dependencies separately from source for faster rebuilds.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && \
    cargo build --release && \
    rm -rf src

COPY src ./src
# Touch so cargo rebuilds the real binary (the cached dummy is newer otherwise).
RUN touch src/main.rs && cargo build --release

# --- Runtime stage -------------------------------------------------------
FROM debian:bookworm-slim

# `adb` is needed for ADB-server mode (the /adb-server endpoint relays to a local
# adb server that does USB, mDNS discovery, and Android 11+ wireless pairing).
# The direct /connect relay doesn't need it. TLS is intentionally out of the
# binary — front it with Caddy/nginx for wss://.
RUN apt-get update \
    && apt-get install -y --no-install-recommends android-tools-adb \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/adb-ws-proxy /usr/local/bin/adb-ws-proxy
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Defaults; AUTH_TOKEN is required at runtime. Override ALLOWED_SUBNETS,
# MAX_CONNECTIONS, ADB_SERVER_ADDR as needed. adb stores its keys under $HOME.
ENV LISTEN_ADDR=0.0.0.0:8080 \
    HOME=/root
EXPOSE 8080

# The entrypoint starts a local adb server (for /adb-server mode) then runs the
# proxy. For ADB-server mode the container needs LAN line-of-sight to devices
# (e.g. `--network host`) and a volume on /root/.android to persist pairing keys.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

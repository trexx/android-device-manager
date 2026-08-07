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

# --- adb stage -------------------------------------------------------------
# Fetches a checksum-pinned `adb` binary from Google's official platform-tools
# release, isolated in its own stage so the curl/unzip/apt tooling used to get
# it never ends up in the runtime image — only the extracted binary is copied
# out below.
FROM debian:bookworm-slim AS adb-fetch

# Pinned platform-tools release (adb 37.0.1 as of 2026-08 — informational;
# the SHA256 below is what's actually verified). Google doesn't publish
# stable per-version download URLs (only "-latest" is documented/supported),
# so we pin by checksum instead: the build fails if Google ever serves
# different bytes than what was last vetted, forcing a deliberate bump.
# To bump: download https://dl.google.com/android/repository/platform-tools-latest-linux.zip,
# run `sha256sum` on it, update both ARGs below, and confirm the new
# `adb --version`. No Renovate tracking — see .github/renovate.json's scrcpy
# entry for why (no datasource exists for platform-tools releases).
ARG PLATFORM_TOOLS_VERSION=37.0.1
ARG PLATFORM_TOOLS_SHA256=d230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1

# We fetch Google's official platform-tools zip instead of Debian's
# `android-tools-adb` package: distro packages lag Google's releases by years,
# and bookworm's adb predates `host:pair` (added in platform-tools 30.0.0
# alongside Android 11 wireless debugging) — pairing fails with "unknown host
# service" against a pre-30.0.0 adb (reproduced with Debian's package, v29.0.6).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && curl -fsSL -o /tmp/platform-tools.zip \
       https://dl.google.com/android/repository/platform-tools-latest-linux.zip \
    && echo "${PLATFORM_TOOLS_SHA256}  /tmp/platform-tools.zip" | sha256sum -c - \
    && unzip -p /tmp/platform-tools.zip platform-tools/adb > /usr/local/bin/adb \
    && chmod +x /usr/local/bin/adb \
    && /usr/local/bin/adb --version

# --- Runtime stage -------------------------------------------------------
# distroless/cc ships glibc + libgcc — what a prebuilt `adb` and our
# mostly-static Rust binary both need — and nothing else: no shell, no apt, no
# coreutils. That's why there's no docker-entrypoint.sh: the "start adb
# server" step now lives in main.rs (see `maybe_start_adb_server`), so the
# container never needs a shell to boot.
FROM gcr.io/distroless/cc-debian12

# `adb` is needed for ADB-server mode (the /adb-server endpoint relays to a local
# adb server that does USB, mDNS discovery, and Android 11+ wireless pairing).
# The direct /connect relay doesn't need it. TLS is intentionally out of the
# binary — front it with Caddy/nginx for wss://.
COPY --from=adb-fetch /usr/local/bin/adb /usr/local/bin/adb
COPY --from=builder /app/target/release/adb-ws-proxy /usr/local/bin/adb-ws-proxy

# Defaults; AUTH_TOKEN is required at runtime. Override ALLOWED_SUBNETS,
# MAX_CONNECTIONS, ADB_SERVER_ADDR as needed. adb stores its keys under $HOME.
# Set BOOKMARKS_PATH (e.g. /data/bookmarks.json, on a volume) to enable the
# /bookmarks favorites store. Set START_ADB_SERVER=0 to skip starting the
# in-container adb server (e.g. when ADB_SERVER_ADDR points at an external one).
ENV LISTEN_ADDR=0.0.0.0:8080 \
    HOME=/root \
    PATH=/usr/local/bin:/usr/bin:/bin
EXPOSE 8080

# adb-ws-proxy starts a local adb server (for /adb-server mode) itself before
# serving. For ADB-server mode the container needs LAN line-of-sight to
# devices (e.g. `--network host`) and a volume on /root/.android to persist
# pairing keys.
ENTRYPOINT ["/usr/local/bin/adb-ws-proxy"]

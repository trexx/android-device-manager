#!/bin/sh
set -e

# ADB-server mode (the `/adb-server` endpoint) relays to a local `adb` server.
# Start one inside the container unless the operator points ADB_SERVER_ADDR at an
# external server or disables it with START_ADB_SERVER=0. Best-effort: the direct
# `/connect` relay works without it.
if [ "${START_ADB_SERVER:-1}" = "1" ]; then
  adb start-server >/dev/null 2>&1 \
    || echo "warning: could not start adb server; /adb-server mode unavailable" >&2
fi

exec adb-ws-proxy "$@"

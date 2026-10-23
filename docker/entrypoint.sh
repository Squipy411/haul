#!/bin/sh
# Runs Haul as PUID:PGID when both are set (Unraid, Synology and linuxserver.io convention),
# otherwise as the container's default user.
set -e
DATA="${DATA_DIR:-/data}"
mkdir -p "$DATA"
if [ -n "$PUID" ] && [ -n "$PGID" ] && [ "$(id -u)" = "0" ]; then
  chown -R "$PUID:$PGID" "$DATA"
  exec su-exec "$PUID:$PGID" node /app/dist/server.mjs
fi
exec node /app/dist/server.mjs

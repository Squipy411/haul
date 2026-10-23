#!/bin/sh
# Installs or updates Haul on ZimaOS. Run as root:  curl -fsSL https://raw.githubusercontent.com/Squipy411/haul/main/deploy/zimaos/install.sh | sh
set -eu
APP_DIR=/var/lib/casaos/apps/haul
SRC_DIR=/DATA/AppData/haul/src
mkdir -p /DATA/AppData/haul/data "$APP_DIR"
if [ -d "$SRC_DIR/.git" ]; then
  git -C "$SRC_DIR" pull --ff-only
else
  git clone --depth 1 https://github.com/Squipy411/haul.git "$SRC_DIR"
fi
# Build locally so the install does not depend on a registry login.
docker build -t ghcr.io/squipy411/haul:latest "$SRC_DIR"
cp "$SRC_DIR/deploy/zimaos/docker-compose.yml" "$APP_DIR/docker-compose.yml"
docker compose -f "$APP_DIR/docker-compose.yml" up -d --pull never
echo "Waiting for Haul to start…"
for i in $(seq 1 30); do
  if wget -qO- http://127.0.0.1:60700/health >/dev/null 2>&1; then
    echo "Haul is running: http://$(hostname -I 2>/dev/null | awk '{print $1}'):60700"
    exit 0
  fi
  sleep 2
done
echo "Haul did not answer yet. Check: docker logs haul" >&2
exit 1

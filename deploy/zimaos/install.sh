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
for i in $(seq 1 45); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' haul 2>/dev/null)" = "healthy" ]; then
    # Let ZimaOS pick up the app so its tile appears on the dashboard.
    systemctl restart zimaos-app-management.service 2>/dev/null || systemctl restart casaos-app-management.service 2>/dev/null || true
    echo "Haul is running on port 60700."
    exit 0
  fi
  sleep 2
done
echo "Haul did not answer yet. Check: docker logs haul" >&2
exit 1

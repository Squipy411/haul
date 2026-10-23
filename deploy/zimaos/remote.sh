#!/bin/sh
# Gives Haul a free https://haul.<your-tailnet>.ts.net address that works from anywhere, through
# Tailscale Funnel: no router changes, and the certificate is handled for you. Run as root on ZimaOS
# after installing Haul, with an auth key from https://login.tailscale.com/admin/settings/keys :
#
#   sh /DATA/AppData/haul/src/deploy/zimaos/remote.sh tskey-auth-…
#
# Run it again (no key needed) to print the address. To stop: docker rm -f haul-tailscale
set -eu
KEY="${1:-${TS_AUTHKEY:-}}"
DIR=/DATA/AppData/haul/remote

if ! docker network inspect haul_default >/dev/null 2>&1; then
  echo "Haul isn't running yet. Install it first: curl -fsSL https://raw.githubusercontent.com/Squipy411/haul/main/deploy/zimaos/install.sh | sh" >&2
  exit 1
fi
if [ -z "$KEY" ] && [ ! -s "$DIR/state/tailscaled.state" ]; then
  echo "Usage: sh remote.sh <tailscale auth key>" >&2
  echo "Make a free Tailscale account, then create an auth key at https://login.tailscale.com/admin/settings/keys" >&2
  exit 1
fi

mkdir -p "$DIR/state"
# Funnel serves HTTPS on 443 to the internet and hands requests to Haul on the Docker network.
cat > "$DIR/serve.json" <<'EOF'
{
  "TCP": { "443": { "HTTPS": true } },
  "Web": { "${TS_CERT_DOMAIN}:443": { "Handlers": { "/": { "Proxy": "http://haul:60700" } } } },
  "AllowFunnel": { "${TS_CERT_DOMAIN}:443": true }
}
EOF
cat > "$DIR/docker-compose.yml" <<EOF
name: haul-remote
services:
  tailscale:
    image: tailscale/tailscale:stable
    container_name: haul-tailscale
    hostname: haul
    restart: unless-stopped
    environment:
      - TS_AUTHKEY=${KEY}
      - TS_STATE_DIR=/var/lib/tailscale
      - TS_SERVE_CONFIG=/config/serve.json
      - TS_USERSPACE=true
    volumes:
      - ${DIR}/state:/var/lib/tailscale
      - ${DIR}/serve.json:/config/serve.json:ro
    networks: [haul]
networks:
  haul:
    name: haul_default
    external: true
EOF
docker compose -f "$DIR/docker-compose.yml" up -d

echo "Connecting to Tailscale…"
NAME=""
for i in $(seq 1 45); do
  NAME=$(docker exec haul-tailscale tailscale status --json 2>/dev/null | tr -d '\n ' | sed -n 's/.*"Self":{[^}]*"DNSName":"\([^"]*\)".*/\1/p')
  [ -n "$NAME" ] && break
  sleep 2
done
if [ -z "$NAME" ]; then
  echo "Tailscale didn't connect. Check the auth key, then: docker logs haul-tailscale" >&2
  exit 1
fi
# Signed in for good: the key isn't needed again, so it doesn't stay on disk.
sed -i '/TS_AUTHKEY=/d' "$DIR/docker-compose.yml"

URL="https://${NAME%.}"
echo
echo "Haul's address from anywhere: $URL"
echo
echo "If it doesn't open, Funnel may need switching on for your account once:"
echo "  1. https://login.tailscale.com/admin/dns : turn on HTTPS Certificates."
echo "  2. Then check: docker exec haul-tailscale tailscale funnel status"
echo "     It should list $URL. If it says Funnel isn't enabled, follow the link it prints."
echo "The first visit can take a minute while the certificate is issued."
echo
echo "Before using it away from home, open Settings → Sign-in and security and turn on two-step sign-in."

FROM node:22-alpine AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm test && npm run build

FROM node:22-alpine
LABEL org.opencontainers.image.title="Haul" \
      org.opencontainers.image.description="Self-hosted streaming site for your TorBox account and your own media: watch in the browser, download to your library, share over the internet" \
      org.opencontainers.image.source="https://github.com/Squipy411/haul" \
      org.opencontainers.image.licenses="MIT"
# ffmpeg lets the player convert files a browser can't play (x265, DTS, TrueHD, MKV on Safari).
RUN apk add --no-cache su-exec ffmpeg
ENV NODE_ENV=production \
    PORT=60700 \
    DATA_DIR=/data \
    MEDIA_ROOT=/media
WORKDIR /app
COPY --from=build /app/dist ./dist
# Cloudflare's tunnel program, for Settings → Share over the internet (a free public HTTPS link).
COPY --from=cloudflare/cloudflared:2026.10.0 /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY docker/entrypoint.sh /usr/local/bin/haul-entrypoint
EXPOSE 60700
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
ENTRYPOINT ["haul-entrypoint"]

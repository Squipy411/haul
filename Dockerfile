FROM node:22-alpine AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-alpine
LABEL org.opencontainers.image.title="Haul" \
      org.opencontainers.image.description="All-in-one TorBox media downloader with a built-in Nuvio/Stremio library addon" \
      org.opencontainers.image.source="https://github.com/Squipy411/haul" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    PORT=60700 \
    DATA_DIR=/data \
    MEDIA_ROOT=/media
WORKDIR /app
COPY --from=build /app/dist ./dist
EXPOSE 60700
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "dist/server.mjs"]

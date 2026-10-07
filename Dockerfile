# syntax=docker/dockerfile:1.7
# AIO Arr - one login, one page for your whole *arr stack.
#
# Build stages run on the build machine's own architecture (the output is plain JS),
# so multi-arch images build fast; only the small runtime stage is per-platform.

ARG NODE_IMAGE=node:22-alpine

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
COPY server/src/types.ts /src/server/src/types.ts
RUN npm run build

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS server
WORKDIR /src/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE}
ARG VERSION=dev
LABEL org.opencontainers.image.title="AIO Arr" \
      org.opencontainers.image.description="One login and one page for Radarr, Sonarr, Lidarr, Prowlarr, Jellyfin and your download clients" \
      org.opencontainers.image.source="https://github.com/peseotni/aio-arr" \
      org.opencontainers.image.version="${VERSION}"
ENV NODE_ENV=production \
    PUID=1000 \
    PGID=1000 \
    PORT=8080 \
    CONFIG_DIR=/config \
    PUBLIC_DIR=/app/public \
    AIO_VERSION=${VERSION}
WORKDIR /app
COPY --from=server /src/server/package.json ./package.json
COPY --from=server /src/server/node_modules ./node_modules
COPY --from=server /src/server/dist ./dist
COPY --from=web /src/web/dist ./public
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh && mkdir -p /config \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
EXPOSE 8080
VOLUME ["/config"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/index.js"]

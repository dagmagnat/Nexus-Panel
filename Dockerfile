ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

WORKDIR /app

ENV NODE_ENV=production \
    NODE_OPTIONS=--dns-result-order=ipv4first \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_PROGRESS=false \
    NPM_CONFIG_LOGLEVEL=notice

ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG NPM_FALLBACK_REGISTRY=https://registry.yarnpkg.com/
ARG NPM_INSTALL_TIMEOUT=420
ARG NPM_FETCH_TIMEOUT=60000
ARG NPM_FETCH_RETRIES=2

# better-sqlite3 is native. Build tools are needed only while npm installs modules.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Keep dependency resolution reproducible in production builds.
COPY package.json package-lock.json ./

RUN set -eux; \
    install_ok=0; \
    for registry in "${NPM_REGISTRY}" "${NPM_FALLBACK_REGISTRY}"; do \
      registry="${registry%/}/"; \
      echo "==> Installing npm dependencies from ${registry}"; \
      npm config set registry "${registry}"; \
      npm config set fetch-retries "${NPM_FETCH_RETRIES}"; \
      npm config set fetch-retry-factor 2; \
      npm config set fetch-retry-mintimeout 5000; \
      npm config set fetch-retry-maxtimeout 30000; \
      npm config set fetch-timeout "${NPM_FETCH_TIMEOUT}"; \
      npm config set maxsockets 3; \
      rm -rf node_modules /tmp/npm-cache; \
      mkdir -p /tmp/npm-cache; \
      export npm_config_cache=/tmp/npm-cache; \
      if timeout --foreground --kill-after=30s "${NPM_INSTALL_TIMEOUT}s" \
          npm ci --omit=dev --no-audit --no-fund --prefer-online --foreground-scripts --no-progress; then \
        install_ok=1; \
        break; \
      fi; \
      echo "==> npm ci failed on ${registry}; trying next registry"; \
    done; \
    test "${install_ok}" = "1"; \
    test -d node_modules/dotenv; \
    test -d node_modules/express; \
    test -d node_modules/better-sqlite3; \
    npm cache clean --force >/dev/null 2>&1 || true; \
    rm -rf /tmp/npm-cache

COPY . .

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "app.js"]

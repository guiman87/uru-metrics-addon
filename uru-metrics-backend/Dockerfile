ARG BUILD_FROM
FROM ${BUILD_FROM}

# Tools needed:
#  - nodejs/npm  → run the backend
#  - python3/make/g++ → build better-sqlite3's native binding
#  - tzdata → America/Montevideo conversion
RUN apk add --no-cache nodejs npm python3 make g++ tzdata \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# Copy the npm workspace + source. The build context here is the addon
# folder (Home Assistant's default for addon builds), so all paths are
# relative to that folder. .dockerignore strips node_modules / dist / db.
COPY package.json package-lock.json* tsconfig.base.json ./
COPY news-aggregator ./news-aggregator

# Install backend + shared workspaces only. Skips the frontend (which we
# never mirror into this repo).
RUN npm install --workspace=@uru/backend --include-workspace-root --no-audit --no-fund

COPY run.sh /
RUN chmod a+x /run.sh

EXPOSE 3000

LABEL \
  io.hass.name="uru-metrics backend" \
  io.hass.description="News aggregator backend (Hono + SQLite + AI pipeline)" \
  io.hass.type="addon" \
  io.hass.version="0.1.0"

CMD [ "/run.sh" ]

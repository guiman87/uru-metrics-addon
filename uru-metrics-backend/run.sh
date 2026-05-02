#!/usr/bin/with-contenv bashio
set -e

bashio::log.info "─── uru-metrics backend starting ───"

# ─── Read HA addon options into env vars ────────────────────────────────────
export LLM_PROVIDER="$(bashio::config 'llm_provider')"
export LLM_MODEL_CATEGORIZE="$(bashio::config 'llm_model_categorize')"
export LLM_MODEL_CLUSTER="$(bashio::config 'llm_model_cluster')"
export LLM_MAX_USD_PER_DAY="$(bashio::config 'llm_max_usd_per_day')"
# Bashio returns 'true'/'false' for bool options as plain strings.
export LLM_COST_CAP_ENABLED="$(bashio::config 'llm_cost_cap_enabled')"

if bashio::config.has_value 'anthropic_api_key'; then
  export ANTHROPIC_API_KEY="$(bashio::config 'anthropic_api_key')"
fi
if bashio::config.has_value 'google_api_key'; then
  export GOOGLE_API_KEY="$(bashio::config 'google_api_key')"
fi
if bashio::config.has_value 'openai_api_key'; then
  export OPENAI_API_KEY="$(bashio::config 'openai_api_key')"
fi
if bashio::config.has_value 'admin_token'; then
  export ADMIN_TOKEN="$(bashio::config 'admin_token')"
fi
if bashio::config.has_value 'netlify_build_hook_url'; then
  export NETLIFY_BUILD_HOOK_URL="$(bashio::config 'netlify_build_hook_url')"
fi

# Convert the cors_origins YAML list into a comma-separated string.
export CORS_ORIGINS="$(bashio::config 'cors_origins | join(",")')"

# Persistent data lives on the addon's /data volume.
export DB_PATH=/data/articles.db
export PORT=3000
export HOST=0.0.0.0
export TZ_DISPLAY="America/Montevideo"

bashio::log.info "Provider: ${LLM_PROVIDER}"
if [ "${LLM_COST_CAP_ENABLED}" = "true" ]; then
  bashio::log.info "Daily cap: \$${LLM_MAX_USD_PER_DAY} (enforced)"
else
  bashio::log.warning "Daily cap: DISABLED — spending is logged but not capped"
fi
bashio::log.info "DB:       ${DB_PATH}"
bashio::log.info "CORS:     ${CORS_ORIGINS}"

cd /app/news-aggregator/packages/backend

# ─── First-boot setup (idempotent, safe to re-run) ─────────────────────────
bashio::log.info "Migrating database schema..."
npm run migrate

bashio::log.info "Seeding evergreen verticals..."
npm run seed:evergreen

# ─── Run server + cron in one process ──────────────────────────────────────
bashio::log.info "Starting server + hourly ingest cron..."
exec npx tsx src/main.ts

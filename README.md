# uru-metrics addon

Home Assistant addon repository for the **uru-metrics** news aggregator backend (Uruguay news → grouped by topic with AI categorization → public API).

This repo is a **public mirror** of the production-ready backend portion of the main project. Source of truth for development is the private repo at `guiman87/uru-metrics`; this mirror exists only so Home Assistant can clone the addon without authentication.

## Install in Home Assistant

1. **Settings → Add-ons → Add-on Store → ⋮ menu → Repositories**
2. Add: `https://github.com/guiman87/uru-metrics-addon`
3. Refresh the store. The **uru-metrics backend** addon appears.
4. Click **Install** → wait 3–5 min for the first build.
5. Configure (LLM provider + API key + cors_origins + optional Netlify build hook URL) → **Start**.

See `uru-metrics-backend/README.md` for the full configuration reference.

## Layout

```
.
├── repository.yaml          # marks this repo as an HA addon repository
└── uru-metrics-backend/     # the addon
    ├── config.yaml          # addon manifest (HA UI options live here)
    ├── Dockerfile           # build (COPY-based, no external clone)
    ├── run.sh               # bashio entrypoint
    ├── README.md            # addon-level docs
    ├── package.json         # npm workspace (backend + shared only)
    ├── tsconfig.base.json
    └── news-aggregator/
        └── packages/
            ├── backend/     # Hono server + SQLite + AI pipeline
            └── shared/      # TypeScript types
```

## Updating

This mirror is updated by running `scripts/sync-addon-repo.sh` from the private development repo whenever there's a new release. After the sync, push to this repo and rebuild the addon in Home Assistant (⋮ menu → Rebuild).

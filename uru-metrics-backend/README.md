# uru-metrics backend (Home Assistant addon)

Runs the [`uru-metrics`](https://github.com/guiman87/uru-metrics) news-aggregator backend on your Home Assistant box: hourly Cheerio crawler for ~13 Uruguay news portals, two-stage LLM categorization + cross-source topic clustering, plus a public read-only JSON API consumed by the Next.js frontend.

> **Heads up:** Home Assistant cannot pull from this repo because it's private. The addon is published as a public mirror at **https://github.com/guiman87/uru-metrics-addon**. Use that URL when adding the repository in HA. The `Dockerfile` in this folder is the *pre-mirror* version (clones the private repo) and is not the one HA will build — the mirror's Dockerfile is COPY-based and builds from local context. To publish a new version of the addon, run `scripts/sync-addon-repo.sh` from the private repo root.

## Install

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store → ⋮ menu → Repositories**.
2. Add `https://github.com/guiman87/uru-metrics-addon`.
3. The **uru-metrics backend** addon appears under "Local add-ons" or as a new repo card. Click → **Install**.
4. After install, go to **Configuration**:
   - **`llm_provider`**: `claude` (recommended), `gemini`, `openai`, or `stub` (no API spend, deterministic mock for testing).
   - **`anthropic_api_key`** (or `google_api_key` / `openai_api_key`): only the key for the chosen provider is required.
   - **`llm_max_usd_per_day`**: hard daily spend ceiling. The provider wrapper refuses calls past this. Default `5`.
   - **`cors_origins`**: comma-separated list of frontend origins allowed to consume the API. Add your Netlify URL here.
5. Click **Start**, then **Open Web UI** if exposed, or `curl http://homeassistant.local:3000/api/health`.

## Public exposure

The addon listens on internal port `3000`. To make the API publicly reachable for your Netlify frontend, add **one** of:

- **Cloudflare Tunnel addon** *(recommended)* — install the official `Cloudflared` addon, point a tunnel at `http://addon_uru-metrics-backend:3000`, choose a hostname like `api.urumetrics.<your-domain>`. Free WAF + edge cache, no port-forward, hides your home IP.
- **Port-forward + reverse proxy** — open `:443` on your router, point it at HA's `NGINX Proxy Manager` addon, set up Let's Encrypt for `api.urumetrics.<your-domain>` upstreaming to `http://addon_uru-metrics-backend:3000`.

Once exposed, set `NEXT_PUBLIC_API_BASE_URL` in your Netlify environment to `https://api.urumetrics.<your-domain>` and rebuild the frontend.

## Frontend caching: backend is hit at build time only

The frontend is fully **statically generated**. Netlify rebuilds the entire site after every successful ingest cycle, so visitors get pure CDN HTML and the backend is never touched per request.

To wire up the rebuild trigger:

1. In Netlify, go to **Site configuration → Build & deploy → Build hooks → Add build hook**, name it `uru-metrics ingest`, set the branch, and copy the URL.
2. Paste that URL into this addon's **`netlify_build_hook_url`** option.
3. Restart the addon.

After every successful ingest with new articles or topic changes, the backend POSTs to that URL and Netlify enqueues a fresh build. ~50 backend hits per build (one for the topic list, one per topic detail). With hourly ingestions that's ~1 200 backend hits/day — trivial for an ADSL connection — regardless of how many visitors the site gets.

## What lives where

- **Database** — `/data/articles.db` (persists across addon restarts; survives addon updates; backed up by HA snapshots).
- **Logs** — visible in the addon's Log tab.
- **Config** — all options come from the HA addon UI; no `.env` file inside the container.

## Updating

The addon clones the GitHub repo at build time. To pull new code:

1. Push to `main` on `guiman87/uru-metrics`.
2. In the addon: **⋮ menu → Rebuild** (or change `git_ref` to a specific commit/tag).

## Resources

The addon is a single Node process running both the Hono HTTP server and the `node-cron` hourly tick. Memory ~150 MB at idle, ~250 MB during an ingest. Disk grows ~1 MB per day of articles. SQLite is in WAL mode so reads and writes don't block each other.

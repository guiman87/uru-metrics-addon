# uru-metrics backend (Home Assistant addon)

Runs the **uru-metrics** news-aggregator backend on your Home Assistant box: hourly Cheerio crawler for ~13 Uruguay news portals, two-stage LLM categorization + cross-source topic clustering, plus a public read-only JSON API consumed by the Next.js frontend.

## Install

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store → ⋮ menu → Repositories**.
2. Add `https://github.com/guiman87/uru-metrics-addon`.
3. The **uru-metrics backend** addon appears as a new repo card. Click → **Install**.
4. After install, go to **Configuration**:
   - **`llm_provider`**: `claude` (recommended), `gemini`, `openai`, or `stub` (no API spend, deterministic mock for testing).
   - **`anthropic_api_key`** (or `google_api_key` / `openai_api_key`): only the key for the chosen provider is required.
   - **`llm_max_usd_per_day`**: hard daily spend ceiling. The provider wrapper refuses calls past this. Default `5`.
   - **`cors_origins`**: list of frontend origins allowed to consume the API. Add your Netlify URL here.
   - **`netlify_build_hook_url`** (optional): URL of a Netlify build hook. After every successful ingest the backend POSTs to it so Netlify rebuilds the static site with fresh data.
5. Click **Start**, then check the addon log for `[server] Listening on http://0.0.0.0:3000`.

## Public exposure

The addon listens on internal port `3000`. To make the API publicly reachable for your Netlify frontend, add **one** of:

- **Cloudflare Tunnel addon** *(recommended)* — install the `Cloudflared` addon, configure a tunnel pointing at `http://4d2be31a-uru-metrics-backend:3000`, choose a hostname like `api.urumetrics.<your-domain>`. Free WAF + edge cache, no port-forward, hides your home IP.
- **Port-forward + reverse proxy** — open `:443` on your router, point it at HA's `NGINX Proxy Manager` addon, set up Let's Encrypt for `api.urumetrics.<your-domain>` upstreaming to the same internal hostname.

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

The addon is a public mirror of the source-of-truth project at `guiman87/uru-metrics` (private). To pull new code, the maintainer runs `scripts/sync-addon-repo.sh` in the private repo, which copies the latest backend + shared workspaces into this mirror, regenerates the lockfile, commits and pushes. After that, in Home Assistant: **uru-metrics backend** addon → ⋮ menu → **Rebuild**.

## Resources

The addon is a single Node process running both the Hono HTTP server and the `node-cron` hourly tick. Memory ~150 MB at idle, ~250 MB during an ingest. Disk grows ~1 MB per day of articles. SQLite is in WAL mode so reads and writes don't block each other.

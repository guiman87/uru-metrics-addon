// Trigger a frontend rebuild after a successful ingest. Netlify build hooks
// are POST-only fire-and-forget URLs — Netlify enqueues a build and returns
// immediately. Doesn't block the ingest cron.
//
// Configure with NETLIFY_BUILD_HOOK_URL. Empty / unset = no-op.
//
// Other providers (Vercel deploy hooks, Cloudflare Pages deploy webhooks) use
// the same shape, so this works generically.
const HOOK_URL = (process.env.NETLIFY_BUILD_HOOK_URL ?? '').trim();
const TIMEOUT_MS = 5_000;

export async function triggerFrontendBuild(reason: string): Promise<void> {
  if (!HOOK_URL) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(HOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: 'uru-metrics-backend', reason }),
      signal: ctrl.signal,
    });
    if (res.ok) {
      console.log(`[build-hook] ${reason} → triggered (${res.status})`);
    } else {
      console.warn(`[build-hook] ${reason} → HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[build-hook] ${reason} → ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

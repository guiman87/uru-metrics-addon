import cron from 'node-cron';
import lockfile from 'proper-lockfile';
import fs from 'node:fs';
import path from 'node:path';
import { runIngest } from '../ingest/pipeline.js';
import { config } from '../config.js';

const LOCK_PATH = path.join(path.dirname(config.dbPath), 'ingest.lock');

async function tick(): Promise<void> {
  // Touch the lock target so proper-lockfile has a real file to stat.
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  fs.closeSync(fs.openSync(LOCK_PATH, 'a'));
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(LOCK_PATH, { stale: 30 * 60 * 1000, retries: 0 });
  } catch (err) {
    console.warn(`[hourly] Skipped — another ingest is already running (${(err as Error).message})`);
    return;
  }
  try {
    const result = await runIngest();
    console.log(`[hourly] Tick done in ${result.durationMs}ms — inserted ${result.totalInserted}.`);
  } catch (err) {
    console.error('[hourly] Tick failed:', err);
  } finally {
    await release();
  }
}

function start(): void {
  // Every hour at :05 — :00 is congested with everyone else's crons.
  cron.schedule('5 * * * *', tick, { timezone: 'UTC' });
  console.log('[hourly] Cron scheduled (5 * * * * UTC). Press Ctrl+C to exit.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
  // Run once immediately on boot so we don't wait up to an hour for the first tick.
  void tick();
}

export { start, tick };

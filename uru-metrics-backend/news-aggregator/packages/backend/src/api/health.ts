import { Hono } from 'hono';
import { getDb } from '../db/client.js';
import type { HealthResponse } from '@uru/shared';

export const healthRoute = new Hono();

healthRoute.get('/', (c) => {
  let db: 'ok' | 'error' = 'ok';
  let lastIngestAt: string | null = null;
  try {
    const row = getDb()
      .prepare<[], { finished_at: string | null }>(
        `SELECT finished_at FROM ingest_runs WHERE status = 'ok'
         ORDER BY id DESC LIMIT 1`,
      )
      .get();
    lastIngestAt = row?.finished_at ?? null;
  } catch (err) {
    console.error('[health] DB check failed:', err);
    db = 'error';
  }
  const body: HealthResponse = { ok: db === 'ok', db, lastIngestAt };
  return c.json(body);
});

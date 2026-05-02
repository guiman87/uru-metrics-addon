import { Hono } from 'hono';
import { getDb } from '../db/client.js';
import type { Source } from '@uru/shared';

interface SourceRow {
  domain: string;
  display_name: string;
  seed_urls: string;
  weight: number;
  bias_label: string | null;
  paywalled: number;
  active: number;
  fetcher: string;
  last_crawled_at: string | null;
}

export const sourcesRoute = new Hono();

sourcesRoute.get('/', (c) => {
  const rows = getDb()
    .prepare<[], SourceRow>('SELECT * FROM sources ORDER BY domain')
    .all();
  const sources: Source[] = rows.map((r) => ({
    domain: r.domain,
    displayName: r.display_name,
    seedUrls: JSON.parse(r.seed_urls) as string[],
    weight: r.weight,
    biasLabel: r.bias_label as Source['biasLabel'],
    paywalled: !!r.paywalled,
    active: !!r.active,
    fetcher: r.fetcher as Source['fetcher'],
    lastCrawledAt: r.last_crawled_at,
  }));
  return c.json({ sources });
});

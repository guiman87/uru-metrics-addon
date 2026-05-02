import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import type { ArticleListResponse } from '@uru/shared';

const querySchema = z.object({
  since: z.string().datetime().optional(),
  domain: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
});

interface ArticleRow {
  id: number;
  url: string;
  domain: string;
  headline: string;
  summary: string | null;
  image_url: string | null;
  published_at: string;
  scraped_at: string;
  status: string;
}

export const articlesRoute = new Hono();

articlesRoute.get('/', zValidator('query', querySchema), (c) => {
  const { since, domain, limit } = c.req.valid('query');
  const where: string[] = [];
  const params: Record<string, unknown> = { limit };
  if (since) {
    where.push('published_at >= @since');
    params.since = since;
  }
  if (domain) {
    where.push('domain = @domain');
    params.domain = domain;
  }
  const sql = `
    SELECT id, url, domain, headline, summary, image_url, published_at, scraped_at, status
    FROM articles
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY published_at DESC
    LIMIT @limit
  `;
  const rows = getDb().prepare<typeof params, ArticleRow>(sql).all(params);
  const body: ArticleListResponse = {
    articles: rows.map((r) => ({
      id: r.id,
      url: r.url,
      domain: r.domain,
      headline: r.headline,
      summary: r.summary,
      imageUrl: r.image_url,
      publishedAt: r.published_at,
      scrapedAt: r.scraped_at,
      status: r.status as 'new' | 'categorized' | 'failed',
    })),
  };
  return c.json(body);
});

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getDb } from '../db/client.js';

// Public search endpoint backed by the articles_fts virtual table. The
// FTS index is kept in sync by triggers on the `articles` table (see
// schema.sql), so this handler just translates a user query into a
// safe FTS5 expression and returns the bm25-ranked matches.
//
// Filters available: optional `domain` (outlet) and `since` (published-at
// floor). No `until` or pagination yet — keep the API surface small until
// usage tells us otherwise.

const querySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).optional().default(30),
  domain: z.string().optional(),
  since: z.string().datetime().optional(),
});

interface SearchRow {
  id: number;
  url: string;
  domain: string;
  headline: string;
  summary: string | null;
  image_url: string | null;
  published_at: string;
  score: number;
}

// FTS5's query parser treats `()`, `"`, `*`, `:`, `-`, `^`, `+`, `AND`,
// `OR`, `NEAR` and `NOT` specially. We accept free-form user input, so
// strip everything that isn't word-ish (including accented Spanish
// letters), split on whitespace, quote each token, and join with space —
// FTS5 treats space as implicit AND, so multi-word queries become a
// conjunction of phrase matches. Token quoting also protects against
// reserved-word collisions.
function buildMatchExpression(raw: string): string | null {
  const tokens = raw
    .toLowerCase()
    // Keep Latin letters (incl. accents), digits, ñ, and whitespace.
    // Everything else becomes a space.
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' ');
}

export const searchRoute = new Hono();

// Search results live as long as the article set behind them does
// (≈hourly turnover). 1-min fresh / 5-min stale-while-revalidate keeps
// the most-popular queries cheap without making popular searches feel
// stale during a breaking story.
searchRoute.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
});

searchRoute.get('/', zValidator('query', querySchema), (c) => {
  const { q, limit, domain, since } = c.req.valid('query');
  const match = buildMatchExpression(q);
  if (!match) {
    return c.json({ query: q, count: 0, articles: [] });
  }

  // Build the WHERE clause for optional filters. articles_fts is the
  // driving table for bm25 ranking; we JOIN to articles for the
  // user-visible columns plus filter predicates.
  const filters: string[] = ['articles_fts MATCH ?'];
  const params: unknown[] = [match];
  if (domain) {
    filters.push('a.domain = ?');
    params.push(domain);
  }
  if (since) {
    filters.push('a.published_at >= ?');
    params.push(since);
  }
  params.push(limit);

  // `rank` is FTS5's ascending bm25 score (lower = better match). We pull
  // it through under the alias `score` so the SELECT list stays explicit
  // even though we ORDER BY the same expression.
  const sql = `
    SELECT a.id, a.url, a.domain, a.headline, a.summary, a.image_url, a.published_at,
           bm25(articles_fts) AS score
    FROM articles_fts
    JOIN articles a ON a.id = articles_fts.rowid
    WHERE ${filters.join(' AND ')}
    ORDER BY score
    LIMIT ?
  `;
  const rows = getDb()
    .prepare<unknown[], SearchRow>(sql)
    .all(...params);

  return c.json({
    query: q,
    count: rows.length,
    articles: rows.map((r) => ({
      id: r.id,
      url: r.url,
      domain: r.domain,
      headline: r.headline,
      summary: r.summary,
      imageUrl: r.image_url,
      publishedAt: r.published_at,
    })),
  });
});

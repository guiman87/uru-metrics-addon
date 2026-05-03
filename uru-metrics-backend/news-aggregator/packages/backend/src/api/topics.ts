import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import type {
  Cobertura,
  EntityType,
  Topic,
  TopicListItem,
  TopicListResponse,
  TopicTrend,
  TopicScope,
} from '@uru/shared';

const TOP_ARTICLES_PER_TOPIC = 5;
const WINDOW_HOURS = 24;
const TREND_LOOKBACK_HOURS = 6;
// Below this magnitude we render trend as 'flat' so the UI can suppress it.
// Picked at 5% — small enough to catch real movement on a noisy hourly score,
// large enough to ignore the rounding jitter on slow-moving topics.
const TREND_FLAT_THRESHOLD_PCT = 5;
// Cobertura band thresholds. 'amplia' kicks in at 70% of active outlets so
// even with one or two missing sources a story still reads as broadly
// covered. 'acotada' caps at 3 to flag genuinely narrow pickup.
const COBERTURA_AMPLIA_RATIO = 0.7;
const COBERTURA_ACOTADA_MAX = 3;

const cutoffIso = () =>
  new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();
const trendLookbackIso = () =>
  new Date(Date.now() - TREND_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

function activeSourceCount(): number {
  const r = getDb()
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM sources WHERE active = 1`,
    )
    .get();
  return r?.n ?? 0;
}

function computeCobertura(sourceCount: number, total: number): Cobertura {
  if (total <= 0) return { label: 'tipica', count: sourceCount, total };
  const ratio = sourceCount / total;
  let label: Cobertura['label'] = 'tipica';
  if (ratio >= COBERTURA_AMPLIA_RATIO) label = 'amplia';
  else if (sourceCount <= COBERTURA_ACOTADA_MAX) label = 'acotada';
  return { label, count: sourceCount, total };
}

function computeTrend(topicId: number, currentImportance: number): TopicTrend | null {
  const prior = getDb()
    .prepare<[number, string], { importance: number }>(
      `SELECT importance FROM topic_scores
       WHERE topic_id = ? AND window_hours = 24 AND computed_at <= ?
       ORDER BY computed_at DESC LIMIT 1`,
    )
    .get(topicId, trendLookbackIso());
  if (!prior || prior.importance <= 0) return null;
  const deltaPct = Math.round(
    ((currentImportance - prior.importance) / prior.importance) * 100,
  );
  let direction: TopicTrend['direction'] = 'flat';
  if (deltaPct >= TREND_FLAT_THRESHOLD_PCT) direction = 'up';
  else if (deltaPct <= -TREND_FLAT_THRESHOLD_PCT) direction = 'down';
  return { direction, deltaPct };
}

const listQuery = z.object({
  window: z.enum(['24h']).optional().default('24h'),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  scope: z.enum(['evergreen', 'event', 'story']).optional().default('story'),
  // Hide topics with fewer than `minSources` outlets covering them in the
  // 24h window. Default 1 (no filter) for backward compatibility; the home
  // page passes 2 so single-source noise stays off the consensus feed.
  minSources: z.coerce.number().int().min(1).max(20).optional().default(1),
});

interface RankedTopicRow {
  topic_id: number;
  slug: string;
  label: string;
  scope: TopicScope;
  parent_topic_id: number | null;
  importance: number;
  source_count: number;
  article_count: number;
  computed_at: string;
}

function getLatestComputedAt(): string | null {
  const r = getDb()
    .prepare<[], { c: string | null }>(
      `SELECT MAX(computed_at) AS c FROM topic_scores WHERE window_hours = 24`,
    )
    .get();
  return r?.c ?? null;
}

interface ArticleSnippetRow {
  id: number;
  domain: string;
  headline: string;
  url: string;
  published_at: string;
  image_url: string | null;
  // Carried only by the detail-handler query; the list-handler (home cards)
  // never reads it. Keep the row shape unified to avoid a parallel type for
  // the same SELECT.
  summary?: string | null;
}

function fetchTopArticles(topicId: number): TopicListItem['topArticles'] {
  // Two requirements that must agree:
  //   1) Only count articles within the same 24h window as topic_scores.
  //   2) Surface ONE most-recent article per source so the chip strip shows
  //      every covering source even when one outlet dominates by recency.
  // ROW_NUMBER() partitioned by domain delivers both.
  const rows = getDb()
    .prepare<[number, string, number], ArticleSnippetRow>(
      `SELECT id, domain, headline, url, published_at, image_url
       FROM (
         SELECT
           a.id, a.domain, a.headline, a.url, a.published_at, a.image_url,
           ROW_NUMBER() OVER (PARTITION BY a.domain ORDER BY a.published_at DESC) AS rn
         FROM article_topics at
         JOIN articles a ON a.id = at.article_id
         WHERE at.topic_id = ?
           AND at.is_primary = 1
           AND a.published_at >= ?
       )
       WHERE rn = 1
       ORDER BY published_at DESC
       LIMIT ?`,
    )
    .all(topicId, cutoffIso(), TOP_ARTICLES_PER_TOPIC);
  return rows.map((r) => ({
    id: r.id,
    domain: r.domain,
    headline: r.headline,
    url: r.url,
    publishedAt: r.published_at,
    imageUrl: r.image_url,
  }));
}

interface TopicRowFull {
  id: number;
  slug: string;
  label: string;
  description: string | null;
  keywords_json: string;
  parent_topic_id: number | null;
  scope: TopicScope;
  first_seen_at: string;
  last_seen_at: string;
  status: string;
  entity_type: string | null;
}

function rowToTopic(r: TopicRowFull): Topic {
  return {
    id: r.id,
    slug: r.slug,
    label: r.label,
    description: r.description,
    keywords: JSON.parse(r.keywords_json) as string[],
    parentTopicId: r.parent_topic_id,
    scope: r.scope,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    status: r.status as Topic['status'],
    entityType: (r.entity_type as EntityType | null) ?? null,
  };
}

function buildBreadcrumbs(topic: Topic): Array<Pick<Topic, 'id' | 'slug' | 'label' | 'scope'>> {
  const chain: Array<Pick<Topic, 'id' | 'slug' | 'label' | 'scope'>> = [];
  let cur: Topic | null = topic;
  // Walk up parents (cap at 5 to defend against accidental cycles).
  for (let i = 0; cur && i < 5; i += 1) {
    chain.unshift({ id: cur.id, slug: cur.slug, label: cur.label, scope: cur.scope });
    if (cur.parentTopicId == null) break;
    const parentRow = getDb()
      .prepare<[number], TopicRowFull>(`SELECT * FROM topics WHERE id = ?`)
      .get(cur.parentTopicId);
    cur = parentRow ? rowToTopic(parentRow) : null;
  }
  return chain;
}

export const topicsRoute = new Hono();

// Topic data refreshes hourly (ingest cron). Edge caches it for 5 min and
// can keep serving stale up to 1 h while it revalidates in the background —
// covers the case where Netlify ISR or a CDN sits between us and the user.
topicsRoute.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
});

// ─── GET /api/topics — ranked list ─────────────────────────────────────────
topicsRoute.get('/', zValidator('query', listQuery), (c) => {
  const { limit, scope, minSources } = c.req.valid('query');
  const computedAt = getLatestComputedAt();

  if (scope === 'evergreen') {
    // Evergreens don't have topic_scores; rank by descendant article count
    // in the last 24h.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // Evergreen ranking. Two flavors share the query:
    //   non-entity vertical (parent of events/stories) → article count
    //     comes from descendants' primary-linked articles.
    //   entity-evergreen (leaf, entity_type != null) → count comes from
    //     articles directly linked via the entity-link step (is_primary=0).
    // Drop the is_primary filter on the join so both flavors are counted,
    // and use COUNT(DISTINCT a.id) so an article that's BOTH primary-linked
    // to a story under a vertical AND entity-linked to an entity under the
    // same vertical is only counted once for that vertical.
    const rows = getDb()
      .prepare<[string, string, number], RankedTopicRow>(
        `WITH RECURSIVE descendants(root_id, descendant_id) AS (
           SELECT id, id FROM topics WHERE scope = 'evergreen'
           UNION ALL
           SELECT d.root_id, t.id FROM topics t JOIN descendants d ON t.parent_topic_id = d.descendant_id
         )
         SELECT
           t.id              AS topic_id,
           t.slug            AS slug,
           t.label           AS label,
           t.scope           AS scope,
           t.parent_topic_id AS parent_topic_id,
           1.0               AS importance,
           COUNT(DISTINCT a.domain) AS source_count,
           COUNT(DISTINCT a.id)     AS article_count,
           ?                 AS computed_at
         FROM topics t
         LEFT JOIN descendants d ON d.root_id = t.id
         LEFT JOIN article_topics at ON at.topic_id = d.descendant_id
         LEFT JOIN articles a ON a.id = at.article_id AND a.published_at >= ?
         WHERE t.scope = 'evergreen'
         GROUP BY t.id
         ORDER BY article_count DESC, t.label ASC
         LIMIT ?`,
      )
      .all(computedAt ?? new Date().toISOString(), cutoff, limit) as unknown as RankedTopicRow[];
    const totalSources = activeSourceCount();
    const body: TopicListResponse = {
      computedAt: computedAt ?? new Date().toISOString(),
      windowHours: 24,
      topics: rows.map((r) => buildListItem(r, totalSources)),
    };
    return c.json(body);
  }

  // story / event — rank by latest topic_scores.importance, but recompute
  // source_count and article_count live so they match the same 24h window
  // used by fetchTopArticles. Without this, topic_scores stays at a snapshot
  // taken at the last score run, and articles aging out of the window cause
  // the displayed "X fuentes" to disagree with the chip strip.
  // The `minSources` filter (default 1) lets callers hide topics covered by
  // fewer than N outlets — the home page passes 2 to suppress single-source
  // noise from the consensus feed.
  const rows = getDb()
    .prepare<[string, TopicScope, number, number], RankedTopicRow>(
      `SELECT
         t.id                       AS topic_id,
         t.slug                     AS slug,
         t.label                    AS label,
         t.scope                    AS scope,
         t.parent_topic_id          AS parent_topic_id,
         ts.importance              AS importance,
         COALESCE(live.src_count, 0)  AS source_count,
         COALESCE(live.art_count, 0)  AS article_count,
         ts.computed_at             AS computed_at
       FROM topic_scores ts
       JOIN topics t ON t.id = ts.topic_id
       LEFT JOIN (
         SELECT at.topic_id,
                COUNT(DISTINCT a.domain) AS src_count,
                COUNT(*)                 AS art_count
         FROM article_topics at
         JOIN articles a ON a.id = at.article_id
         WHERE at.is_primary = 1 AND a.published_at >= ?
         GROUP BY at.topic_id
       ) live ON live.topic_id = ts.topic_id
       WHERE ts.computed_at = (SELECT MAX(computed_at) FROM topic_scores WHERE window_hours = 24)
         AND t.scope = ?
         AND COALESCE(live.src_count, 0) >= ?
       ORDER BY ts.importance DESC
       LIMIT ?`,
    )
    .all(cutoffIso(), scope, minSources, limit);

  const totalSources = activeSourceCount();
  const body: TopicListResponse = {
    computedAt: computedAt ?? new Date().toISOString(),
    windowHours: 24,
    topics: rows.map((r) => buildListItem(r, totalSources)),
  };
  return c.json(body);
});

function buildListItem(r: RankedTopicRow, totalSources: number): TopicListItem {
  const fullRow = getDb()
    .prepare<[number], TopicRowFull>(`SELECT * FROM topics WHERE id = ?`)
    .get(r.topic_id);
  const topic = fullRow ? rowToTopic(fullRow) : null;
  return {
    id: r.topic_id,
    slug: r.slug,
    label: r.label,
    scope: r.scope,
    importance: r.importance,
    sourceCount: r.source_count,
    articleCount: r.article_count,
    cobertura: computeCobertura(r.source_count, totalSources),
    trend: computeTrend(r.topic_id, r.importance),
    breadcrumbs: topic ? buildBreadcrumbs(topic) : [],
    topArticles: fetchTopArticles(r.topic_id),
  };
}

// ─── GET /api/topics/:slug ────────────────────────────────────────────────
topicsRoute.get('/:slug', (c) => {
  const slug = c.req.param('slug');
  const row = getDb()
    .prepare<[string], TopicRowFull>(`SELECT * FROM topics WHERE slug = ?`)
    .get(slug);
  if (!row) return c.json({ error: 'topic not found' }, 404);
  const topic = rowToTopic(row);
  const breadcrumbs = buildBreadcrumbs(topic);

  // Latest importance score for this topic — same source as the home list.
  // Returns 0 for evergreen topics or topics that haven't been scored yet.
  const scoreRow = getDb()
    .prepare<[number], { importance: number | null }>(
      `SELECT importance FROM topic_scores
       WHERE topic_id = ? AND window_hours = 24
       ORDER BY computed_at DESC LIMIT 1`,
    )
    .get(topic.id);
  const importance = scoreRow?.importance ?? 0;

  let descendants: Array<{ id: number; slug: string; label: string; scope: TopicScope; articleCount: number }> = [];
  if (topic.scope === 'evergreen') {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    descendants = getDb()
      .prepare<
        [number, string],
        { id: number; slug: string; label: string; scope: TopicScope; article_count: number }
      >(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM topics WHERE parent_topic_id = ?
           UNION ALL
           SELECT t.id FROM topics t JOIN tree x ON t.parent_topic_id = x.id
         )
         SELECT t.id, t.slug, t.label, t.scope, COUNT(at.article_id) AS article_count
         FROM topics t
         LEFT JOIN article_topics at ON at.topic_id = t.id AND at.is_primary = 1
         LEFT JOIN articles a ON a.id = at.article_id AND a.published_at >= ?
         WHERE t.id IN (SELECT id FROM tree)
         GROUP BY t.id
         ORDER BY article_count DESC, t.label`,
      )
      .all(topic.id, cutoff)
      .map((r) => ({
        id: r.id,
        slug: r.slug,
        label: r.label,
        scope: r.scope,
        articleCount: r.article_count,
      }));
  }

  // Articles for the topic page. Three scopes, three semantics:
  //
  //   entity-evergreen  → articles directly linked via the entity-link
  //                       step (always is_primary=0). No tree expansion;
  //                       these topics are leaves.
  //   non-entity evergreen (vertical) → walk the descendants tree (its
  //                       child events/stories own the actual articles
  //                       with is_primary=1) AND include direct entity
  //                       links so an article that's primary-linked to
  //                       a story under this vertical AND entity-linked
  //                       to one of its entity-children is counted once.
  //                       DISTINCT a.id deduplicates.
  //   event / story    → direct primary link only.
  //
  // Detail-handler query carries `summary` so the topic page can render
  // the LLM-generated blurb with attribution under each headline.
  const articles = (topic.scope === 'evergreen'
    ? topic.entityType !== null
      ? getDb()
          .prepare<[number], ArticleSnippetRow>(
            `SELECT a.id, a.domain, a.headline, a.url, a.published_at, a.image_url, a.summary
             FROM article_topics at
             JOIN articles a ON a.id = at.article_id
             WHERE at.topic_id = ?
             ORDER BY a.published_at DESC
             LIMIT 100`,
          )
          .all(topic.id)
      : getDb()
          .prepare<[number], ArticleSnippetRow>(
            `WITH RECURSIVE tree(id) AS (
               SELECT id FROM topics WHERE id = ?
               UNION ALL
               SELECT t.id FROM topics t JOIN tree x ON t.parent_topic_id = x.id
             )
             SELECT DISTINCT a.id, a.domain, a.headline, a.url, a.published_at, a.image_url, a.summary
             FROM article_topics at
             JOIN articles a ON a.id = at.article_id
             WHERE at.topic_id IN (SELECT id FROM tree)
             ORDER BY a.published_at DESC
             LIMIT 100`,
          )
          .all(topic.id)
    : getDb()
        .prepare<
          [number],
          ArticleSnippetRow
        >(
          `SELECT a.id, a.domain, a.headline, a.url, a.published_at, a.image_url, a.summary
           FROM article_topics at
           JOIN articles a ON a.id = at.article_id
           WHERE at.topic_id = ? AND at.is_primary = 1
           ORDER BY a.published_at DESC
           LIMIT 100`,
        )
        .all(topic.id)
  ).map((r) => ({
    id: r.id,
    domain: r.domain,
    headline: r.headline,
    summary: r.summary ?? null,
    url: r.url,
    publishedAt: r.published_at,
    imageUrl: r.image_url,
  }));

  // Source diversity is computed live from the article rows we just pulled
  // — same source-of-truth as the rendered list, so the badge can never
  // drift from what the user sees.
  const distinctSources = new Set(articles.map((a) => a.domain)).size;
  const cobertura = computeCobertura(distinctSources, activeSourceCount());
  const trend = computeTrend(topic.id, importance);

  return c.json({
    topic: { ...topic, breadcrumbs, importance, cobertura, trend },
    descendants,
    articles,
  });
});

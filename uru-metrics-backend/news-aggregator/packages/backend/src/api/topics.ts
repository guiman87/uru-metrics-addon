import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import type {
  Topic,
  TopicListItem,
  TopicListResponse,
  TopicScope,
} from '@uru/shared';

const TOP_ARTICLES_PER_TOPIC = 5;
const WINDOW_HOURS = 24;
const cutoffIso = () =>
  new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();

const listQuery = z.object({
  window: z.enum(['24h']).optional().default('24h'),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  scope: z.enum(['evergreen', 'event', 'story']).optional().default('story'),
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

// ─── GET /api/topics — ranked list ─────────────────────────────────────────
topicsRoute.get('/', zValidator('query', listQuery), (c) => {
  const { limit, scope } = c.req.valid('query');
  const computedAt = getLatestComputedAt();

  if (scope === 'evergreen') {
    // Evergreens don't have topic_scores; rank by descendant article count
    // in the last 24h.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = getDb()
      .prepare<[string, string, number], RankedTopicRow>(
        `WITH RECURSIVE descendants(root_id, descendant_id) AS (
           SELECT id, id FROM topics WHERE scope = 'evergreen'
           UNION ALL
           SELECT d.root_id, t.id FROM topics t JOIN descendants d ON t.parent_topic_id = d.descendant_id
         )
         SELECT
           t.id           AS topic_id,
           t.slug         AS slug,
           t.label        AS label,
           t.scope        AS scope,
           t.parent_topic_id AS parent_topic_id,
           1.0            AS importance,
           COUNT(DISTINCT a.domain) AS source_count,
           COUNT(*)       AS article_count,
           ?              AS computed_at
         FROM topics t
         LEFT JOIN descendants d ON d.root_id = t.id
         LEFT JOIN article_topics at ON at.topic_id = d.descendant_id AND at.is_primary = 1
         LEFT JOIN articles a ON a.id = at.article_id AND a.published_at >= ?
         WHERE t.scope = 'evergreen'
         GROUP BY t.id
         ORDER BY article_count DESC, t.label ASC
         LIMIT ?`,
      )
      .all(computedAt ?? new Date().toISOString(), cutoff, limit) as unknown as RankedTopicRow[];
    const body: TopicListResponse = {
      computedAt: computedAt ?? new Date().toISOString(),
      windowHours: 24,
      topics: rows.map((r) => buildListItem(r)),
    };
    return c.json(body);
  }

  // story / event — rank by latest topic_scores.importance, but recompute
  // source_count and article_count live so they match the same 24h window
  // used by fetchTopArticles. Without this, topic_scores stays at a snapshot
  // taken at the last score run, and articles aging out of the window cause
  // the displayed "X fuentes" to disagree with the chip strip.
  const rows = getDb()
    .prepare<[string, TopicScope, number], RankedTopicRow>(
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
         AND COALESCE(live.src_count, 0) > 0
       ORDER BY ts.importance DESC
       LIMIT ?`,
    )
    .all(cutoffIso(), scope, limit);

  const body: TopicListResponse = {
    computedAt: computedAt ?? new Date().toISOString(),
    windowHours: 24,
    topics: rows.map((r) => buildListItem(r)),
  };
  return c.json(body);
});

function buildListItem(r: RankedTopicRow): TopicListItem {
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

  // Articles directly assigned (or inherited via descendants for evergreen)
  const articles = (topic.scope === 'evergreen'
    ? getDb()
        .prepare<
          [number],
          ArticleSnippetRow
        >(
          `WITH RECURSIVE tree(id) AS (
             SELECT id FROM topics WHERE id = ?
             UNION ALL
             SELECT t.id FROM topics t JOIN tree x ON t.parent_topic_id = x.id
           )
           SELECT DISTINCT a.id, a.domain, a.headline, a.url, a.published_at, a.image_url
           FROM article_topics at
           JOIN articles a ON a.id = at.article_id
           WHERE at.topic_id IN (SELECT id FROM tree) AND at.is_primary = 1
           ORDER BY a.published_at DESC
           LIMIT 100`,
        )
        .all(topic.id)
    : getDb()
        .prepare<
          [number],
          ArticleSnippetRow
        >(
          `SELECT a.id, a.domain, a.headline, a.url, a.published_at, a.image_url
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
    url: r.url,
    publishedAt: r.published_at,
    imageUrl: r.image_url,
  }));

  return c.json({
    topic: { ...topic, breadcrumbs },
    descendants,
    articles,
  });
});

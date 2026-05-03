// Phase 2: post-cluster step that links categorized articles to any
// entity-evergreen they mention. Runs every ingest tick. Idempotent —
// uses INSERT OR IGNORE on the (article_id, topic_id) primary key, so
// re-runs are cheap.
//
// Matching is exact-equal on the normalized form (lowercase, diacritic-
// stripped, whitespace-collapsed) of each entity in the article's
// entities_json against every alias of every entity-evergreen. The alias
// table already includes the canonical label and the most common casings
// captured at promotion time, so variants like "C.A. Peñarol" and
// "Peñarol" both resolve to the same evergreen.
//
// No LLM cost. Just SQL + JS.

import { getDb } from '../db/client.js';
import { getAliasesForTopic, getEntityEvergreens } from './topics.js';

const LINK_LOOKBACK_DAYS = 90;
// All entity matches share the same confidence — they're deterministic
// string-equality hits, so a fixed value above the heuristic floor (0.75)
// makes them visibly distinguishable from cluster matches in queries.
const LINK_CONFIDENCE = 0.9;

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ArticleRow {
  id: number;
  entities_json: string | null;
}

export interface LinkStats {
  entityEvergreens: number;
  articlesScanned: number;
  linksInserted: number;
  linksAlreadyPresent: number;
}

export function linkArticlesToEntityEvergreens(opts?: { daysBack?: number }): LinkStats {
  const stats: LinkStats = {
    entityEvergreens: 0,
    articlesScanned: 0,
    linksInserted: 0,
    linksAlreadyPresent: 0,
  };

  const evergreens = getEntityEvergreens();
  stats.entityEvergreens = evergreens.length;
  if (evergreens.length === 0) {
    // Nothing to do until the operator runs `npm run promote:apply`.
    return stats;
  }

  // Build the normalized-alias → topicId lookup once per pass. The map is
  // small (≈50 entity-evergreens × ≈3 aliases each = ≈150 entries) and is
  // probed millions of times below, so the up-front cost is trivial.
  const lookup = new Map<string, number>();
  for (const t of evergreens) {
    lookup.set(normalize(t.label), t.id);
    for (const alias of getAliasesForTopic(t.id)) {
      // Skip the synthetic "hash:..." aliases from createTopic — those are
      // canonical-keyword fingerprints, not entity-name aliases.
      if (alias.startsWith('hash:')) continue;
      const key = normalize(alias);
      if (key.length >= 3) lookup.set(key, t.id);
    }
  }

  const cutoff = new Date(
    Date.now() - (opts?.daysBack ?? LINK_LOOKBACK_DAYS) * 24 * 60 * 60 * 1000,
  ).toISOString();
  const articles = getDb()
    .prepare<[string], ArticleRow>(
      `SELECT id, entities_json
       FROM articles
       WHERE status = 'categorized'
         AND published_at >= ?
         AND entities_json IS NOT NULL`,
    )
    .all(cutoff);

  const insertStmt = getDb().prepare(
    `INSERT OR IGNORE INTO article_topics (article_id, topic_id, confidence, is_primary)
     VALUES (?, ?, ?, 0)`,
  );
  // Wrap the per-article inserts in a single transaction — one SQLite
  // commit instead of N. With a few thousand articles this turns a 2-3s
  // pass into milliseconds.
  const tx = getDb().transaction((rows: ArticleRow[]) => {
    for (const r of rows) {
      stats.articlesScanned += 1;
      let entities: unknown;
      try {
        entities = JSON.parse(r.entities_json ?? 'null');
      } catch {
        continue;
      }
      if (!Array.isArray(entities)) continue;
      const seen = new Set<number>();
      for (const raw of entities) {
        if (typeof raw !== 'string') continue;
        const key = normalize(raw);
        if (key.length < 3) continue;
        const topicId = lookup.get(key);
        if (!topicId || seen.has(topicId)) continue;
        seen.add(topicId);
        const info = insertStmt.run(r.id, topicId, LINK_CONFIDENCE);
        if (info.changes === 1) stats.linksInserted += 1;
        else stats.linksAlreadyPresent += 1;
      }
    }
  });
  tx(articles);

  return stats;
}

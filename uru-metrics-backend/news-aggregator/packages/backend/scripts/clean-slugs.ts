/**
 * One-shot migration: rewrite topic slugs from "<base>-<hash>" to bare
 * "<base>" wherever there's no collision. Always records the canonical
 * keyword hash alias so re-ingest still resolves to the same topic.
 *
 * Idempotent — re-running on a clean DB is a no-op.
 *
 * Run via:
 *   npm run clean-slugs --workspace=@uru/backend     # from repo root
 *   npx tsx scripts/clean-slugs.ts                   # from packages/backend
 *
 * Also called automatically from migrate.ts so addon reboots keep the DB
 * in sync after a code update.
 */
import crypto from 'node:crypto';
import { getDb, closeDb } from '../src/db/client.js';
import { canonicalizeKeywords } from '../src/ai/topics.js';

function shortHashOf(canonical: string[]): string {
  const h = crypto.createHash('sha1').update(canonical.join('|')).digest('hex');
  return h.slice(0, 6);
}

interface Row {
  id: number;
  slug: string;
  keywords_json: string;
}

export interface CleanSlugsStats {
  scanned: number;
  renamed: number;
  skippedCollision: number;
  aliasesAdded: number;
}

export function cleanSlugs(): CleanSlugsStats {
  const db = getDb();
  const rows = db
    .prepare<[], Row>(
      `SELECT id, slug, keywords_json
       FROM topics
       WHERE scope IN ('event','story')`,
    )
    .all();

  const update = db.prepare(`UPDATE topics SET slug = ? WHERE id = ?`);
  const findBySlug = db.prepare<[string], { id: number }>(
    `SELECT id FROM topics WHERE slug = ?`,
  );
  const insertAlias = db.prepare(
    `INSERT OR IGNORE INTO topic_aliases (alias, topic_id) VALUES (?, ?)`,
  );

  const stats: CleanSlugsStats = {
    scanned: rows.length,
    renamed: 0,
    skippedCollision: 0,
    aliasesAdded: 0,
  };

  const tx = db.transaction(() => {
    for (const row of rows) {
      const keywords = JSON.parse(row.keywords_json) as string[];
      const canonical = canonicalizeKeywords(keywords);
      const hash = shortHashOf(canonical);
      const hashAlias = `hash:${hash}`;

      // Always record the alias — the new createTopic() resolves topics by
      // hash:<canonical> and this lets pre-migration topics participate
      // even if we don't end up renaming them.
      const aliasResult = insertAlias.run(hashAlias, row.id);
      if (aliasResult.changes > 0) stats.aliasesAdded += 1;

      // Detection: does this slug have the canonical-hash suffix? If yes,
      // try to strip it. If the bare base would collide with another
      // topic, leave the slug alone.
      const expectedSuffix = `-${hash}`;
      if (!row.slug.endsWith(expectedSuffix)) continue;

      const candidate = row.slug.slice(0, -expectedSuffix.length);
      if (!candidate) continue;

      const collision = findBySlug.get(candidate);
      if (collision && collision.id !== row.id) {
        stats.skippedCollision += 1;
        continue;
      }

      update.run(candidate, row.id);
      stats.renamed += 1;
    }
  });
  tx();

  return stats;
}

function main(): void {
  console.log('[clean-slugs] starting...');
  const stats = cleanSlugs();
  console.log(
    `[clean-slugs] scanned=${stats.scanned}  renamed=${stats.renamed}  collisions-skipped=${stats.skippedCollision}  aliases-added=${stats.aliasesAdded}`,
  );
  closeDb();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

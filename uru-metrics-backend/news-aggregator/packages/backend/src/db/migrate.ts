import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeDb } from './client.js';
import { sources } from '../ingest/sources.js';
import { cleanSlugs } from '../../scripts/clean-slugs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function applySchema(): void {
  const db = getDb();
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(sql);
  console.log(`[migrate] Schema applied at ${db.name}`);
}

// Add a column if it doesn't already exist on `table`. SQLite supports ALTER
// TABLE ADD COLUMN but lacks IF NOT EXISTS, so we probe pragma first.
function addColumnIfMissing(table: string, column: string, definition: string): boolean {
  const db = getDb();
  const cols = db
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all();
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[migrate] Added ${table}.${column}`);
  return true;
}

function migrateLlmUsageCacheCols(): void {
  addColumnIfMissing('llm_usage', 'cache_creation_input_tok', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('llm_usage', 'cache_read_input_tok', 'INTEGER NOT NULL DEFAULT 0');
}

function upsertSources(): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO sources (domain, display_name, seed_urls, weight, bias_label, paywalled, active, fetcher)
    VALUES (@domain, @displayName, @seedUrls, @weight, @biasLabel, @paywalled, @active, @fetcher)
    ON CONFLICT(domain) DO UPDATE SET
      display_name = excluded.display_name,
      seed_urls    = excluded.seed_urls,
      weight       = excluded.weight,
      bias_label   = excluded.bias_label,
      paywalled    = excluded.paywalled,
      active       = excluded.active,
      fetcher      = excluded.fetcher
  `);
  const tx = db.transaction(() => {
    for (const s of sources) {
      stmt.run({
        domain: s.domain,
        displayName: s.displayName,
        seedUrls: JSON.stringify(s.seedUrls),
        weight: s.weight,
        biasLabel: s.biasLabel,
        paywalled: s.paywalled ? 1 : 0,
        active: s.active ? 1 : 0,
        fetcher: s.fetcher,
      });
    }
  });
  tx();
  console.log(`[migrate] Synced ${sources.length} sources`);
}

function main(): void {
  applySchema();
  migrateLlmUsageCacheCols();
  upsertSources();

  // Migrate topic slugs from "<base>-<hash>" to bare "<base>" wherever
  // there's no collision. Idempotent — only does work once per topic.
  const slugStats = cleanSlugs();
  if (slugStats.renamed > 0 || slugStats.aliasesAdded > 0) {
    console.log(
      `[migrate] clean-slugs: renamed=${slugStats.renamed} aliases-added=${slugStats.aliasesAdded} collisions-skipped=${slugStats.skippedCollision}`,
    );
  }

  closeDb();
  console.log('[migrate] Done.');
}

main();

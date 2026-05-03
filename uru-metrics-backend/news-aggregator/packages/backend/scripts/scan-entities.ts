// Phase 2: candidate scan for entity-evergreen promotion.
//
// Reads articles.entities_json over the last N days, aggregates mentions
// per normalized entity, filters to entities seen in enough articles
// across enough distinct outlets to be worth a permanent topic page,
// excludes anything already promoted or already a seeded vertical, and
// writes the result to a JSON file the operator can review and edit
// before running `npm run promote:apply`.
//
// No LLM calls — this is a pure SQL pass.

import fs from 'node:fs';
import path from 'node:path';
import { closeDb, getDb } from '../src/db/client.js';
import { config } from '../src/config.js';

interface ArticleRow {
  id: number;
  domain: string;
  headline: string;
  entities_json: string | null;
}

interface CandidateAccum {
  /** Most common original casing observed in the data. */
  candidateLabel: string;
  /** Lowercase, diacritic-stripped, whitespace-collapsed. */
  normalizedLabel: string;
  /** Total mentions across all articles. */
  mentionCount: number;
  /** Distinct outlet domains that mentioned this entity. */
  sourceDomains: Set<string>;
  /** A handful of representative headlines for LLM context. */
  sampleHeadlines: string[];
  /** Tracks original casings so we can pick the most common as canonical. */
  casings: Map<string, number>;
}

function normalizeLabel(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ScanArgs {
  daysBack: number;
  minMentions: number;
  minSources: number;
  top: number;
  output: string;
}

function parseArgs(): ScanArgs {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const i = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
    if (i === -1) return fallback;
    const a = args[i] ?? '';
    if (a.includes('=')) return a.split('=')[1] ?? fallback;
    return args[i + 1] ?? fallback;
  };
  return {
    daysBack: Number(get('--days', '90')),
    minMentions: Number(get('--min-mentions', '20')),
    minSources: Number(get('--min-sources', '4')),
    top: Number(get('--top', '50')),
    output: get(
      '--output',
      path.join(path.dirname(config.dbPath), 'entity-promotion-candidates.json'),
    ),
  };
}

function loadCategorizedArticles(daysBack: number): ArticleRow[] {
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  return getDb()
    .prepare<[string], ArticleRow>(
      `SELECT id, domain, headline, entities_json
       FROM articles
       WHERE status = 'categorized' AND published_at >= ? AND entities_json IS NOT NULL`,
    )
    .all(cutoff);
}

function loadAlreadyPromotedNormalized(): Set<string> {
  // Skip anything that's already a topic — both seeded verticals (entity_type
  // IS NULL) and already-promoted entities — so we never propose a duplicate.
  return new Set(
    getDb()
      .prepare<[], { label: string }>(
        `SELECT label FROM topics WHERE scope = 'evergreen'`,
      )
      .all()
      .map((r) => normalizeLabel(r.label))
      .filter((s) => s.length > 0),
  );
}

function pickCanonicalCasing(casings: Map<string, number>): string {
  let best: { value: string; count: number } | null = null;
  for (const [value, count] of casings.entries()) {
    if (!best || count > best.count) best = { value, count };
  }
  return best?.value ?? '';
}

function main(): void {
  const opts = parseArgs();
  console.log(
    `[scan-entities] days=${opts.daysBack} min-mentions=${opts.minMentions} min-sources=${opts.minSources} top=${opts.top}`,
  );
  console.log(`[scan-entities] output=${opts.output}`);

  const articles = loadCategorizedArticles(opts.daysBack);
  console.log(`[scan-entities] Scanning ${articles.length} categorized articles…`);

  const skipNormalized = loadAlreadyPromotedNormalized();
  console.log(
    `[scan-entities] ${skipNormalized.size} existing evergreens will be skipped.`,
  );

  const accum = new Map<string, CandidateAccum>();
  for (const a of articles) {
    let entities: unknown;
    try {
      entities = JSON.parse(a.entities_json ?? 'null');
    } catch {
      continue;
    }
    if (!Array.isArray(entities)) continue;
    const seenInThisArticle = new Set<string>();
    for (const raw of entities) {
      if (typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      if (trimmed.length < 3 || trimmed.length > 80) continue;
      const norm = normalizeLabel(trimmed);
      if (norm.length < 3) continue;
      if (skipNormalized.has(norm)) continue;
      // Don't double-count when an article lists the same entity twice
      // (some scrapers can emit "Lacalle Pou" and "Lacalle  Pou").
      if (seenInThisArticle.has(norm)) continue;
      seenInThisArticle.add(norm);

      let entry = accum.get(norm);
      if (!entry) {
        entry = {
          candidateLabel: trimmed,
          normalizedLabel: norm,
          mentionCount: 0,
          sourceDomains: new Set<string>(),
          sampleHeadlines: [],
          casings: new Map<string, number>(),
        };
        accum.set(norm, entry);
      }
      entry.mentionCount += 1;
      entry.sourceDomains.add(a.domain);
      entry.casings.set(trimmed, (entry.casings.get(trimmed) ?? 0) + 1);
      if (entry.sampleHeadlines.length < 5) {
        entry.sampleHeadlines.push(a.headline);
      }
    }
  }

  // Filter + rank.
  const candidates = [...accum.values()]
    .filter(
      (c) =>
        c.mentionCount >= opts.minMentions && c.sourceDomains.size >= opts.minSources,
    )
    .map((c) => ({
      candidateLabel: pickCanonicalCasing(c.casings),
      normalizedLabel: c.normalizedLabel,
      mentionCount: c.mentionCount,
      sourceCount: c.sourceDomains.size,
      sourceDomains: [...c.sourceDomains].sort(),
      sampleHeadlines: c.sampleHeadlines,
    }))
    .sort((a, b) => b.mentionCount - a.mentionCount || b.sourceCount - a.sourceCount)
    .slice(0, opts.top);

  // Write atomically: write to .tmp then rename, so a partial file never
  // confuses the apply step if scan-entities is killed mid-write.
  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    params: {
      daysBack: opts.daysBack,
      minMentions: opts.minMentions,
      minSources: opts.minSources,
    },
    totalScanned: articles.length,
    candidateCount: candidates.length,
    candidates,
  };
  const tmp = `${opts.output}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, opts.output);

  console.log(
    `[scan-entities] Wrote ${candidates.length} candidates to ${opts.output}`,
  );
  if (candidates.length > 0) {
    console.log('[scan-entities] Top 10:');
    for (const c of candidates.slice(0, 10)) {
      console.log(
        `  - ${c.candidateLabel.padEnd(40)} ${String(c.mentionCount).padStart(4)}m / ${String(c.sourceCount).padStart(2)}s`,
      );
    }
  }

  closeDb();
}

main();

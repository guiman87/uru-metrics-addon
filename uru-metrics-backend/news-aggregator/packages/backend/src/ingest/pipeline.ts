import pLimit from 'p-limit';
import { getDb } from '../db/client.js';
import { discoverArticleUrls, normalizeUrl } from './crawl.js';
import { extractArticle } from './extract.js';
import { getKnownUrlsForDomain, storeArticles, touchSourceCrawledAt } from './store.js';
import { sources as configuredSources } from './sources.js';
import { runCategorize } from '../ai/categorize.js';
import { runCluster } from '../ai/cluster.js';
import { runScore } from '../ai/rank.js';
import { triggerFrontendBuild } from '../jobs/build-hook.js';
import type { ScrapedArticle } from '@uru/shared';

const PER_SOURCE_CONCURRENCY = 4;
const POLITENESS_DELAY_MS = 800;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PipelineResult {
  durationMs: number;
  perSource: Array<{
    domain: string;
    discovered: number;
    skippedKnown: number;
    extracted: number;
    failures: Record<string, number>;
    inserted: number;
  }>;
  totalInserted: number;
  ai: {
    categorize: { ok: number; failed: number; skipped: number; capHit: boolean } | null;
    cluster: { assigned: number; created: number; reused: number; capHit: boolean } | null;
    score: { topicsScored: number; capHit: boolean } | null;
  };
}

export interface RunIngestOptions {
  /** Skip the AI pipeline entirely. Use for crawl-only smoke tests. */
  skipAi?: boolean;
  /** Override the configured LLM provider. Mostly for testing. */
  providerName?: string;
}

function startRun(): number {
  const info = getDb()
    .prepare(
      `INSERT INTO ingest_runs (started_at, status) VALUES (?, 'running')`,
    )
    .run(new Date().toISOString());
  return Number(info.lastInsertRowid);
}

function finishRun(id: number, totalInserted: number, error?: Error): void {
  getDb()
    .prepare(
      `UPDATE ingest_runs SET finished_at = ?, status = ?, articles_new = ?, error_message = ?
       WHERE id = ?`,
    )
    .run(
      new Date().toISOString(),
      error ? 'error' : 'ok',
      totalInserted,
      error ? error.message.slice(0, 500) : null,
      id,
    );
}

export async function runIngest(opts: RunIngestOptions = {}): Promise<PipelineResult> {
  const t0 = Date.now();
  const runId = startRun();
  const perSource: PipelineResult['perSource'] = [];
  let totalInserted = 0;
  const ai: PipelineResult['ai'] = { categorize: null, cluster: null, score: null };

  try {
    const active = configuredSources.filter((s) => s.active);
    console.log(`[pipeline] Active sources: ${active.map((s) => s.domain).join(', ')}`);

    for (const source of active) {
      const t1 = Date.now();
      console.log(`[pipeline] ${source.domain} — discovering links...`);
      const { urls, errors } = await discoverArticleUrls(source);
      for (const e of errors) console.warn(`[pipeline] ${source.domain} seed error: ${e}`);

      const known = getKnownUrlsForDomain(source.domain);
      const fresh = urls.filter((u) => !known.has(normalizeUrl(u)));
      console.log(
        `[pipeline] ${source.domain} — ${urls.length} discovered, ${fresh.length} new (skipped ${urls.length - fresh.length} known)`,
      );

      const limit = pLimit(PER_SOURCE_CONCURRENCY);
      const failures: Record<string, number> = {};
      const extracted: ScrapedArticle[] = [];

      await Promise.all(
        fresh.map((url) =>
          limit(async () => {
            const result = await extractArticle(url, source.domain);
            // Politeness inside the limited pool.
            await sleep(POLITENESS_DELAY_MS);
            if (result.ok) {
              extracted.push(result.article);
            } else {
              failures[result.reason] = (failures[result.reason] ?? 0) + 1;
            }
          }),
        ),
      );

      const stats = storeArticles(extracted);
      touchSourceCrawledAt(source.domain);
      totalInserted += stats.inserted;

      console.log(
        `[pipeline] ${source.domain} — extracted ${extracted.length}, inserted ${stats.inserted}, dupes ${stats.duplicates}, failures ${JSON.stringify(failures)}, ${Date.now() - t1}ms`,
      );

      perSource.push({
        domain: source.domain,
        discovered: urls.length,
        skippedKnown: urls.length - fresh.length,
        extracted: extracted.length,
        failures,
        inserted: stats.inserted,
      });
    }

    if (!opts.skipAi) {
      const cat = await runCategorize({ providerName: opts.providerName });
      ai.categorize = {
        ok: cat.ok,
        failed: cat.failed,
        skipped: cat.skippedEmpty,
        capHit: cat.capHit,
      };

      if (!cat.capHit) {
        const cl = await runCluster({ providerName: opts.providerName });
        ai.cluster = {
          assigned: cl.articlesAssigned,
          created: cl.topicsCreated,
          reused: cl.topicsReused,
          capHit: cl.capHit,
        };

        if (!cl.capHit) {
          const sc = await runScore({ providerName: opts.providerName });
          ai.score = { topicsScored: sc.topicsScored, capHit: sc.capHit };
        }
      }
    }

    finishRun(runId, totalInserted);
  } catch (err) {
    finishRun(runId, totalInserted, err as Error);
    throw err;
  }

  // Trigger a frontend rebuild only when something user-visible changed —
  // new articles, new topics, or a recomputed score. No-op if the build hook
  // env var isn't configured (local dev). Fire-and-forget; doesn't block.
  const aiCreated = (ai.cluster?.created ?? 0) + (ai.cluster?.assigned ?? 0);
  const aiScored = ai.score?.topicsScored ?? 0;
  if (totalInserted > 0 || aiCreated > 0 || aiScored > 0) {
    void triggerFrontendBuild(
      `inserted=${totalInserted} clusterAssigned=${aiCreated} scored=${aiScored}`,
    );
  }

  return {
    durationMs: Date.now() - t0,
    perSource,
    totalInserted,
    ai,
  };
}

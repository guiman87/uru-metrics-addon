import pLimit from 'p-limit';
import { BatchedArticleExtractionSchema } from '@uru/shared';
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { getProvider } from './provider.js';
import { CostCapExceededError } from './usage.js';

const CATEGORIZE_BATCH_SIZE = 8;
const CATEGORIZE_BATCH_CONCURRENCY = 4;
const MAX_CONTENT_CHARS = 4_000;

// First line is read by StubProvider and (cheaply) by humans for grep-ability.
const SYSTEM_PROMPT = `[stage:categorize]
Sos editor de noticias uruguayo. Recibís una lista de artículos (cada uno con articleId, titular y cuerpo) y devolvés un objeto { extractions: [...] } con UNA entrada por cada artículo recibido. Cada entrada debe tener:
- articleId: el mismo id que viene en la entrada del input. NO inventes ids; NO omitas artículos.
- entities: lista de personas, organismos públicos, partidos políticos, lugares y empresas mencionados (mayúscula inicial). Hasta 20.
- keywords: 5–8 sustantivos clave en minúscula, sin acentos, en español. Sirven para agrupar artículos del mismo tema.
- summary: una frase neutra de máximo 280 caracteres que resuma el hecho principal.
- categoryHint: tópico evergreen aproximado en minúsculas (ej: "elecciones", "economia", "seguridad", "deportes", "cultura", "clima", "salud", "educacion", "internacional", "tecnologia", "sociedad", "politica") o null si no aplica claramente.

No inventes hechos que no estén en cada texto. No clasifiques por opinión, solo por tema.`;

interface ArticleForCategorize {
  id: number;
  headline: string;
  content: string;
}

function buildBatchedUserPrompt(articles: ArticleForCategorize[]): string {
  return JSON.stringify(
    articles.map((a) => ({
      articleId: a.id,
      headline: a.headline,
      content:
        a.content.length > MAX_CONTENT_CHARS
          ? a.content.slice(0, MAX_CONTENT_CHARS) + '...'
          : a.content,
    })),
    null,
    2,
  );
}

interface NewArticleRow {
  id: number;
  headline: string;
  content: string | null;
}

export interface CategorizeStats {
  total: number;
  ok: number;
  failed: number;
  skippedEmpty: number;
  batches: number;
  capHit: boolean;
}

export async function runCategorize(opts?: {
  limit?: number;
  providerName?: string;
}): Promise<CategorizeStats> {
  const provider = getProvider(opts?.providerName ?? config.llm.provider);
  const limit = opts?.limit ?? 200;
  const rows = getDb()
    .prepare<[number], NewArticleRow>(
      `SELECT id, headline, content FROM articles
       WHERE status = 'new'
       ORDER BY published_at DESC
       LIMIT ?`,
    )
    .all(limit);

  const updateOk = getDb().prepare(
    `UPDATE articles SET entities_json = ?, keywords_json = ?, summary = ?, status = 'categorized'
     WHERE id = ?`,
  );
  const updateFailed = getDb().prepare(`UPDATE articles SET status = 'failed' WHERE id = ?`);

  const stats: CategorizeStats = {
    total: rows.length,
    ok: 0,
    failed: 0,
    skippedEmpty: 0,
    batches: 0,
    capHit: false,
  };

  if (rows.length === 0) {
    console.log('[categorize] No new articles.');
    return stats;
  }

  // Pre-filter: articles with no usable content never get an LLM call. They
  // also wouldn't be useful as cluster input — drop them straight to failed.
  const usable: ArticleForCategorize[] = [];
  for (const row of rows) {
    if (!row.content || row.content.length < 50) {
      updateFailed.run(row.id);
      stats.skippedEmpty += 1;
      continue;
    }
    usable.push({ id: row.id, headline: row.headline, content: row.content });
  }

  if (usable.length === 0) {
    console.log(`[categorize] No usable articles (${stats.skippedEmpty} skipped empty).`);
    return stats;
  }

  const batches: ArticleForCategorize[][] = [];
  for (let i = 0; i < usable.length; i += CATEGORIZE_BATCH_SIZE) {
    batches.push(usable.slice(i, i + CATEGORIZE_BATCH_SIZE));
  }
  stats.batches = batches.length;

  console.log(
    `[categorize] ${usable.length} articles in ${batches.length} batches (size=${CATEGORIZE_BATCH_SIZE}) via ${provider.name} (model=${config.llm.modelCategorize})`,
  );

  const lim = pLimit(CATEGORIZE_BATCH_CONCURRENCY);
  await Promise.all(
    batches.map((batch) =>
      lim(async () => {
        if (stats.capHit) return; // earlier batch already hit the cap
        try {
          const { value } = await provider.generateJson({
            system: SYSTEM_PROMPT,
            user: buildBatchedUserPrompt(batch),
            schema: BatchedArticleExtractionSchema,
            model: config.llm.modelCategorize,
            // Per-article output is ~150 tokens; an 8-article batch lands well
            // under 1500. 2048 leaves headroom without paying for a misbehaved run.
            maxOutputTokens: 2048,
            temperature: 0,
          });
          const byId = new Map(value.extractions.map((e) => [e.articleId, e] as const));
          for (const article of batch) {
            const ex = byId.get(article.id);
            if (!ex) {
              // LLM dropped this article — let it retry on the next run.
              updateFailed.run(article.id);
              stats.failed += 1;
              continue;
            }
            updateOk.run(
              JSON.stringify(ex.entities),
              JSON.stringify(ex.keywords),
              ex.summary,
              article.id,
            );
            stats.ok += 1;
          }
        } catch (err) {
          if (err instanceof CostCapExceededError) {
            stats.capHit = true;
            console.warn(`[categorize] Cap hit, stopping: ${err.message}`);
            return; // don't mark batch as failed — just stop
          }
          for (const article of batch) updateFailed.run(article.id);
          stats.failed += batch.length;
          console.warn(
            `[categorize] Batch of ${batch.length} failed: ${(err as Error).message}`,
          );
        }
      }),
    ),
  );

  console.log(
    `[categorize] Done: ok=${stats.ok}, failed=${stats.failed}, skipped=${stats.skippedEmpty}, batches=${stats.batches}${stats.capHit ? ', CAP HIT' : ''}`,
  );
  return stats;
}

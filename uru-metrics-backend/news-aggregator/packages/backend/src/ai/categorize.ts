import pLimit from 'p-limit';
import { ArticleExtractionSchema } from '@uru/shared';
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { getProvider } from './provider.js';
import { CostCapExceededError } from './usage.js';

const CATEGORIZE_CONCURRENCY = 4;
const MAX_CONTENT_CHARS = 4_000;

// First line is read by StubProvider and (cheaply) by humans for grep-ability.
const SYSTEM_PROMPT = `[stage:categorize]
Sos editor de noticias uruguayo. Recibís un artículo (titular + cuerpo) y devolvés JSON estructurado para indexación. El JSON debe tener:
- entities: lista de personas, organismos públicos, partidos políticos, lugares y empresas mencionados (mayúscula inicial). Hasta 20.
- keywords: 5–8 sustantivos clave en minúscula, sin acentos, en español. Sirven para agrupar artículos del mismo tema.
- summary: una frase neutra de máximo 280 caracteres que resuma el hecho principal.
- categoryHint: tópico evergreen aproximado en minúsculas (ej: "elecciones", "economia", "seguridad", "deportes", "cultura", "clima", "salud", "educacion", "internacional", "tecnologia", "sociedad", "politica") o null si no aplica claramente.

No inventes hechos que no estén en el texto. No clasifiques por opinión, solo por tema.`;

function buildUserPrompt(args: { headline: string; content: string }): string {
  const trimmed = args.content.length > MAX_CONTENT_CHARS
    ? args.content.slice(0, MAX_CONTENT_CHARS) + '...'
    : args.content;
  return `Article: ${args.headline}\n\n${trimmed}`;
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

  const stats: CategorizeStats = { total: rows.length, ok: 0, failed: 0, skippedEmpty: 0, capHit: false };

  if (rows.length === 0) {
    console.log('[categorize] No new articles.');
    return stats;
  }

  console.log(
    `[categorize] Processing ${rows.length} articles via ${provider.name} (model=${config.llm.modelCategorize})`,
  );

  const lim = pLimit(CATEGORIZE_CONCURRENCY);
  await Promise.all(
    rows.map((row) =>
      lim(async () => {
        if (!row.content || row.content.length < 50) {
          updateFailed.run(row.id);
          stats.skippedEmpty += 1;
          return;
        }
        try {
          const { value } = await provider.generateJson({
            system: SYSTEM_PROMPT,
            user: buildUserPrompt({ headline: row.headline, content: row.content }),
            schema: ArticleExtractionSchema,
            model: config.llm.modelCategorize,
            maxOutputTokens: 800,
            temperature: 0,
          });
          updateOk.run(
            JSON.stringify(value.entities),
            JSON.stringify(value.keywords),
            value.summary,
            row.id,
          );
          stats.ok += 1;
        } catch (err) {
          if (err instanceof CostCapExceededError) {
            stats.capHit = true;
            console.warn(`[categorize] Cap hit, stopping: ${err.message}`);
            return; // don't mark as failed — just stop
          }
          stats.failed += 1;
          updateFailed.run(row.id);
          console.warn(`[categorize] Article ${row.id} failed: ${(err as Error).message}`);
        }
      }),
    ),
  );

  console.log(
    `[categorize] Done: ok=${stats.ok}, failed=${stats.failed}, skipped=${stats.skippedEmpty}${stats.capHit ? ', CAP HIT' : ''}`,
  );
  return stats;
}

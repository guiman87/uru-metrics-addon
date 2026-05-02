import { TopicSalienceSchema } from '@uru/shared';
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { getProvider } from './provider.js';
import { CostCapExceededError } from './usage.js';

const WINDOW_HOURS = 24;
const RECENCY_HALF_LIFE_HOURS = 6;

const SYSTEM_PROMPT = `[stage:salience]
Sos editor jefe de un agregador de noticias uruguayo. Recibís una lista de tópicos activos en las últimas 24 horas con su label, descripción y volumen (cantidad de artículos, cantidad de fuentes).

Para cada tópico devolvé un \"salience\" entre 0 y 1 que represente su relevancia para la opinión pública uruguaya:
- 1.0 = noticia política/económica nacional dominante, hecho de impacto masivo
- 0.7 = tema importante pero no dominante
- 0.5 = interés general
- 0.2 = nota de color, deportes/cultura no destacados
- 0.0 = clickbait o trivial

Devolvé { scores: [{ topicId, salience }, ...] } incluyendo TODOS los topicId recibidos.`;

interface TopicAggRow {
  topic_id: number;
  label: string;
  description: string | null;
  scope: string;
  source_count: number;
  article_count: number;
  most_recent: string;
  source_weight_avg: number;
}

export interface RankStats {
  topicsScored: number;
  capHit: boolean;
}

function recencyScore(mostRecentIso: string, now = Date.now()): number {
  const ageHours = Math.max(0, (now - new Date(mostRecentIso).getTime()) / (1000 * 60 * 60));
  return Math.exp(-(ageHours / RECENCY_HALF_LIFE_HOURS) * Math.LN2);
}

function volumeScore(articleCount: number, max: number): number {
  if (max <= 1) return 1;
  return Math.log(1 + articleCount) / Math.log(1 + max);
}

function diversityScore(sourceCount: number, totalActiveSources: number): number {
  if (totalActiveSources <= 0) return 0;
  return Math.min(1, sourceCount / totalActiveSources);
}

export async function runScore(opts?: { providerName?: string }): Promise<RankStats> {
  const stats: RankStats = { topicsScored: 0, capHit: false };
  const cutoff = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const totalActiveSources = (
    getDb()
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM sources WHERE active = 1`)
      .get() ?? { n: 1 }
  ).n;

  const rows = getDb()
    .prepare<[string], TopicAggRow>(
      `SELECT
         t.id              AS topic_id,
         t.label           AS label,
         t.description     AS description,
         t.scope           AS scope,
         COUNT(DISTINCT a.domain) AS source_count,
         COUNT(*)          AS article_count,
         MAX(a.published_at) AS most_recent,
         AVG(s.weight)     AS source_weight_avg
       FROM topics t
       JOIN article_topics at ON at.topic_id = t.id AND at.is_primary = 1
       JOIN articles a       ON a.id = at.article_id
       JOIN sources s        ON s.domain = a.domain
       WHERE a.published_at >= ?
         AND t.scope IN ('event','story')
       GROUP BY t.id
       ORDER BY article_count DESC`,
    )
    .all(cutoff);

  if (rows.length === 0) {
    console.log('[score] No topics with articles in last 24h.');
    return stats;
  }

  console.log(`[score] Scoring ${rows.length} topics over ${totalActiveSources} active sources.`);

  // LLM salience — one call for the whole set.
  const provider = getProvider(opts?.providerName ?? config.llm.provider);
  let salienceMap = new Map<number, number>();
  try {
    const userPayload = JSON.stringify(
      rows.map((r) => ({
        topicId: r.topic_id,
        label: r.label,
        description: r.description,
        scope: r.scope,
        articleCount: r.article_count,
        sourceCount: r.source_count,
      })),
      null,
      2,
    );
    const { value } = await provider.generateJson({
      system: SYSTEM_PROMPT,
      user: userPayload,
      schema: TopicSalienceSchema,
      model: config.llm.modelCluster, // use the smarter model — it's a single call
      maxOutputTokens: Math.max(512, rows.length * 40),
      temperature: 0,
    });
    salienceMap = new Map(value.scores.map((s) => [s.topicId, s.salience]));
  } catch (err) {
    if (err instanceof CostCapExceededError) {
      stats.capHit = true;
      console.warn(`[score] Cap hit, falling back to neutral salience: ${err.message}`);
    } else {
      console.warn(`[score] Salience call failed, defaulting to 0.5: ${(err as Error).message}`);
    }
  }

  const maxArticles = Math.max(...rows.map((r) => r.article_count), 1);
  const computedAt = new Date().toISOString();

  const insert = getDb().prepare(
    `INSERT OR REPLACE INTO topic_scores
     (topic_id, computed_at, window_hours, source_count, article_count, recency_score, salience_score, importance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const tx = getDb().transaction(() => {
    for (const r of rows) {
      const recency = recencyScore(r.most_recent);
      const volume = volumeScore(r.article_count, maxArticles);
      const diversity = diversityScore(r.source_count, totalActiveSources);
      const salience = salienceMap.get(r.topic_id) ?? 0.5;
      const sourceWeight = Math.min(1, Math.max(0, r.source_weight_avg ?? 1));

      const importance =
        0.35 * diversity +
        0.25 * recency +
        0.2 * volume +
        0.15 * salience +
        0.05 * sourceWeight;

      insert.run(
        r.topic_id,
        computedAt,
        WINDOW_HOURS,
        r.source_count,
        r.article_count,
        recency,
        salience,
        importance,
      );
      stats.topicsScored += 1;
    }
  });
  tx();

  console.log(`[score] Wrote ${stats.topicsScored} topic_scores rows.`);
  return stats;
}

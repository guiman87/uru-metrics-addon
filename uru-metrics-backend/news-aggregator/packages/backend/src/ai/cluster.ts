import { ClusteringResponseSchema } from '@uru/shared';
import type { Topic } from '@uru/shared';
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { getProvider } from './provider.js';
import {
  createTopic,
  findTopicById,
  findTopicByAlias,
  getActiveCandidateTopics,
  getEvergreenTopics,
  linkArticleToTopic,
  pickEvergreenForKeywords,
  recordTopicAlias,
  touchTopic,
} from './topics.js';
import { CostCapExceededError } from './usage.js';

const BATCH_SIZE = 20; // articles per LLM call — keeps prompts under ~10k tokens
const ASSIGNED_LOOKBACK_DAYS = 7;

const SYSTEM_PROMPT = `[stage:cluster]
Sos editor jefe de un agregador de noticias uruguayo. Tu tarea es agrupar nuevos artículos en tópicos.

Recibís:
- "newArticles": artículos recién categorizados, con id, titular, resumen y keywords.
- "candidateTopics": tópicos activos de los últimos 7 días que podrían contener nuevos artículos. Cada uno tiene id, slug, label, descripción, scope (event|story) y keywords.
- "evergreens": tópicos perennes (verticales) como "elecciones", "economia". Tienen id, slug, label, descripción, keywords. SIEMPRE asigná un parentTopicId que apunte a un tópico evergreen o event — NUNCA dejes un tópico nuevo huérfano.

Reglas:
1. Para cada artículo devolvé un objeto { articleId, topicId, newTopic, confidence }.
2. Si el artículo encaja en un candidateTopic existente, devolvé topicId = ese id (newTopic = null).
3. Si NO encaja, creá un newTopic con scope "event" (campaña/ciclo de meses) o "story" (hecho puntual de horas/días). El parentTopicId debe ser un id de evergreen o de event existente. Si el artículo es claramente sobre la temática de una vertical evergreen pero no hay event activo, parentTopicId = id de la evergreen. Las "story" usualmente cuelgan de una "event" si existe; si no, directamente de la evergreen.
4. Si dos artículos hablan del MISMO hecho aunque desde ángulos distintos, asignales el mismo topicId/newTopic.
5. confidence: número 0..1.
6. NUNCA dejes parentTopicId vacío en newTopic.
7. Si el tema es excesivamente menor (clickbait, faits divers sin relevancia pública), igual asigná, pero podés bajar confidence.

Devolvé un objeto { assignments: [...] } con un assignment por artículo. NO inventes ids.`;

interface ArticleForClustering {
  id: number;
  headline: string;
  domain: string;
  summary: string | null;
  keywords: string[];
}

interface ClusterStats {
  batches: number;
  articlesAssigned: number;
  articlesFailed: number;
  topicsCreated: number;
  topicsReused: number;
  capHit: boolean;
}

function loadCategorizedArticles(daysBack: number): ArticleForClustering[] {
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  // Only articles that don't already have a primary topic.
  return getDb()
    .prepare<[string], { id: number; headline: string; domain: string; summary: string | null; keywords_json: string | null }>(
      `SELECT a.id, a.headline, a.domain, a.summary, a.keywords_json
       FROM articles a
       LEFT JOIN article_topics at ON at.article_id = a.id AND at.is_primary = 1
       WHERE a.status = 'categorized'
         AND a.published_at >= ?
         AND at.article_id IS NULL`,
    )
    .all(cutoff)
    .map((r) => ({
      id: r.id,
      headline: r.headline,
      domain: r.domain,
      summary: r.summary,
      keywords: r.keywords_json ? (JSON.parse(r.keywords_json) as string[]) : [],
    }));
}

interface PromptTopic {
  id: number;
  slug: string;
  label: string;
  description: string | null;
  scope: string;
  keywords: string[];
}

function buildUserPrompt(args: {
  newArticles: ArticleForClustering[];
  candidates: Topic[];
  evergreens: Topic[];
}): string {
  const newArticles = args.newArticles.map((a) => ({
    articleId: a.id,
    headline: a.headline,
    source: a.domain,
    summary: a.summary ?? '',
    keywords: a.keywords,
  }));
  const toPrompt = (t: Topic): PromptTopic => ({
    id: t.id,
    slug: t.slug,
    label: t.label,
    description: t.description,
    scope: t.scope,
    keywords: t.keywords,
  });
  return JSON.stringify(
    {
      newArticles,
      candidateTopics: args.candidates.map(toPrompt),
      evergreens: args.evergreens.map(toPrompt),
    },
    null,
    2,
  );
}

/**
 * Resolve a parentTopicId returned by the LLM. Falls back gracefully:
 *  - exact id match → use it
 *  - sentinel -1 (Stub provider) → pickEvergreenForKeywords
 *  - unknown/missing → pickEvergreenForKeywords; last resort = first evergreen
 */
function resolveParentTopicId(args: {
  parentTopicId: number;
  evergreens: Topic[];
  keywords: string[];
}): number {
  if (args.parentTopicId > 0) {
    const known = findTopicById(args.parentTopicId);
    if (known) return known.id;
  }
  const guess = pickEvergreenForKeywords(args.keywords);
  if (guess) return guess.id;
  return args.evergreens[0]?.id ?? 0;
}

export async function runCluster(opts?: { providerName?: string }): Promise<ClusterStats> {
  const stats: ClusterStats = {
    batches: 0,
    articlesAssigned: 0,
    articlesFailed: 0,
    topicsCreated: 0,
    topicsReused: 0,
    capHit: false,
  };

  const articles = loadCategorizedArticles(ASSIGNED_LOOKBACK_DAYS);
  if (articles.length === 0) {
    console.log('[cluster] No categorized-but-unclustered articles.');
    return stats;
  }

  const evergreens = getEvergreenTopics();
  if (evergreens.length === 0) {
    throw new Error('[cluster] No evergreen topics seeded — run npm run seed:evergreen first.');
  }

  const provider = getProvider(opts?.providerName ?? config.llm.provider);
  console.log(
    `[cluster] ${articles.length} articles to assign, ${evergreens.length} evergreens, batch=${BATCH_SIZE}, provider=${provider.name}`,
  );

  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    const candidates = getActiveCandidateTopics(ASSIGNED_LOOKBACK_DAYS);

    let response;
    try {
      const result = await provider.generateJson({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt({ newArticles: batch, candidates, evergreens }),
        schema: ClusteringResponseSchema,
        model: config.llm.modelCluster,
        maxOutputTokens: 2048,
        temperature: 0,
      });
      response = result.value;
    } catch (err) {
      if (err instanceof CostCapExceededError) {
        stats.capHit = true;
        console.warn(`[cluster] Cap hit, stopping: ${err.message}`);
        break;
      }
      stats.articlesFailed += batch.length;
      console.warn(`[cluster] Batch ${stats.batches + 1} failed: ${(err as Error).message}`);
      stats.batches += 1;
      continue;
    }
    stats.batches += 1;

    for (const a of response.assignments) {
      const article = batch.find((x) => x.id === a.articleId);
      if (!article) continue;

      let topicId: number | null = null;

      if (a.topicId != null) {
        // Reuse existing
        const t = findTopicById(a.topicId);
        if (t) {
          topicId = t.id;
          touchTopic(t.id);
          stats.topicsReused += 1;
        }
      }

      if (topicId == null && a.newTopic) {
        // Either truly new, or already exists under a previous slug — check
        // alias first to avoid duplicate creates from LLM rephrasing.
        const aliasHit = findTopicByAlias(a.newTopic.label);
        if (aliasHit) {
          topicId = aliasHit.id;
          touchTopic(aliasHit.id);
          stats.topicsReused += 1;
        } else {
          const parentId = resolveParentTopicId({
            parentTopicId: a.newTopic.parentTopicId,
            evergreens,
            keywords: a.newTopic.keywords,
          });
          const created = createTopic({
            label: a.newTopic.label,
            description: a.newTopic.description,
            keywords: a.newTopic.keywords,
            parentTopicId: parentId,
            scope: a.newTopic.scope,
          });
          recordTopicAlias(a.newTopic.label, created.id);
          topicId = created.id;
          stats.topicsCreated += 1;
        }
      }

      if (topicId == null) {
        // Last resort: park under the keyword-best-fit evergreen.
        const fallback = pickEvergreenForKeywords(article.keywords) ?? evergreens[0];
        topicId = fallback?.id ?? null;
      }

      if (topicId != null) {
        linkArticleToTopic({
          articleId: article.id,
          topicId,
          confidence: a.confidence,
          isPrimary: true,
        });
        stats.articlesAssigned += 1;
      } else {
        stats.articlesFailed += 1;
      }
    }

    console.log(
      `[cluster] Batch ${stats.batches}: assigned=${stats.articlesAssigned}, created=${stats.topicsCreated}, reused=${stats.topicsReused}`,
    );
  }

  console.log(
    `[cluster] Done: assigned=${stats.articlesAssigned}, failed=${stats.articlesFailed}, topics created=${stats.topicsCreated}, reused=${stats.topicsReused}${stats.capHit ? ', CAP HIT' : ''}`,
  );
  return stats;
}

import { z } from 'zod';

// ─── Sources ──────────────────────────────────────────────────────────────

export type BiasLabel = 'left' | 'center' | 'right';
export type Fetcher = 'cheerio' | 'playwright';

export interface Source {
  domain: string;
  displayName: string;
  seedUrls: string[];
  weight: number;
  biasLabel: BiasLabel | null;
  paywalled: boolean;
  active: boolean;
  fetcher: Fetcher;
  lastCrawledAt: string | null;
}

// ─── Articles ─────────────────────────────────────────────────────────────

export type ArticleStatus = 'new' | 'categorized' | 'failed';

export interface Article {
  id: number;
  url: string;
  urlCanonical: string | null;
  domain: string;
  headline: string;
  summary: string | null;
  content: string | null;
  imageUrl: string | null;
  publishedAt: string; // ISO-8601 UTC
  scrapedAt: string;
  lang: string;
  entities: string[];
  keywords: string[];
  status: ArticleStatus;
}

// What the crawler returns before storage
export interface ScrapedArticle {
  url: string;
  domain: string;
  headline: string;
  content: string;
  imageUrl: string | null;
  publishedAt: string;
}

// ─── Topics ───────────────────────────────────────────────────────────────

export type TopicScope = 'evergreen' | 'event' | 'story';
export type TopicStatus = 'active' | 'merged' | 'archived';

// Set on evergreens that were promoted from a frequently-mentioned named
// entity (Peñarol → 'team', Frente Amplio → 'party', Lacalle Pou →
// 'person', ANTEL → 'org', Maldonado → 'place'). NULL on the 12 seeded
// vertical evergreens like Política / Deportes / Economía.
export type EntityType = 'person' | 'party' | 'org' | 'team' | 'place';

export interface Topic {
  id: number;
  slug: string;
  label: string;
  description: string | null;
  keywords: string[];
  parentTopicId: number | null;
  scope: TopicScope;
  firstSeenAt: string;
  lastSeenAt: string;
  status: TopicStatus;
  entityType: EntityType | null;
}

export interface TopicWithBreadcrumbs extends Topic {
  breadcrumbs: Array<Pick<Topic, 'id' | 'slug' | 'label' | 'scope'>>;
}

export interface TopicScore {
  topicId: number;
  computedAt: string;
  windowHours: number;
  sourceCount: number;
  articleCount: number;
  recencyScore: number;
  salienceScore: number;
  importance: number;
}

// ─── API responses ────────────────────────────────────────────────────────

export interface HealthResponse {
  ok: boolean;
  db: 'ok' | 'error';
  lastIngestAt: string | null;
}

// Editorial coverage summary for a topic. Describes how the press is
// behaving (how many distinct outlets covered it out of the active set),
// not which side they're on. The label is intentionally non-political —
// see `feedback_no_political_bias_labels` memory: bias data drives the
// computation server-side, but the label here is purely count-based.
export interface Cobertura {
  /**
   * 'amplia' when count/total >= 0.7 (broad pickup), 'acotada' when
   * count <= 3 (narrow pickup), 'tipica' otherwise. The frontend uses
   * 'tipica' to suppress the badge entirely so it only appears when
   * meaningful.
   */
  label: 'amplia' | 'tipica' | 'acotada';
  /** Distinct outlets covering the topic in the current 24h window. */
  count: number;
  /** Total active outlets in the system at the time of computation. */
  total: number;
}

// Importance change since the last comparison point (~6h ago). `null`
// when there's no prior score to compare against (new topic, missing
// snapshot, etc.) so the UI can hide the indicator gracefully.
export interface TopicTrend {
  /**
   * 'up' when deltaPct >= +5, 'down' when deltaPct <= -5, 'flat'
   * otherwise. The frontend uses 'flat' as a hint to render nothing.
   */
  direction: 'up' | 'down' | 'flat';
  /** Signed percentage change vs the prior score (0-rounded). */
  deltaPct: number;
}

export interface TopicListItem {
  id: number;
  slug: string;
  label: string;
  scope: TopicScope;
  importance: number;
  sourceCount: number;
  articleCount: number;
  cobertura: Cobertura;
  trend: TopicTrend | null;
  breadcrumbs: Array<Pick<Topic, 'id' | 'slug' | 'label' | 'scope'>>;
  topArticles: Array<{
    id: number;
    domain: string;
    headline: string;
    url: string;
    publishedAt: string;
    imageUrl: string | null;
  }>;
}

export interface TopicListResponse {
  computedAt: string;
  windowHours: number;
  topics: TopicListItem[];
}

// Article snippet shape returned inside a topic detail. Lighter than
// the full Article (no full content, no entities/keywords), but carries
// the LLM summary so the topic page can render it under the headline.
export interface TopicDetailArticle {
  id: number;
  domain: string;
  headline: string;
  summary: string | null;
  url: string;
  publishedAt: string;
  imageUrl: string | null;
}

export interface TopicDetailResponse {
  topic: TopicWithBreadcrumbs & {
    importance: number;
    cobertura: Cobertura;
    trend: TopicTrend | null;
  };
  descendants: Array<{
    id: number;
    slug: string;
    label: string;
    scope: TopicScope;
    articleCount: number;
  }>;
  articles: TopicDetailArticle[];
}

export interface ArticleListResponse {
  articles: Array<Pick<Article, 'id' | 'url' | 'domain' | 'headline' | 'summary' | 'imageUrl' | 'publishedAt' | 'scrapedAt' | 'status'>>;
}

// Result envelope for /api/search?q=…&limit=&domain=&since=
// Hits are bm25-ranked across articles_fts (headline + summary + entities
// + content). Same article shape as TopicDetailArticle so the frontend
// can reuse list-rendering components.
export interface SearchResponse {
  query: string;
  count: number;
  articles: TopicDetailArticle[];
}

// ─── LLM provider ─────────────────────────────────────────────────────────

export interface LlmUsage {
  input: number; // uncached input tokens billed at base rate
  output: number;
  cacheCreationInput?: number; // tokens written to cache, billed at 1.25× input rate
  cacheReadInput?: number; // tokens read from cache, billed at 0.1× input rate
  costUsd: number;
}

export interface LlmCallArgs<T> {
  system: string;
  user: string;
  schema: z.ZodSchema<T>;
  maxOutputTokens?: number;
  temperature?: number;
  cacheKey?: string; // Anthropic prompt caching tag
  model?: string; // override default model for this call
}

export type LlmProviderName = 'claude' | 'gemini' | 'openai' | 'stub';

export interface LlmProvider {
  name: LlmProviderName;
  generateJson<T>(args: LlmCallArgs<T>): Promise<{ value: T; usage: LlmUsage }>;
}

// ─── AI pipeline shapes ───────────────────────────────────────────────────

// Batched extraction: the LLM is sent N articles per call and must return one
// entry per articleId. `articleId` ties each result back to its source row.
export const BatchedArticleExtractionSchema = z.object({
  extractions: z.array(
    z.object({
      articleId: z.number(),
      entities: z.array(z.string()).max(50),
      keywords: z.array(z.string()).min(3).max(15),
      summary: z.string().max(400),
      categoryHint: z.string().nullable().optional(),
    }),
  ),
});
export type BatchedArticleExtraction = z.infer<typeof BatchedArticleExtractionSchema>;

export const ClusteringAssignmentSchema = z.object({
  articleId: z.number(),
  topicId: z.number().nullable(),
  newTopic: z
    .object({
      label: z.string(),
      keywords: z.array(z.string()).min(3).max(10),
      description: z.string().max(400),
      scope: z.enum(['event', 'story']),
      parentTopicId: z.number(), // never orphan; must point to evergreen or event
    })
    .nullable()
    .optional(),
  confidence: z.number().min(0).max(1),
});
export type ClusteringAssignment = z.infer<typeof ClusteringAssignmentSchema>;

export const ClusteringResponseSchema = z.object({
  assignments: z.array(ClusteringAssignmentSchema),
});
export type ClusteringResponse = z.infer<typeof ClusteringResponseSchema>;

export const TopicSalienceSchema = z.object({
  scores: z.array(
    z.object({
      topicId: z.number(),
      salience: z.number().min(0).max(1),
    }),
  ),
});
export type TopicSalience = z.infer<typeof TopicSalienceSchema>;

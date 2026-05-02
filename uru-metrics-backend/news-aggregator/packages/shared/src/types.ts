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

export interface TopicListItem {
  id: number;
  slug: string;
  label: string;
  scope: TopicScope;
  importance: number;
  sourceCount: number;
  articleCount: number;
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

export interface ArticleListResponse {
  articles: Array<Pick<Article, 'id' | 'url' | 'domain' | 'headline' | 'summary' | 'imageUrl' | 'publishedAt' | 'scrapedAt' | 'status'>>;
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

export const ArticleExtractionSchema = z.object({
  entities: z.array(z.string()).max(50),
  keywords: z.array(z.string()).min(3).max(15),
  summary: z.string().max(400),
  categoryHint: z.string().nullable().optional(),
});
export type ArticleExtraction = z.infer<typeof ArticleExtractionSchema>;

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

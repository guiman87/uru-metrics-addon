import type { LlmCallArgs, LlmProvider, LlmUsage } from '@uru/shared';
import { recordUsage } from './usage.js';

// The Stub provider returns deterministic, schema-shaped responses without
// calling any external API. Use it to exercise the pipeline locally without
// burning API credit. It keys its behavior off the system prompt's first
// line, which our prompt builders set to a stable identifier.
//
// Recognized markers (the prompts include these in the very first line):
//   [stage:categorize]  → ArticleExtraction
//   [stage:cluster]     → ClusteringResponse
//   [stage:salience]    → TopicSalience

const STOPWORDS = new Set([
  'que', 'con', 'por', 'para', 'una', 'unos', 'unas', 'los', 'las', 'del',
  'sus', 'sin', 'sobre', 'como', 'pero', 'más', 'mas', 'este', 'esta',
  'estos', 'estas', 'desde', 'hasta', 'ante', 'entre', 'según', 'segun',
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was', 'were',
]);

function topKeywords(text: string, k = 6): string[] {
  const counts = new Map<string, number>();
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 4 && !STOPWORDS.has(w));
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([w]) => w);
}

function pickEvergreenParent(keywords: string[]): { id: number; slug: string } | null {
  // The cluster-stage user message embeds the evergreen list as JSON. The
  // stub can't see it directly via the schema interface, so we just pick
  // the first keyword and return a synthetic parent — the cluster code in
  // the pipeline will resolve unknown parentTopicIds to the closest
  // evergreen by slug match (see cluster.ts). For pure stub runs we use
  // sentinel id -1; cluster.ts treats that as "look up by keyword".
  if (keywords.length === 0) return null;
  return { id: -1, slug: 'general' };
}

function fakeCategorize(user: string): {
  entities: string[];
  keywords: string[];
  summary: string;
  categoryHint: string | null;
} {
  // The user message follows the shape "Article: <headline>\n\n<content>".
  // We just want stable, schema-valid output.
  const firstLine = user.split('\n').find((l) => l.trim().length > 0) ?? '';
  const headline = firstLine.replace(/^Article:\s*/i, '').slice(0, 200);
  const keywords = topKeywords(`${headline} ${user.slice(0, 1500)}`, 6);
  return {
    entities: keywords.slice(0, 3).map((k) => k.charAt(0).toUpperCase() + k.slice(1)),
    keywords,
    summary: headline.slice(0, 280) || 'Resumen no disponible (stub).',
    categoryHint: null,
  };
}

function fakeCluster(user: string): {
  assignments: Array<{
    articleId: number;
    topicId: number | null;
    newTopic?: {
      label: string;
      keywords: string[];
      description: string;
      scope: 'event' | 'story';
      parentTopicId: number;
    } | null;
    confidence: number;
  }>;
} {
  // Find every articleId mentioned in the user prompt — we round-trip them
  // as fresh-topic assignments. The cluster.ts integration code handles
  // sentinel parentTopicId (-1) by mapping to whichever evergreen has the
  // most overlapping keywords.
  const ids = [...user.matchAll(/"articleId"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
  const assignments = ids.map((id) => ({
    articleId: id,
    topicId: null,
    newTopic: {
      label: `Tópico stub #${id}`,
      keywords: ['stub', 'general', `articulo-${id}`],
      description: 'Tópico generado por el proveedor stub.',
      scope: 'story' as const,
      parentTopicId: -1,
    },
    confidence: 0.5,
  }));
  return { assignments };
}

function fakeSalience(user: string): {
  scores: Array<{ topicId: number; salience: number }>;
} {
  const ids = [...user.matchAll(/"topicId"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
  // Deterministic but varied: cycle through 0.2/0.4/0.6/0.8.
  return {
    scores: ids.map((id, i) => ({ topicId: id, salience: 0.2 + (i % 4) * 0.2 })),
  };
}

export class StubProvider implements LlmProvider {
  readonly name = 'stub' as const;

  async generateJson<T>(args: LlmCallArgs<T>): Promise<{ value: T; usage: LlmUsage }> {
    const marker = args.system.split('\n')[0]?.toLowerCase() ?? '';
    let raw: unknown;
    if (marker.includes('[stage:categorize]')) raw = fakeCategorize(args.user);
    else if (marker.includes('[stage:cluster]')) raw = fakeCluster(args.user);
    else if (marker.includes('[stage:salience]')) raw = fakeSalience(args.user);
    else throw new Error(`StubProvider: unknown stage marker in system prompt: "${marker}"`);

    const value = args.schema.parse(raw);
    const inputTok = Math.ceil((args.system.length + args.user.length) / 4);
    const outputTok = Math.ceil(JSON.stringify(raw).length / 4);
    const { costUsd } = recordUsage({
      provider: 'stub',
      model: 'stub-v1',
      inputTok,
      outputTok,
    });
    // Suppress the dummy keyword to satisfy the unused-import linter.
    void pickEvergreenParent;
    return { value, usage: { input: inputTok, output: outputTok, costUsd } };
  }
}

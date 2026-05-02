import crypto from 'node:crypto';
import slugify from 'slugify';
import type { Topic, TopicScope } from '@uru/shared';
import { getDb } from '../db/client.js';

// Strip accents, lowercase, drop punctuation. Two LLM-rephrased keyword sets
// that mean the same thing should produce the same canonical sequence.
export function canonicalizeKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keywords) {
    const norm = raw
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim();
    if (!norm || norm.length < 2) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  out.sort();
  return out;
}

function shortHashOf(canonical: string[]): string {
  const h = crypto.createHash('sha1').update(canonical.join('|')).digest('hex');
  return h.slice(0, 6);
}

/**
 * Build a stable, SEO-friendly slug for a topic.
 * - evergreen: just slugify(label) — these are seeded with curated names.
 * - event/story: slugify(label) + 6-char keyword-set hash, so the same topic
 *   gets the same slug across runs even if the LLM rephrases the label.
 */
export function buildSlug(label: string, keywords: string[], scope: TopicScope): string {
  const base = slugify(label, { lower: true, strict: true, trim: true }) || 'topic';
  if (scope === 'evergreen') return base;
  const canonical = canonicalizeKeywords(keywords);
  return `${base}-${shortHashOf(canonical)}`;
}

interface TopicRow {
  id: number;
  slug: string;
  label: string;
  description: string | null;
  keywords_json: string;
  parent_topic_id: number | null;
  scope: TopicScope;
  first_seen_at: string;
  last_seen_at: string;
  status: string;
}

function rowToTopic(r: TopicRow): Topic {
  return {
    id: r.id,
    slug: r.slug,
    label: r.label,
    description: r.description,
    keywords: JSON.parse(r.keywords_json) as string[],
    parentTopicId: r.parent_topic_id,
    scope: r.scope,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    status: r.status as Topic['status'],
  };
}

export function findTopicBySlug(slug: string): Topic | null {
  const r = getDb()
    .prepare<[string], TopicRow>('SELECT * FROM topics WHERE slug = ?')
    .get(slug);
  return r ? rowToTopic(r) : null;
}

export function findTopicById(id: number): Topic | null {
  const r = getDb()
    .prepare<[number], TopicRow>('SELECT * FROM topics WHERE id = ?')
    .get(id);
  return r ? rowToTopic(r) : null;
}

export function getEvergreenTopics(): Topic[] {
  return getDb()
    .prepare<[], TopicRow>(
      `SELECT * FROM topics WHERE scope = 'evergreen' AND status = 'active' ORDER BY label`,
    )
    .all()
    .map(rowToTopic);
}

export function getActiveCandidateTopics(daysBack = 7): Topic[] {
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  return getDb()
    .prepare<[string], TopicRow>(
      `SELECT * FROM topics
       WHERE status = 'active' AND scope IN ('event','story') AND last_seen_at >= ?
       ORDER BY last_seen_at DESC`,
    )
    .all(cutoff)
    .map(rowToTopic);
}

export interface CreateTopicArgs {
  label: string;
  description: string | null;
  keywords: string[];
  parentTopicId: number | null;
  scope: TopicScope;
}

export function createTopic(args: CreateTopicArgs): Topic {
  const now = new Date().toISOString();
  const slug = buildSlug(args.label, args.keywords, args.scope);
  // If slug collides (same canonical keywords reused across runs) reuse it.
  const existing = findTopicBySlug(slug);
  if (existing) {
    touchTopic(existing.id);
    return existing;
  }
  const info = getDb()
    .prepare(
      `INSERT INTO topics
       (slug, label, description, keywords_json, parent_topic_id, scope, first_seen_at, last_seen_at, status)
       VALUES (@slug, @label, @description, @keywords_json, @parent_topic_id, @scope, @first_seen_at, @last_seen_at, 'active')`,
    )
    .run({
      slug,
      label: args.label,
      description: args.description,
      keywords_json: JSON.stringify(canonicalizeKeywords(args.keywords)),
      parent_topic_id: args.parentTopicId,
      scope: args.scope,
      first_seen_at: now,
      last_seen_at: now,
    });
  return findTopicById(Number(info.lastInsertRowid))!;
}

export function touchTopic(id: number): void {
  getDb()
    .prepare(`UPDATE topics SET last_seen_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

export function linkArticleToTopic(args: {
  articleId: number;
  topicId: number;
  confidence: number;
  isPrimary: boolean;
}): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO article_topics (article_id, topic_id, confidence, is_primary)
       VALUES (?, ?, ?, ?)`,
    )
    .run(args.articleId, args.topicId, args.confidence, args.isPrimary ? 1 : 0);
}

export function recordTopicAlias(alias: string, topicId: number): void {
  if (!alias) return;
  getDb()
    .prepare(`INSERT OR IGNORE INTO topic_aliases (alias, topic_id) VALUES (?, ?)`)
    .run(alias.toLowerCase(), topicId);
}

export function findTopicByAlias(alias: string): Topic | null {
  const r = getDb()
    .prepare<[string], { topic_id: number }>(
      `SELECT topic_id FROM topic_aliases WHERE alias = ?`,
    )
    .get(alias.toLowerCase());
  return r ? findTopicById(r.topic_id) : null;
}

/** Pick the evergreen topic whose canonical keyword set best overlaps. */
export function pickEvergreenForKeywords(keywords: string[]): Topic | null {
  const canonical = new Set(canonicalizeKeywords(keywords));
  if (canonical.size === 0) return null;
  let best: { topic: Topic; score: number } | null = null;
  for (const topic of getEvergreenTopics()) {
    const ev = canonicalizeKeywords(topic.keywords);
    let score = 0;
    for (const k of ev) if (canonical.has(k)) score += 1;
    if (!best || score > best.score) best = { topic, score };
  }
  return best && best.score > 0 ? best.topic : null;
}

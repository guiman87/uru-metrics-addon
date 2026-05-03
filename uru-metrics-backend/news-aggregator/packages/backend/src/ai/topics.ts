import crypto from 'node:crypto';
import slugify from 'slugify';
import type { EntityType, Topic, TopicScope } from '@uru/shared';
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

/** slugify the label without any suffix. Used as the *preferred* clean slug. */
export function baseSlugFor(label: string): string {
  return slugify(label, { lower: true, strict: true, trim: true }) || 'topic';
}

/** Compute the canonical-keyword 6-char hash for a topic. */
export function canonicalHashFor(keywords: string[]): string {
  return shortHashOf(canonicalizeKeywords(keywords));
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
  entity_type: string | null;
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
    entityType: (r.entity_type as EntityType | null) ?? null,
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

// Just the evergreens that were promoted from named entities (Peñarol,
// Frente Amplio, Lacalle Pou, …). Used by the cluster step's secondary
// pass to detect article ↔ entity links.
export function getEntityEvergreens(): Topic[] {
  return getDb()
    .prepare<[], TopicRow>(
      `SELECT * FROM topics
       WHERE scope = 'evergreen' AND status = 'active' AND entity_type IS NOT NULL
       ORDER BY label`,
    )
    .all()
    .map(rowToTopic);
}

// All registered aliases for a given topic — used to match articles
// against alternative casings/variants the scrapers may emit.
export function getAliasesForTopic(topicId: number): string[] {
  return getDb()
    .prepare<[number], { alias: string }>(
      `SELECT alias FROM topic_aliases WHERE topic_id = ?`,
    )
    .all(topicId)
    .map((r) => r.alias);
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

/**
 * Create-or-reuse a topic. Slugs are clean by default (just slugify(label));
 * a 6-char hex suffix is appended only when a different topic already owns
 * the clean slug. Identity across runs is preserved via canonical-keyword
 * hash aliases stored in topic_aliases under the prefix "hash:".
 *
 * Lookup order:
 *   1. By "hash:<canonical>" alias — same canonical keywords as before.
 *   2. By legacy "<base>-<hash>" slug — backfills the alias for next time
 *      so old hash-suffixed topics created before this change still work.
 *   3. By bare base slug, only if scope is evergreen OR the hash matches
 *      (defends against incidental same-keyword topics).
 *   4. Fall through to insert. Use bare slug if free, else "<base>-<hash>".
 */
export function createTopic(args: CreateTopicArgs): Topic {
  const now = new Date().toISOString();
  const canonical = canonicalizeKeywords(args.keywords);
  const hash = shortHashOf(canonical);
  const hashAlias = `hash:${hash}`;
  const base = baseSlugFor(args.label);
  const legacySlug = `${base}-${hash}`;

  // 1. Same canonical-keyword set seen before → it's the same topic.
  const existingByHash = findTopicByAlias(hashAlias);
  if (existingByHash) {
    touchTopic(existingByHash.id);
    return existingByHash;
  }

  // 2. Pre-migration topics carried the hash in their slug. Re-discover
  //    them and lazily backfill the alias.
  if (args.scope !== 'evergreen') {
    const existingByLegacy = findTopicBySlug(legacySlug);
    if (existingByLegacy) {
      recordTopicAlias(hashAlias, existingByLegacy.id);
      touchTopic(existingByLegacy.id);
      return existingByLegacy;
    }
  }

  // 3. Pick the slug. Prefer the clean base; if a different topic already
  //    owns it (slugify collision), fall back to the hash-suffixed form.
  let slug = base;
  if (args.scope !== 'evergreen') {
    const collision = findTopicBySlug(base);
    if (collision) slug = legacySlug;
  } else {
    // Evergreens: bare slug. If something already owns it (shouldn't happen
    // with curated seeds, but defend anyway), reuse rather than collide.
    const collision = findTopicBySlug(base);
    if (collision) {
      touchTopic(collision.id);
      return collision;
    }
  }

  // 4. Insert.
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
      keywords_json: JSON.stringify(canonical),
      parent_topic_id: args.parentTopicId,
      scope: args.scope,
      first_seen_at: now,
      last_seen_at: now,
    });
  const newId = Number(info.lastInsertRowid);
  recordTopicAlias(hashAlias, newId);
  return findTopicById(newId)!;
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

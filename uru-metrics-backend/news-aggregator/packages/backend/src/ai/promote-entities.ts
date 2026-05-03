// Phase 2: LLM-driven promotion of scanned entity candidates into
// first-class evergreen topics. Inputs come from scripts/scan-entities.ts;
// outputs land as scope='evergreen' rows with entity_type set, parented
// under one of the existing seeded verticals.

import { z } from 'zod';
import slugify from 'slugify';
import type { EntityType, LlmProvider, Topic } from '@uru/shared';
import { getDb } from '../db/client.js';
import { canonicalizeKeywords, findTopicBySlug, getEvergreenTopics, recordTopicAlias } from './topics.js';

export const ENTITY_TYPES = ['person', 'party', 'org', 'team', 'place'] as const;

export interface ScanCandidate {
  candidateLabel: string;
  normalizedLabel: string;
  mentionCount: number;
  sourceCount: number;
  sourceDomains: string[];
  sampleHeadlines: string[];
}

const PromoteAssignmentSchema = z.object({
  normalizedLabel: z.string(),
  include: z.boolean(),
  canonicalLabel: z.string().min(1).max(120),
  slug: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  entityType: z.enum(ENTITY_TYPES),
  parentSlug: z.string().min(1),
  description: z.string().min(1).max(400),
  keywords: z.array(z.string().min(2).max(40)).min(2).max(8),
});

export const PromoteResponseSchema = z.object({
  assignments: z.array(PromoteAssignmentSchema),
});
export type PromoteAssignment = z.infer<typeof PromoteAssignmentSchema>;

const SYSTEM_PROMPT = `[stage:promote-entity]
Sos editor de un agregador de noticias uruguayo. Te llegan candidatos a tópicos perennes de entidad: personas, partidos políticos, organizaciones, clubes deportivos o lugares uruguayos extraídos de las noticias de los últimos 90 días.

Para cada candidato, devolvé un objeto:
1. normalizedLabel: copialo igual al candidato (es la clave que usamos del lado nuestro).
2. include: true si esto es una entidad uruguaya con cobertura sostenida que merece página propia. false para ruido — eventos puntuales, fechas, conceptos abstractos, frases que no son entidades, o cosas que ya existen como vertical perenne.
3. canonicalLabel: forma canónica preferida del nombre (ej. "Peñarol" no "C.A. Peñarol", "Frente Amplio" no "FA").
4. slug: minúsculas, sin acentos, separadas por guiones, sólo a-z0-9 (ej. "lacalle-pou", "frente-amplio", "penarol").
5. entityType: uno de "person" | "party" | "org" | "team" | "place".
6. parentSlug: el slug de UNA de las verticales perennes que te paso. Nunca inventes una.
7. description: 1 a 2 oraciones cortas en español describiendo qué/quién es. Descriptiva, sin opinión política.
8. keywords: entre 3 y 7 términos en minúscula sin acentos.

Reglas:
- Si tenés dudas o el candidato no se entiende, marcá include=false.
- Si dos candidatos refieren a la misma entidad, marcá include=true sólo en el de la forma canónica.
- NUNCA inventes parentSlug: tiene que ser exactamente uno de los que te paso.

Devolvé { assignments: [...] } con un objeto por candidato.`;

interface BuildPromptArgs {
  candidates: ScanCandidate[];
  evergreens: Topic[];
}

function buildUserPrompt(args: BuildPromptArgs): string {
  return JSON.stringify(
    {
      candidates: args.candidates.map((c) => ({
        normalizedLabel: c.normalizedLabel,
        candidateLabel: c.candidateLabel,
        mentionCount: c.mentionCount,
        sourceCount: c.sourceCount,
        sourceDomains: c.sourceDomains,
        sampleHeadlines: c.sampleHeadlines,
      })),
      evergreenVerticals: args.evergreens.map((t) => ({
        slug: t.slug,
        label: t.label,
        description: t.description,
      })),
    },
    null,
    2,
  );
}

interface InsertArgs {
  assignment: PromoteAssignment;
  parentTopicId: number;
  candidate: ScanCandidate;
}

// Insert a new entity-evergreen topic and record aliases for both the
// canonical label and every original casing the scan saw, so the cluster
// step can match articles against either form.
export function insertEntityEvergreen(args: InsertArgs): Topic | null {
  const db = getDb();
  const now = new Date().toISOString();
  // Already promoted? Skip silently — the script is meant to be re-runnable.
  const existing = findTopicBySlug(args.assignment.slug);
  if (existing) return existing;

  const canonicalKeywords = canonicalizeKeywords(args.assignment.keywords);
  const info = db
    .prepare(
      `INSERT INTO topics
       (slug, label, description, keywords_json, parent_topic_id, scope, first_seen_at, last_seen_at, status, entity_type)
       VALUES (@slug, @label, @description, @keywords_json, @parent_topic_id, 'evergreen', @now, @now, 'active', @entity_type)`,
    )
    .run({
      slug: args.assignment.slug,
      label: args.assignment.canonicalLabel,
      description: args.assignment.description,
      keywords_json: JSON.stringify(canonicalKeywords),
      parent_topic_id: args.parentTopicId,
      now,
      entity_type: args.assignment.entityType,
    });
  const id = Number(info.lastInsertRowid);

  // Aliases let the cluster step find this evergreen by any casing the
  // scrapers actually emit ("Peñarol", "C.A. Peñarol", "PEÑAROL", …).
  recordTopicAlias(args.assignment.canonicalLabel, id);
  recordTopicAlias(args.assignment.normalizedLabel ?? args.candidate.normalizedLabel, id);
  recordTopicAlias(args.candidate.candidateLabel, id);

  return findTopicBySlug(args.assignment.slug);
}

interface PromoteOpts {
  candidates: ScanCandidate[];
  provider: LlmProvider;
  model?: string;
  batchSize?: number;
}

export interface PromoteStats {
  considered: number;
  inserted: number;
  skippedExcluded: number;
  skippedDuplicate: number;
  skippedBadParent: number;
  failed: number;
}

export async function promoteEntities(opts: PromoteOpts): Promise<PromoteStats> {
  const stats: PromoteStats = {
    considered: opts.candidates.length,
    inserted: 0,
    skippedExcluded: 0,
    skippedDuplicate: 0,
    skippedBadParent: 0,
    failed: 0,
  };
  const evergreens = getEvergreenTopics().filter((t) => t.entityType === null);
  const evergreenBySlug = new Map(evergreens.map((t) => [t.slug, t]));
  const batchSize = opts.batchSize ?? 5;

  for (let i = 0; i < opts.candidates.length; i += batchSize) {
    const batch = opts.candidates.slice(i, i + batchSize);
    let response;
    try {
      const result = await opts.provider.generateJson({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt({ candidates: batch, evergreens }),
        schema: PromoteResponseSchema,
        model: opts.model,
        maxOutputTokens: 2048,
        temperature: 0,
      });
      response = result.value;
    } catch (err) {
      stats.failed += batch.length;
      console.warn(
        `[promote] Batch ${i / batchSize + 1} failed: ${(err as Error).message}`,
      );
      continue;
    }

    for (const a of response.assignments) {
      const candidate = batch.find((c) => c.normalizedLabel === a.normalizedLabel);
      if (!candidate) continue;
      if (!a.include) {
        stats.skippedExcluded += 1;
        continue;
      }
      const parent = evergreenBySlug.get(a.parentSlug);
      if (!parent) {
        stats.skippedBadParent += 1;
        console.warn(
          `[promote] Skipping "${a.canonicalLabel}" — LLM returned unknown parentSlug "${a.parentSlug}"`,
        );
        continue;
      }
      if (findTopicBySlug(a.slug)) {
        stats.skippedDuplicate += 1;
        continue;
      }
      const inserted = insertEntityEvergreen({
        assignment: a,
        parentTopicId: parent.id,
        candidate,
      });
      if (inserted) {
        stats.inserted += 1;
        console.log(
          `[promote]  ✓ ${a.canonicalLabel} (${a.entityType}) → ${parent.label} [${a.slug}]`,
        );
      } else {
        stats.failed += 1;
      }
    }
  }
  return stats;
}

// Helper exposed for the CLI: turn a free-form label into the slug we'd use
// if the LLM returned nonsense for the slug field. Defensive belt-and-braces
// against zod-validated-but-still-bad responses.
export function fallbackSlug(label: string): string {
  return slugify(label, { lower: true, strict: true, trim: true }) || 'entidad';
}

// Fallback entityType inference, used only when the LLM picks none of the
// known values (zod will throw before we get here, but kept for local
// callers that bypass zod).
export function isEntityType(s: string): s is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(s);
}

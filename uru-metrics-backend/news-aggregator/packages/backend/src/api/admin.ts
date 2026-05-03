import { Hono } from 'hono';
import { z } from 'zod';
import { config } from '../config.js';
import { getProvider } from '../ai/provider.js';
import {
  promoteEntities,
  scanEntities,
  type ScanCandidate,
} from '../ai/promote-entities.js';

// Admin route — gated by `Authorization: Bearer <ADMIN_TOKEN>`. Keeps
// long-running operator actions (entity scan/promote) reachable without
// shell access to the addon container, which the basic HA SSH addon
// doesn't have docker exec for.
//
// SECURITY: every endpoint here is rejected with 503 if the addon
// hasn't been configured with an admin_token. Empty tokens are not
// equivalent to "open" — they're equivalent to "off".

export const adminRoute = new Hono();

// Never cache anything admin-related.
adminRoute.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

// Bearer-token middleware. Treat empty config as service-disabled (503),
// otherwise compare in constant time so timing doesn't leak the token.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

adminRoute.use('*', async (c, next) => {
  const expected = config.adminToken;
  if (!expected) {
    return c.json(
      { error: 'admin disabled — set admin_token in addon config to enable' },
      503,
    );
  }
  const header = c.req.header('Authorization') ?? '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  const supplied = m?.[1] ?? '';
  if (!supplied || !constantTimeEqual(expected, supplied)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

const scanBody = z
  .object({
    daysBack: z.number().int().min(1).max(365).optional(),
    minMentions: z.number().int().min(1).max(1000).optional(),
    minSources: z.number().int().min(1).max(50).optional(),
    top: z.number().int().min(1).max(200).optional(),
  })
  .optional();

// POST /api/admin/promote/scan — pure SQL aggregation. Response is the
// full candidate list so the operator can save it locally for review
// before issuing /promote/apply.
adminRoute.post('/promote/scan', async (c) => {
  let body: z.infer<typeof scanBody> = undefined;
  try {
    const raw = await c.req.json();
    body = scanBody.parse(raw);
  } catch {
    /* empty / invalid body — use defaults */
  }
  const candidates = scanEntities(body ?? {});
  return c.json({
    generatedAt: new Date().toISOString(),
    params: body ?? {},
    candidateCount: candidates.length,
    candidates,
  });
});

const applyBody = z
  .object({
    // Either pass an explicit candidate list (the operator's reviewed
    // shortlist) or omit and let us re-scan with the same params used by
    // /promote/scan.
    candidates: z
      .array(
        z.object({
          candidateLabel: z.string(),
          normalizedLabel: z.string(),
          mentionCount: z.number().int(),
          sourceCount: z.number().int(),
          sourceDomains: z.array(z.string()),
          sampleHeadlines: z.array(z.string()),
        }),
      )
      .optional(),
    daysBack: z.number().int().min(1).max(365).optional(),
    minMentions: z.number().int().min(1).max(1000).optional(),
    minSources: z.number().int().min(1).max(50).optional(),
    top: z.number().int().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    providerName: z.enum(['claude', 'gemini', 'openai', 'stub']).optional(),
    model: z.string().optional(),
  })
  .optional();

// POST /api/admin/promote/apply — runs the LLM promotion. Costs Haiku
// tokens. Operator can either (a) submit the candidates list inline, or
// (b) omit it and we re-scan first.
adminRoute.post('/promote/apply', async (c) => {
  let body: z.infer<typeof applyBody> = undefined;
  try {
    const raw = await c.req.json();
    body = applyBody.parse(raw);
  } catch {
    /* empty / invalid body — use defaults */
  }
  let candidates: ScanCandidate[] = body?.candidates ?? scanEntities(body ?? {});
  if (body?.limit && body.limit > 0) candidates = candidates.slice(0, body.limit);

  if (candidates.length === 0) {
    return c.json({
      considered: 0,
      inserted: 0,
      skippedExcluded: 0,
      skippedDuplicate: 0,
      skippedBadParent: 0,
      failed: 0,
      message: 'no candidates met the thresholds — nothing to promote',
    });
  }

  const provider = getProvider(body?.providerName ?? config.llm.provider);
  const stats = await promoteEntities({
    candidates,
    provider,
    model: body?.model ?? config.llm.modelCategorize,
  });
  return c.json(stats);
});

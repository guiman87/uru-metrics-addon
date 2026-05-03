import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve repo-relative paths from the package root, not the cwd, so scripts
// can be invoked from anywhere in the workspace.
const PACKAGE_ROOT = path.resolve(__dirname, '..');

function envStr(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${name}`);
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} is not a number: ${v}`);
  return n;
}

function envList(name: string, fallback: string[] = []): string[] {
  const v = process.env[name];
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  port: envNum('PORT', 3000),
  host: envStr('HOST', '0.0.0.0'),
  corsOrigins: envList('CORS_ORIGINS', ['http://localhost:3001']),
  dbPath: path.resolve(PACKAGE_ROOT, envStr('DB_PATH', './data/articles.db')),
  llm: {
    provider: envStr('LLM_PROVIDER', 'claude') as 'claude' | 'gemini' | 'openai' | 'stub',
    modelCategorize: envStr('LLM_MODEL_CATEGORIZE', 'claude-haiku-4-5-20251001'),
    modelCluster: envStr('LLM_MODEL_CLUSTER', 'claude-sonnet-4-6'),
    maxUsdPerDay: envNum('LLM_MAX_USD_PER_DAY', 5),
    // When false, the daily cap is logged but never enforced. Useful for
    // bursts (full re-categorize after a schema change, fresh ingest after
    // adding many sources, etc.) where you'd rather pay than skip.
    capEnabled: (process.env.LLM_COST_CAP_ENABLED ?? 'true').toLowerCase() !== 'false',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    googleApiKey: process.env.GOOGLE_API_KEY ?? '',
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  },
  adminToken: process.env.ADMIN_TOKEN ?? '',
  // Optional cron-driven entity-evergreen promotion. Off by default —
  // operators are expected to run the manual flow at least once before
  // flipping the flag, so they can sanity-check the LLM's output. The
  // thresholds default well above the manual ones (40/6 vs 20/4) so an
  // automated false positive is much less likely.
  entityAutoPromote: {
    enabled:
      (process.env.ENTITY_AUTO_PROMOTE_ENABLED ?? 'false').toLowerCase() === 'true',
    minMentions: envNum('ENTITY_AUTO_PROMOTE_MIN_MENTIONS', 40),
    minSources: envNum('ENTITY_AUTO_PROMOTE_MIN_SOURCES', 6),
    top: envNum('ENTITY_AUTO_PROMOTE_TOP', 20),
  },
  tzDisplay: envStr('TZ_DISPLAY', 'America/Montevideo'),
  packageRoot: PACKAGE_ROOT,
};

export type Config = typeof config;

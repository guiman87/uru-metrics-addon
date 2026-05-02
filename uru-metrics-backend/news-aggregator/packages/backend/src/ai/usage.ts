import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { estimateCostUsd } from './pricing.js';

export class CostCapExceededError extends Error {
  constructor(spent: number, cap: number) {
    super(`Daily LLM cost cap exceeded: $${spent.toFixed(4)} >= $${cap.toFixed(2)}`);
    this.name = 'CostCapExceededError';
  }
}

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getDailyCostUsd(date: string = todayUtcDate()): number {
  const row = getDb()
    .prepare<[string], { total: number | null }>(
      `SELECT SUM(cost_usd) AS total FROM llm_usage WHERE date(ts) = ?`,
    )
    .get(date);
  return row?.total ?? 0;
}

export function recordUsage(args: {
  provider: string;
  model: string;
  inputTok: number;
  outputTok: number;
  cacheCreationInputTok?: number;
  cacheReadInputTok?: number;
}): { costUsd: number } {
  const cacheCreation = args.cacheCreationInputTok ?? 0;
  const cacheRead = args.cacheReadInputTok ?? 0;
  const costUsd = estimateCostUsd(
    args.model,
    args.inputTok,
    args.outputTok,
    cacheCreation,
    cacheRead,
  );
  getDb()
    .prepare(
      `INSERT INTO llm_usage
         (ts, provider, model, input_tok, output_tok,
          cache_creation_input_tok, cache_read_input_tok, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      args.provider,
      args.model,
      args.inputTok,
      args.outputTok,
      cacheCreation,
      cacheRead,
      costUsd,
    );
  return { costUsd };
}

/**
 * Throws CostCapExceededError if today's logged spend already meets/exceeds the cap.
 * Call before issuing a new LLM request. When config.llm.capEnabled is false,
 * the check is skipped (spend is still recorded; the cap just isn't enforced).
 */
export function assertUnderDailyCap(): void {
  if (!config.llm.capEnabled) return;
  const spent = getDailyCostUsd();
  if (spent >= config.llm.maxUsdPerDay) {
    throw new CostCapExceededError(spent, config.llm.maxUsdPerDay);
  }
}

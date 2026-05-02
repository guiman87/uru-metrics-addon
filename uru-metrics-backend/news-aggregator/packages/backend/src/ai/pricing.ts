// Per-million-token pricing in USD. Used to estimate llm_usage cost. Update
// these as providers change list prices — the daily cap is a soft guardrail
// so approximate numbers are fine.
export interface ModelPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export const PRICING: Record<string, ModelPrice> = {
  // ─── Anthropic ──────────────────────────────────────────────────────────
  'claude-haiku-4-5-20251001': { inputUsdPerMTok: 1.0, outputUsdPerMTok: 5.0 },
  'claude-sonnet-4-6': { inputUsdPerMTok: 3.0, outputUsdPerMTok: 15.0 },
  'claude-sonnet-4-7': { inputUsdPerMTok: 3.0, outputUsdPerMTok: 15.0 },
  'claude-opus-4-7': { inputUsdPerMTok: 15.0, outputUsdPerMTok: 75.0 },

  // ─── Google ─────────────────────────────────────────────────────────────
  'gemini-2.5-flash': { inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5 },
  'gemini-2.5-pro': { inputUsdPerMTok: 1.25, outputUsdPerMTok: 5.0 },
  'gemini-3-pro-preview': { inputUsdPerMTok: 1.25, outputUsdPerMTok: 5.0 },

  // ─── OpenAI ─────────────────────────────────────────────────────────────
  'gpt-4o-mini': { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.6 },
  'gpt-4o': { inputUsdPerMTok: 2.5, outputUsdPerMTok: 10.0 },

  // ─── Stub (free) ────────────────────────────────────────────────────────
  'stub-v1': { inputUsdPerMTok: 0, outputUsdPerMTok: 0 },
};

// Anthropic ephemeral (5-min) prompt-caching multipliers vs. base input rate.
// Cache writes cost more, cache reads cost much less. Applied uniformly to all
// providers — non-Anthropic providers should pass 0 for cache token counts.
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

export function estimateCostUsd(
  model: string,
  inputTok: number,
  outputTok: number,
  cacheCreationTok: number = 0,
  cacheReadTok: number = 0,
): number {
  const p = PRICING[model];
  const inputRate = p?.inputUsdPerMTok ?? 3.0; // unknown model → Sonnet input rate
  const outputRate = p?.outputUsdPerMTok ?? 15.0;
  return (
    (inputTok / 1_000_000) * inputRate +
    (cacheCreationTok / 1_000_000) * inputRate * CACHE_WRITE_MULTIPLIER +
    (cacheReadTok / 1_000_000) * inputRate * CACHE_READ_MULTIPLIER +
    (outputTok / 1_000_000) * outputRate
  );
}

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

export function estimateCostUsd(model: string, inputTok: number, outputTok: number): number {
  const p = PRICING[model];
  if (!p) {
    // Unknown model — fall back to Sonnet rates so we don't under-bill.
    return (inputTok / 1_000_000) * 3.0 + (outputTok / 1_000_000) * 15.0;
  }
  return (inputTok / 1_000_000) * p.inputUsdPerMTok + (outputTok / 1_000_000) * p.outputUsdPerMTok;
}

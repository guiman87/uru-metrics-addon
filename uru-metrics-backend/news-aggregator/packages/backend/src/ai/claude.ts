import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { LlmCallArgs, LlmProvider, LlmUsage } from '@uru/shared';
import { config } from '../config.js';
import { assertUnderDailyCap, recordUsage } from './usage.js';

const TOOL_NAME = 'return_structured_response';

// Anthropic prompt caching lives on `client.beta.messages.create` in @anthropic-ai/sdk
// 0.32.x. We tag the system prompt and the tool schema with cache_control so the
// per-stage static prefix is amortized across runs (≈40% off input tokens at our
// hourly cadence, with a 5-min ephemeral TTL). Once we bump to an SDK release
// where cache_control is on the stable Messages API, switch back to client.messages.
export class ClaudeProvider implements LlmProvider {
  readonly name = 'claude' as const;
  private client: Anthropic;

  constructor() {
    if (!config.llm.anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set');
    }
    this.client = new Anthropic({ apiKey: config.llm.anthropicApiKey });
  }

  async generateJson<T>(args: LlmCallArgs<T>): Promise<{ value: T; usage: LlmUsage }> {
    assertUnderDailyCap();
    const model = args.model ?? config.llm.modelCategorize;
    const inputSchema = zodToJsonSchema(args.schema, { target: 'jsonSchema7' }) as Record<
      string,
      unknown
    >;

    const res = await this.client.beta.messages.create({
      model,
      max_tokens: args.maxOutputTokens ?? 2048,
      temperature: args.temperature ?? 0,
      system: [
        {
          type: 'text',
          text: args.system,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [
        {
          name: TOOL_NAME,
          description: 'Return the structured response for the user request.',
          input_schema: inputSchema as Anthropic.Beta.BetaTool['input_schema'],
          cache_control: { type: 'ephemeral' },
        },
      ],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [{ role: 'user', content: args.user }],
      betas: ['prompt-caching-2024-07-31'],
    });

    const toolUse = res.content.find(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use' && b.name === TOOL_NAME,
    );
    if (!toolUse) {
      throw new Error(`Claude returned no tool_use block (stop_reason=${res.stop_reason})`);
    }
    const value = args.schema.parse(toolUse.input);

    const inputTok = res.usage.input_tokens;
    const outputTok = res.usage.output_tokens;
    const cacheCreationInputTok = res.usage.cache_creation_input_tokens ?? 0;
    const cacheReadInputTok = res.usage.cache_read_input_tokens ?? 0;
    const { costUsd } = recordUsage({
      provider: this.name,
      model,
      inputTok,
      outputTok,
      cacheCreationInputTok,
      cacheReadInputTok,
    });
    return {
      value,
      usage: {
        input: inputTok,
        output: outputTok,
        cacheCreationInput: cacheCreationInputTok,
        cacheReadInput: cacheReadInputTok,
        costUsd,
      },
    };
  }
}

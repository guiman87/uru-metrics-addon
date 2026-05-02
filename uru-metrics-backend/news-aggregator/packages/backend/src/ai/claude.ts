import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { LlmCallArgs, LlmProvider, LlmUsage } from '@uru/shared';
import { config } from '../config.js';
import { assertUnderDailyCap, recordUsage } from './usage.js';

const TOOL_NAME = 'return_structured_response';

// NOTE: Prompt caching lives in the SDK's `beta` namespace as of @anthropic-ai/sdk@0.32.x.
// Once we move to a release where cache_control is GA on the stable Messages API,
// re-add `cache_control: { type: 'ephemeral' }` on the system block — at hourly
// run cadence with a stable system prompt this is ~40% off input cost.
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

    const res = await this.client.messages.create({
      model,
      max_tokens: args.maxOutputTokens ?? 2048,
      temperature: args.temperature ?? 0,
      system: args.system,
      tools: [
        {
          name: TOOL_NAME,
          description: 'Return the structured response for the user request.',
          input_schema: inputSchema as Anthropic.Tool['input_schema'],
        },
      ],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [{ role: 'user', content: args.user }],
    });

    const toolUse = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === TOOL_NAME,
    );
    if (!toolUse) {
      throw new Error(`Claude returned no tool_use block (stop_reason=${res.stop_reason})`);
    }
    const value = args.schema.parse(toolUse.input);

    const inputTok = res.usage.input_tokens;
    const outputTok = res.usage.output_tokens;
    const { costUsd } = recordUsage({
      provider: this.name,
      model,
      inputTok,
      outputTok,
    });
    return { value, usage: { input: inputTok, output: outputTok, costUsd } };
  }
}

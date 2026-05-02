import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { LlmCallArgs, LlmProvider, LlmUsage } from '@uru/shared';
import { config } from '../config.js';
import { assertUnderDailyCap, recordUsage } from './usage.js';

// OpenAI's Structured Outputs require strict mode, which rejects optional
// fields and demands all keys in `required`. Walk the schema and tighten it.
function tightenSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(tightenSchema);
  const obj = { ...(schema as Record<string, unknown>) };
  // Strip JSON Schema 7 wrappers OpenAI doesn't accept
  delete obj.$schema;
  delete obj.definitions;
  if (obj.type === 'object' && obj.properties && typeof obj.properties === 'object') {
    obj.additionalProperties = false;
    obj.required = Object.keys(obj.properties as Record<string, unknown>);
    obj.properties = Object.fromEntries(
      Object.entries(obj.properties as Record<string, unknown>).map(([k, v]) => [k, tightenSchema(v)]),
    );
  }
  if (obj.type === 'array' && obj.items) {
    obj.items = tightenSchema(obj.items);
  }
  if (obj.anyOf) obj.anyOf = (obj.anyOf as unknown[]).map(tightenSchema);
  if (obj.oneOf) obj.oneOf = (obj.oneOf as unknown[]).map(tightenSchema);
  return obj;
}

export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai' as const;
  private client: OpenAI;

  constructor() {
    if (!config.llm.openaiApiKey) {
      throw new Error('OPENAI_API_KEY is not set');
    }
    this.client = new OpenAI({ apiKey: config.llm.openaiApiKey });
  }

  async generateJson<T>(args: LlmCallArgs<T>): Promise<{ value: T; usage: LlmUsage }> {
    assertUnderDailyCap();
    const model = args.model ?? config.llm.modelCategorize;
    const jsonSchema = zodToJsonSchema(args.schema, { target: 'jsonSchema7' }) as Record<
      string,
      unknown
    >;

    const res = await this.client.chat.completions.create({
      model,
      temperature: args.temperature ?? 0,
      max_tokens: args.maxOutputTokens ?? 2048,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'structured_response',
          strict: true,
          schema: tightenSchema(jsonSchema) as Record<string, unknown>,
        },
      },
    });

    const text = res.choices[0]?.message?.content;
    if (!text) throw new Error('OpenAI returned no content');
    const parsed: unknown = JSON.parse(text);
    const value = args.schema.parse(parsed);

    const inputTok = res.usage?.prompt_tokens ?? 0;
    const outputTok = res.usage?.completion_tokens ?? 0;
    const { costUsd } = recordUsage({
      provider: this.name,
      model,
      inputTok,
      outputTok,
    });
    return { value, usage: { input: inputTok, output: outputTok, costUsd } };
  }
}

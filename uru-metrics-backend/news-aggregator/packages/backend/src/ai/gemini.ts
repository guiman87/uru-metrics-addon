import { GoogleGenerativeAI, type Schema } from '@google/generative-ai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { LlmCallArgs, LlmProvider, LlmUsage } from '@uru/shared';
import { config } from '../config.js';
import { assertUnderDailyCap, recordUsage } from './usage.js';

// Gemini's responseSchema is JSON-Schema-ish but rejects $schema, additionalProperties,
// and a few other JSON Schema 7 keywords. Strip them recursively.
function sanitizeSchema(schema: unknown): Schema {
  if (!schema || typeof schema !== 'object') return schema as Schema;
  if (Array.isArray(schema)) {
    return schema.map(sanitizeSchema) as unknown as Schema;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === '$schema' || k === 'additionalProperties' || k === '$ref' || k === 'definitions') continue;
    out[k] = typeof v === 'object' ? sanitizeSchema(v) : v;
  }
  return out as Schema;
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini' as const;
  private client: GoogleGenerativeAI;

  constructor() {
    if (!config.llm.googleApiKey) {
      throw new Error('GOOGLE_API_KEY is not set');
    }
    this.client = new GoogleGenerativeAI(config.llm.googleApiKey);
  }

  async generateJson<T>(args: LlmCallArgs<T>): Promise<{ value: T; usage: LlmUsage }> {
    assertUnderDailyCap();
    const model = args.model ?? config.llm.modelCategorize;
    const jsonSchema = zodToJsonSchema(args.schema, { target: 'jsonSchema7' }) as Record<
      string,
      unknown
    >;

    const generative = this.client.getGenerativeModel({
      model,
      systemInstruction: args.system,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: sanitizeSchema(jsonSchema),
        temperature: args.temperature ?? 0,
        maxOutputTokens: args.maxOutputTokens ?? 2048,
      },
    });

    const result = await generative.generateContent(args.user);
    const text = result.response.text();
    const parsed: unknown = JSON.parse(text);
    const value = args.schema.parse(parsed);

    const meta = result.response.usageMetadata;
    const inputTok = meta?.promptTokenCount ?? 0;
    const outputTok = meta?.candidatesTokenCount ?? 0;
    const { costUsd } = recordUsage({
      provider: this.name,
      model,
      inputTok,
      outputTok,
    });
    return { value, usage: { input: inputTok, output: outputTok, costUsd } };
  }
}

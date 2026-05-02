import type { LlmProvider } from '@uru/shared';
import { config } from '../config.js';
import { ClaudeProvider } from './claude.js';
import { GeminiProvider } from './gemini.js';
import { OpenAIProvider } from './openai.js';
import { StubProvider } from './stub.js';

let _cached: LlmProvider | null = null;

export function getProvider(name: string = config.llm.provider): LlmProvider {
  if (_cached && _cached.name === name) return _cached;
  switch (name) {
    case 'claude':
      _cached = new ClaudeProvider();
      break;
    case 'gemini':
      _cached = new GeminiProvider();
      break;
    case 'openai':
      _cached = new OpenAIProvider();
      break;
    case 'stub':
      _cached = new StubProvider();
      break;
    default:
      throw new Error(`Unknown LLM provider: ${name}`);
  }
  return _cached;
}

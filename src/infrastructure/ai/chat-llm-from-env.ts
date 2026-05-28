import type { ChatLlmPort } from '../../domain/ai/port/chat-llm.port.js';
import { ChatGptOAuthChatLlm } from './chatgpt-oauth-chat-llm.js';
import { OpenAiChatLlm } from './openai-chat-llm.js';
import { hasCodexChatGptAuthSync } from './codex-chatgpt-auth.js';

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface CreateChatLlmFromEnvOptions {
  readonly defaultModel: string;
  readonly httpTimeoutMs: number;
  readonly env?: EnvLike;
  readonly openAiBaseUrl?: string;
  readonly allowCodexFallback?: boolean;
}

function parseOpenAiApiKeys(env: EnvLike): readonly string[] {
  const deduped = new Set<string>();
  const ordered: string[] = [];
  const pool = env['OPENAI_API_KEYS']?.split(/[,\n]+/) ?? [];
  for (const raw of [env['OPENAI_API_KEY'], ...pool]) {
    const trimmed = raw?.trim();
    if (trimmed === undefined || trimmed.length === 0 || deduped.has(trimmed)) {
      continue;
    }
    deduped.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
}

export function createChatLlmFromEnv(
  options: CreateChatLlmFromEnvOptions,
): ChatLlmPort | undefined {
  const env = options.env ?? process.env;
  const apiKeys = parseOpenAiApiKeys(env);
  if (apiKeys.length > 0) {
    return new OpenAiChatLlm({
      baseUrl: options.openAiBaseUrl ?? env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1',
      apiKeys,
      defaultModel: options.defaultModel,
      httpTimeoutMs: options.httpTimeoutMs,
    });
  }

  if (
    options.allowCodexFallback === true
    && hasCodexChatGptAuthSync(env, { allowProcessFallback: env === process.env })
  ) {
    return new ChatGptOAuthChatLlm({
      defaultModel: options.defaultModel,
      httpTimeoutMs: options.httpTimeoutMs,
      env,
    });
  }

  return undefined;
}

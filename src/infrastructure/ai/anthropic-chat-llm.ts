/**
 * Anthropic Messages API adapter.
 * Implements {@link ChatLlmPort} — drop-in replacement for OpenAiChatLlm
 * when OpenAI rate limits are hit.
 *
 * Maps ChatMessage roles to Anthropic's format:
 *   system  → top-level `system` param (only first system message is used)
 *   user    → user turn
 *   assistant → assistant turn
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatLlmPort,
} from '../../domain/ai/port/chat-llm.port.js';
import {
  fetchWithTimeout,
  isAbortError,
} from '../http/fetch-with-timeout.js';
import {
  retryWithBackoff,
  parseRetryAfterHeader,
  type RetryConfig,
} from '../http/retry-with-backoff.js';
import { withGenAiSpan, type GenAiResponseAttributes } from '../telemetry/gen-ai-tracing.js';
import { AnthropicTransportError } from './anthropic-transport-error.js';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_API_VERSION = '2023-06-01';
const ERROR_PREVIEW_CHARS = 200;
const ANTHROPIC_DEFAULT_MAX_TOKENS = 1024;

const ANTHROPIC_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 4,
  transientBackoffBaseMs: 250,
  transientBackoffCapMs: 2_000,
  rateLimitBackoffBaseMs: 2_000,
  rateLimitBackoffCapMs: 30_000,
  label: 'Anthropic chat',
};

export interface AnthropicChatLlmOptions {
  readonly apiKey: string;
  readonly defaultModel: string;
  readonly httpTimeoutMs: number;
}

interface AnthropicMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
}

interface AnthropicResponse {
  readonly id: string;
  readonly model: string;
  readonly stop_reason: string | null;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly usage?: AnthropicUsage;
}

function isAnthropicResponse(v: unknown): v is AnthropicResponse {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['id'] === 'string' && Array.isArray(o['content']);
}

export class AnthropicChatLlm implements ChatLlmPort {
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly httpTimeoutMs: number;
  private readonly endpoint: string;

  constructor(options: AnthropicChatLlmOptions) {
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel;
    this.httpTimeoutMs = options.httpTimeoutMs;
    this.endpoint = `${ANTHROPIC_API_BASE}/v1/messages`;
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const model = request.model ?? this.defaultModel;
    return withGenAiSpan(
      { system: 'anthropic', requestModel: model, operation: 'chat' },
      (recordResponse) => this.completeInner(request, model, recordResponse),
    );
  }

  private async completeInner(
    request: ChatCompletionRequest,
    model: string,
    recordResponse: (resp: GenAiResponseAttributes) => void,
  ): Promise<ChatCompletionResult> {
    // Split system message from conversation turns.
    // Anthropic requires system as a top-level param, not a message turn.
    let systemPrompt: string | undefined;
    const turns: AnthropicMessage[] = [];

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        // Use only the first system message (concatenate if multiple)
        systemPrompt = systemPrompt !== undefined
          ? `${systemPrompt}\n\n${msg.content}`
          : msg.content;
      } else {
        // msg.role is 'user' | 'assistant' here (ChatRole exhausted)
        turns.push({ role: msg.role, content: msg.content });
      }
    }

    // Anthropic requires at least one user turn
    if (turns.length === 0 || turns[turns.length - 1]?.role !== 'user') {
      turns.push({ role: 'user', content: '(continue)' });
    }

    const body: Record<string, unknown> = {
      model,
      messages: turns,
      max_tokens: request.maxOutputTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    };
    if (systemPrompt !== undefined) {
      // v5: Anthropic prompt caching enabled on the system prompt.
      // The agent system prompt is ~2-2.5K tokens and identical across all queries
      // (after the date refactor — see agent-prompt.ts buildSystemPrompt). With
      // ephemeral cache (5-minute TTL), virtually every concurrent benchmark request
      // hits the cache, reducing input cost by ~90%.
      // Reference: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
      body['system'] = [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ];
    }
    if (request.temperature !== undefined) {
      body['temperature'] = request.temperature;
    }

    return retryWithBackoff(
      async () => {
        let response: Response;
        try {
          response = await fetchWithTimeout(
            this.endpoint,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': ANTHROPIC_API_VERSION,
              },
              body: JSON.stringify(body),
            },
            this.httpTimeoutMs,
            request.abortSignal,
          );
        } catch (err) {
          if (isAbortError(err)) {
            const abortErr = new Error(`Anthropic chat: request timed out after ${this.httpTimeoutMs}ms`);
            abortErr.name = 'AbortError';
            throw abortErr;
          }
          const cause = err instanceof Error ? err : new Error(String(err));
          throw new AnthropicTransportError(
            `Anthropic chat: transport failure — ${cause.message}`,
            { cause },
          );
        }

        if (!response.ok) {
          const status = response.status;
          const text = await response.text().catch(() => '');
          return {
            kind: 'http-error' as const,
            status,
            bodyText: text,
            retryAfterSec: parseRetryAfterHeader(response),
          };
        }

        const data: unknown = await response.json();
        if (!isAnthropicResponse(data)) {
          throw new Error(`Anthropic chat: unexpected response — ${JSON.stringify(data).slice(0, ERROR_PREVIEW_CHARS)}`);
        }

        const textBlock = data.content.find((b) => b.type === 'text');
        const text = textBlock?.text ?? '';

        // Record GenAI response attributes for the wrapping span (OTEL gen_ai.*)
        // Anthropic's usage exposes cache_read_input_tokens (cache hit) and
        // cache_creation_input_tokens (first time prompt was cached, charged at 1.25x).
        const usage = data.usage;
        const cacheReadTokens = usage?.cache_read_input_tokens ?? 0;
        const cacheCreationTokens = usage?.cache_creation_input_tokens ?? 0;
        // For cost accounting: cache_read = cached input (10% of normal),
        // cache_creation = uncached input (charged once at 1.25x in Anthropic but
        // approximated as 1x here for conservatism).
        const baseInputTokens = (usage?.input_tokens ?? 0) + cacheCreationTokens;
        recordResponse({
          responseModel: data.model,
          ...(data.stop_reason !== null ? { finishReason: data.stop_reason } : {}),
          ...(usage !== undefined
            ? {
                usage: {
                  inputTokens: baseInputTokens,
                  outputTokens: usage.output_tokens ?? 0,
                  ...(cacheReadTokens > 0 ? { cachedInputTokens: cacheReadTokens } : {}),
                },
              }
            : {}),
        });

        return {
          kind: 'success' as const,
          value: {
            text,
            model: data.model,
            finishReason: data.stop_reason,
          } satisfies ChatCompletionResult,
        };
      },
      ANTHROPIC_RETRY_CONFIG,
      request.abortSignal,
    );
  }
}

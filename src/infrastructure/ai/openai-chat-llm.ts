/**
 * OpenAI Chat Completions (non-streaming).
 * Implements {@link ChatLlmPort}; compatible with OpenAI-compatible proxies (LiteLLM, Azure path-style base URLs).
 */

import {
  createCircuitBreaker,
  type CircuitBreaker,
} from '../../domain/shared/circuit-breaker/circuit-breaker.js';
import { globalCircuitBreakerRegistry } from '../../observability/circuit-breaker-registry.js';
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
import { runUnderLlmBreaker } from './llm-circuit-breaker-classifier.js';

const OPENAI_CHAT_MALFORMED_JSON_PREVIEW_CHARS = 240;

/** Circuit breaker thresholds for the OpenAI chat endpoint — same tuning
 *  as Anthropic so both providers share an equivalent failure budget. */
const OPENAI_CHAT_BREAKER_FAILURE_THRESHOLD = 5;
const OPENAI_CHAT_BREAKER_RECOVERY_TIMEOUT_MS = 60_000;
const OPENAI_CHAT_BREAKER_HALF_OPEN_MAX_ATTEMPTS = 3;
const OPENAI_CHAT_BREAKER_NAME = 'openai-chat';

const OPENAI_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 4,
  transientBackoffBaseMs: 250,
  transientBackoffCapMs: 2_000,
  rateLimitBackoffBaseMs: 2_000,
  rateLimitBackoffCapMs: 30_000,
  label: 'OpenAI chat',
};

export interface OpenAiChatLlmOptions {
  /** API base including `/v1`, e.g. `https://api.openai.com/v1` */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly defaultModel: string;
  readonly httpTimeoutMs: number;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

interface ChatCompletionsMessage {
  readonly role: string;
  readonly content: string | null;
}

interface ChatCompletionsChoice {
  readonly index: number;
  readonly message?: ChatCompletionsMessage;
  readonly finish_reason: string | null;
}

interface ChatCompletionsUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
  readonly prompt_tokens_details?: {
    readonly cached_tokens?: number;
  };
}

interface ChatCompletionsResponse {
  readonly model: string;
  readonly choices: readonly ChatCompletionsChoice[];
  readonly usage?: ChatCompletionsUsage;
}

function isChatCompletionsChoice(c: unknown): c is ChatCompletionsChoice {
  if (typeof c !== 'object' || c === null) return false;
  const o = c as Record<string, unknown>;
  // `message` is optional (absent for tool-call-only responses from some providers),
  // but when present its `role` must be a string. The content field may be null
  // (tool-call-only) or a string. We do NOT require message to exist so that
  // tool-call responses are handled gracefully by the caller (content defaults to '').
  if ('message' in o) {
    const m = o['message'];
    if (typeof m !== 'object' || m === null) return false;
    if (typeof (m as Record<string, unknown>)['role'] !== 'string') return false;
  }
  return true;
}

function isChatCompletionsResponse(v: unknown): v is ChatCompletionsResponse {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o['model'] !== 'string') return false;
  if (!Array.isArray(o['choices'])) return false;
  if ((o['choices'] as unknown[]).length === 0) return false;
  // Validate the first choice shape — this is the one we always read.
  if (!isChatCompletionsChoice((o['choices'] as unknown[])[0])) return false;
  return true;
}

export class OpenAiChatLlm implements ChatLlmPort {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly httpTimeoutMs: number;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(options: OpenAiChatLlmOptions) {
    this.endpoint = `${trimTrailingSlash(options.baseUrl)}/chat/completions`;
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel;
    this.httpTimeoutMs = options.httpTimeoutMs;
    this.circuitBreaker = createCircuitBreaker({
      name: OPENAI_CHAT_BREAKER_NAME,
      failureThreshold: OPENAI_CHAT_BREAKER_FAILURE_THRESHOLD,
      recoveryTimeoutMs: OPENAI_CHAT_BREAKER_RECOVERY_TIMEOUT_MS,
      halfOpenMaxAttempts: OPENAI_CHAT_BREAKER_HALF_OPEN_MAX_ATTEMPTS,
    });
    globalCircuitBreakerRegistry.register(OPENAI_CHAT_BREAKER_NAME, this.circuitBreaker);
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const model = request.model ?? this.defaultModel;
    return withGenAiSpan(
      { system: 'openai', requestModel: model, operation: 'chat' },
      (recordResponse) =>
        runUnderLlmBreaker(this.circuitBreaker, OPENAI_CHAT_BREAKER_NAME, () =>
          this.completeInner(request, model, recordResponse),
        ),
    );
  }

  private async completeInner(
    request: ChatCompletionRequest,
    model: string,
    recordResponse: (resp: GenAiResponseAttributes) => void,
  ): Promise<ChatCompletionResult> {
    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };
    // GPT-5.4 series (gpt-5, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, o-series):
    //   - temperature: only default (1) supported — omit when caller passes 0
    //   - token limit: must use max_completion_tokens, not max_tokens
    // Earlier models (gpt-4o, gpt-4-turbo, gpt-3.5-turbo): standard params.
    const isGpt5Series = /^(?:gpt-5|o\d)/i.test(model);
    if (request.temperature !== undefined) {
      if (!isGpt5Series) body['temperature'] = request.temperature;
      // GPT-5 series: temperature param not supported (only default=1 allowed) — omit entirely.
    }
    if (request.maxOutputTokens !== undefined) {
      body[isGpt5Series ? 'max_completion_tokens' : 'max_tokens'] = request.maxOutputTokens;
    }
    if (request.seed !== undefined) {
      body['seed'] = request.seed;
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
                Authorization: `Bearer ${this.apiKey}`,
              },
              body: JSON.stringify(body),
            },
            this.httpTimeoutMs,
            request.abortSignal,
          );
        } catch (err) {
          if (isAbortError(err)) {
            const abortErr = new Error(`OpenAI chat: request timed out after ${this.httpTimeoutMs}ms`);
            abortErr.name = 'AbortError';
            throw abortErr;
          }
          throw err;
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
        // Guard empty choices array before the full shape check so the error message
        // is actionable ("empty choices") rather than the generic "unexpected response".
        if (
          typeof data === 'object' && data !== null &&
          Array.isArray((data as Record<string, unknown>)['choices']) &&
          ((data as Record<string, unknown>)['choices'] as unknown[]).length === 0
        ) {
          throw new Error('OpenAI chat: LLM returned empty choices array');
        }
        if (!isChatCompletionsResponse(data)) {
          throw new Error(
            `OpenAI chat: unexpected response — ${JSON.stringify(data).slice(0, OPENAI_CHAT_MALFORMED_JSON_PREVIEW_CHARS)}`,
          );
        }

        const choice = data.choices[0];
        const content = choice?.message?.content;
        const text =
          typeof content === 'string'
            ? content
            : content == null
              ? ''
              : String(content);

        // Record GenAI response attributes for the wrapping span (OTEL gen_ai.*)
        const usage = data.usage;
        recordResponse({
          responseModel: data.model,
          ...(choice?.finish_reason !== null && choice?.finish_reason !== undefined
            ? { finishReason: choice.finish_reason }
            : {}),
          ...(usage !== undefined
            ? {
                usage: {
                  // `?? 0` alone passes NaN — use Number.isFinite() to guard against
                  // malformed API responses corrupting token tallies.
                  inputTokens: Number.isFinite(usage.prompt_tokens) ? (usage.prompt_tokens as number) : 0,
                  outputTokens: Number.isFinite(usage.completion_tokens) ? (usage.completion_tokens as number) : 0,
                  ...(Number.isFinite(usage.prompt_tokens_details?.cached_tokens)
                    ? { cachedInputTokens: usage.prompt_tokens_details?.cached_tokens as number }
                    : {}),
                },
              }
            : {}),
        });

        return {
          kind: 'success' as const,
          value: {
            text,
            model: data.model,
            finishReason: choice?.finish_reason ?? null,
          } satisfies ChatCompletionResult,
        };
      },
      OPENAI_RETRY_CONFIG,
      request.abortSignal,
    );
  }
}

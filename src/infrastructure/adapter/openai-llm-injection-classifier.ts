import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import type {
  LLMInjectionClassifierOptions,
  LLMInjectionClassifierPort,
} from '../../domain/security/port/llm-injection-classifier.port.js';
import {
  fetchWithTimeout,
  isAbortError,
} from '../http/fetch-with-timeout.js';
import {
  parseRetryAfterHeader,
  retryWithBackoff,
  type RetryConfig,
} from '../http/retry-with-backoff.js';
import { DEFAULT_BREAKER_FAILURE_THRESHOLD } from '../../domain/shared/circuit-breaker/circuit-breaker.js';
import { runUnderLlmBreaker } from '../ai/llm-circuit-breaker-classifier.js';
import {
  createOpenAiKeyPool,
  isOpenAiKeyPoolRotatableError,
  openAiKeyPoolExhaustedError,
  orderedOpenAiKeySlots,
  type OpenAiKeySlot,
} from '../ai/openai-key-pool.js';
import {
  INJECTION_CLASSIFIER_SYSTEM_PROMPT,
  normalizeClassifierJsonText,
} from './anthropic-llm-injection-classifier.js';
import {
  isReasoningModel,
  resolveCompletionTokens,
  resolveReasoningEffort,
} from '../ai/openai-reasoning-params.js';

const DEFAULT_OPENAI_INJECTION_MODEL = 'gpt-5.4-mini';
const DEFAULT_OPENAI_INJECTION_HTTP_TIMEOUT_MS = 45_000;
const OPENAI_CLASSIFIER_MAX_OUTPUT_TOKENS = 50;
const OPENAI_PARSE_ERROR_PREVIEW_CHARS = 120;

const OPENAI_INJECTION_BREAKER_FAILURE_THRESHOLD = DEFAULT_BREAKER_FAILURE_THRESHOLD;
const OPENAI_INJECTION_BREAKER_RECOVERY_TIMEOUT_MS = 60_000;
const OPENAI_INJECTION_BREAKER_HALF_OPEN_MAX_ATTEMPTS = 3;
const OPENAI_INJECTION_BREAKER_NAME = 'openai-injection-classifier';

const OPENAI_INJECTION_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 4,
  transientBackoffBaseMs: 250,
  transientBackoffCapMs: 2_000,
  rateLimitBackoffBaseMs: 2_000,
  rateLimitBackoffCapMs: 30_000,
  label: 'OpenAI injection classifier',
};

interface OpenAiInjectionClassifierOptions {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly apiKeys?: readonly string[] | undefined;
  readonly model?: string | undefined;
  readonly httpTimeoutMs?: number | undefined;
}

interface ChatCompletionsMessage {
  readonly role: string;
  readonly content: string | null;
}

interface ChatCompletionsChoice {
  readonly message?: ChatCompletionsMessage;
}

interface ChatCompletionsResponse {
  readonly choices: readonly ChatCompletionsChoice[];
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function isChatCompletionsResponse(v: unknown): v is ChatCompletionsResponse {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const choices: unknown = o['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null) return false;
  const message = (first as Record<string, unknown>)['message'];
  if (message === undefined) return true;
  if (typeof message !== 'object' || message === null) return false;
  const content = (message as Record<string, unknown>)['content'];
  return content === null || typeof content === 'string';
}

function tokenLimitKey(model: string): 'max_completion_tokens' | 'max_tokens' {
  return /^(?:gpt-5|o\d)/i.test(model) ? 'max_completion_tokens' : 'max_tokens';
}

export class OpenAiLLMInjectionClassifier implements LLMInjectionClassifierPort {
  private readonly endpoint: string;
  private readonly keySlots: readonly OpenAiKeySlot[];
  private readonly model: string;
  private readonly httpTimeoutMs: number;
  private nextSlotIndex = 0;

  constructor(options: OpenAiInjectionClassifierOptions) {
    this.endpoint = `${trimTrailingSlash(options.baseUrl)}/chat/completions`;
    this.keySlots = createOpenAiKeyPool({
      baseBreakerName: OPENAI_INJECTION_BREAKER_NAME,
      apiKey: options.apiKey,
      apiKeys: options.apiKeys,
      failureThreshold: OPENAI_INJECTION_BREAKER_FAILURE_THRESHOLD,
      recoveryTimeoutMs: OPENAI_INJECTION_BREAKER_RECOVERY_TIMEOUT_MS,
      halfOpenMaxAttempts: OPENAI_INJECTION_BREAKER_HALF_OPEN_MAX_ATTEMPTS,
    });
    this.model = options.model ?? DEFAULT_OPENAI_INJECTION_MODEL;
    this.httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_OPENAI_INJECTION_HTTP_TIMEOUT_MS;
  }

  async classify(query: string, options?: LLMInjectionClassifierOptions): Promise<boolean> {
    try {
      return await this.classifyWithKeyPool(query, options);
    } catch (err) {
      bootstrapLogger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[OpenAiLLMInjectionClassifier] OpenAI API error — propagating to caller for fail-open/closed policy',
      );
      throw err;
    }
  }

  private async classifyWithKeyPool(
    query: string,
    options?: LLMInjectionClassifierOptions,
  ): Promise<boolean> {
    const slots = this.nextOrderedSlots();
    const errors: unknown[] = [];

    for (const slot of slots) {
      try {
        return await runUnderLlmBreaker(slot.circuitBreaker, slot.breakerName, () =>
          this.classifyOnce(query, slot.apiKey, options),
        );
      } catch (err) {
        errors.push(err);
        if (this.keySlots.length === 1 || !isOpenAiKeyPoolRotatableError(err)) {
          throw err;
        }
      }
    }

    throw openAiKeyPoolExhaustedError('OpenAI injection classifier', this.keySlots.length, errors);
  }

  private nextOrderedSlots(): readonly OpenAiKeySlot[] {
    const startIndex = this.nextSlotIndex;
    this.nextSlotIndex = (this.nextSlotIndex + 1) % this.keySlots.length;
    return orderedOpenAiKeySlots(this.keySlots, startIndex);
  }

  private async classifyOnce(
    query: string,
    apiKey: string,
    options?: LLMInjectionClassifierOptions,
  ): Promise<boolean> {
    // Reasoning models burn tokens on internal reasoning before emitting
    // the yes/no verdict — the legacy 50-token budget left ZERO room for
    // output, manifesting as 45 s timeouts in the bench. resolveCompletionTokens
    // adds an env-configurable reasoning headroom for gpt-5/o-series only.
    const tokenLimit = isReasoningModel(this.model)
      ? resolveCompletionTokens(this.model, OPENAI_CLASSIFIER_MAX_OUTPUT_TOKENS)
      : OPENAI_CLASSIFIER_MAX_OUTPUT_TOKENS;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: INJECTION_CLASSIFIER_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
      [tokenLimitKey(this.model)]: tokenLimit,
    };
    // Reasoning effort: classifier emits a single yes/no — `low` is the
    // universally supported lowest value (some surfaces reject 'minimal').
    // Non-reasoning models: helper returns undefined and the param is omitted.
    const reasoningEffort = resolveReasoningEffort(this.model, 'classify');
    if (reasoningEffort !== undefined) {
      body['reasoning_effort'] = reasoningEffort;
    }

    const text = await retryWithBackoff(
      async () => {
        let response: Response;
        try {
          response = await fetchWithTimeout(
            this.endpoint,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify(body),
            },
            this.httpTimeoutMs,
            options?.abortSignal,
          );
        } catch (err) {
          if (isAbortError(err)) {
            const abortErr = new Error(`OpenAI injection classifier: request timed out after ${this.httpTimeoutMs}ms`);
            abortErr.name = 'AbortError';
            throw abortErr;
          }
          throw err;
        }

        if (!response.ok) {
          return {
            kind: 'http-error' as const,
            status: response.status,
            bodyText: await response.text().catch(() => ''),
            retryAfterSec: parseRetryAfterHeader(response),
          };
        }

        const data: unknown = await response.json();
        if (!isChatCompletionsResponse(data)) {
          throw new Error('OpenAI injection classifier: unexpected chat completions response');
        }

        const content = data.choices[0]?.message?.content;
        return {
          kind: 'success' as const,
          value: typeof content === 'string' ? content : '',
        };
      },
      OPENAI_INJECTION_RETRY_CONFIG,
      options?.abortSignal,
    );

    if (text.trim().length === 0) {
      bootstrapLogger.error('[OpenAiLLMInjectionClassifier] No text content in OpenAI response');
      return true;
    }

    try {
      const jsonText = normalizeClassifierJsonText(text);
      const parsedUnknown: unknown = JSON.parse(jsonText) as unknown;
      if (
        typeof parsedUnknown !== 'object' ||
        parsedUnknown === null ||
        Array.isArray(parsedUnknown) ||
        typeof (parsedUnknown as { is_injection?: unknown }).is_injection !== 'boolean'
      ) {
        bootstrapLogger.warn(
          { responseShape: typeof parsedUnknown },
          '[OpenAiLLMInjectionClassifier] Strict shape mismatch — fail-closed',
        );
        return true;
      }
      return (parsedUnknown as { is_injection: boolean }).is_injection;
    } catch {
      const preview = text.slice(0, OPENAI_PARSE_ERROR_PREVIEW_CHARS);
      bootstrapLogger.error(
        { responsePreview: preview },
        '[OpenAiLLMInjectionClassifier] Failed to parse OpenAI JSON response',
      );
      return true;
    }
  }
}

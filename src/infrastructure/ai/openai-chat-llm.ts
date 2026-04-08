/**
 * OpenAI Chat Completions (non-streaming).
 * Implements {@link ChatLlmPort}; compatible with OpenAI-compatible proxies (LiteLLM, Azure path-style base URLs).
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

/** Total fetch attempts (initial + retries) for transient OpenAI failures. */
const OPENAI_CHAT_MAX_ATTEMPTS = 4;
/** Fast backoff for 5xx / network blips. */
const OPENAI_CHAT_TRANSIENT_BACKOFF_BASE_MS = 250;
const OPENAI_CHAT_TRANSIENT_BACKOFF_CAP_MS = 2_000;
/** Slower exponential backoff for 429 quota windows. */
const OPENAI_CHAT_RATE_LIMIT_BACKOFF_BASE_MS = 2_000;
const OPENAI_CHAT_RATE_LIMIT_BACKOFF_CAP_MS = 30_000;
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
const HTTP_STATUS_5XX_MIN = 500;
const HTTP_STATUS_5XX_MAX_EXCLUSIVE = 600;
/** Truncate error bodies in thrown messages / logs. */
const OPENAI_CHAT_HTTP_ERROR_PREVIEW_CHARS = 200;
const OPENAI_CHAT_MALFORMED_JSON_PREVIEW_CHARS = 240;
const MILLISECONDS_PER_SECOND = 1000;

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

interface ChatCompletionsResponse {
  readonly model: string;
  readonly choices: readonly ChatCompletionsChoice[];
}

function isChatCompletionsResponse(v: unknown): v is ChatCompletionsResponse {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['model'] === 'string' && Array.isArray(o['choices']);
}

export class OpenAiChatLlm implements ChatLlmPort {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly httpTimeoutMs: number;

  constructor(options: OpenAiChatLlmOptions) {
    this.endpoint = `${trimTrailingSlash(options.baseUrl)}/chat/completions`;
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel;
    this.httpTimeoutMs = options.httpTimeoutMs;
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const model = request.model ?? this.defaultModel;
    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };
    if (request.temperature !== undefined) {
      body['temperature'] = request.temperature;
    }
    if (request.maxOutputTokens !== undefined) {
      body['max_tokens'] = request.maxOutputTokens;
    }
    if (request.seed !== undefined) {
      body['seed'] = request.seed;
    }

    // Retry on transient failures (429, 5xx, network).
    //
    // 429 (TPM / RPM throttling) uses slow exponential backoff: TPM windows
    // reset every 60 s, so millisecond-scale retries just hit the same wall.
    //   base: 2 s → 4 s → 8 s → 16 s (capped at MAX_RATE_LIMIT_DELAY_MS = 30 s)
    // Retry-After header from OpenAI overrides the computed delay.
    //
    // 5xx / network errors use fast jittered backoff (250 ms base, 2 s cap) —
    // these are infrastructure blips, not quota exhaustion.
    let lastError: unknown;
    for (let attempt = 1; attempt <= OPENAI_CHAT_MAX_ATTEMPTS; attempt++) {
      // Honor caller cancellation between attempts.
      if (request.abortSignal?.aborted === true) {
        throw new Error('OpenAI chat: aborted');
      }
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
          throw new Error(`OpenAI chat: request timed out after ${this.httpTimeoutMs}ms`);
        }
        // Network-level error: retry on attempts < MAX
        lastError = err;
        if (attempt < OPENAI_CHAT_MAX_ATTEMPTS) {
          await this.sleepWithJitter(
            attempt,
            OPENAI_CHAT_TRANSIENT_BACKOFF_BASE_MS,
            OPENAI_CHAT_TRANSIENT_BACKOFF_CAP_MS,
            request.abortSignal,
          );
          continue;
        }
        throw err;
      }

      if (!response.ok) {
        const status = response.status;
        const text = await response.text().catch(() => '');
        const isRateLimit = status === HTTP_STATUS_TOO_MANY_REQUESTS;
        const isTransient = isRateLimit
          || (status >= HTTP_STATUS_5XX_MIN && status < HTTP_STATUS_5XX_MAX_EXCLUSIVE);
        if (isTransient && attempt < OPENAI_CHAT_MAX_ATTEMPTS) {
          lastError = new Error(`OpenAI chat HTTP ${status}: ${text.slice(0, OPENAI_CHAT_HTTP_ERROR_PREVIEW_CHARS)}`);
          if (isRateLimit) {
            // Parse Retry-After header (OpenAI sends integer seconds).
            // Fall back to exponential: 2s, 4s, 8s, 16s (capped at 30s).
            const retryAfterHeader = response.headers.get('Retry-After');
            const retryAfterSec = retryAfterHeader !== null ? parseFloat(retryAfterHeader) : NaN;
            const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
              ? Math.min(retryAfterSec * MILLISECONDS_PER_SECOND, OPENAI_CHAT_RATE_LIMIT_BACKOFF_CAP_MS)
              : Math.min(
                OPENAI_CHAT_RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (attempt - 1),
                OPENAI_CHAT_RATE_LIMIT_BACKOFF_CAP_MS,
              );
            await this.sleepFixed(delayMs, request.abortSignal);
          } else {
            await this.sleepWithJitter(
              attempt,
              OPENAI_CHAT_TRANSIENT_BACKOFF_BASE_MS,
              OPENAI_CHAT_TRANSIENT_BACKOFF_CAP_MS,
              request.abortSignal,
            );
          }
          continue;
        }
        throw new Error(`OpenAI chat failed [HTTP ${status}]: ${text.slice(0, OPENAI_CHAT_HTTP_ERROR_PREVIEW_CHARS)}`);
      }

      const data: unknown = await response.json();
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

      return {
        text,
        model: data.model,
        finishReason: choice?.finish_reason ?? null,
      };
    }

    // Exhausted all retries
    throw lastError instanceof Error
      ? lastError
      : new Error('OpenAI chat: retry budget exhausted');
  }

  /** Exponential backoff with full jitter — used for 5xx / network errors. */
  private sleepWithJitter(
    attempt: number,
    baseMs: number,
    maxMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const expDelay = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
    const delay = Math.floor(Math.random() * expDelay);
    return this.sleepFixed(delay, signal);
  }

  /** Fixed-duration sleep, abortable via signal — used for rate-limit (429) waits. */
  private sleepFixed(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { resolve(); }, ms);
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('OpenAI chat: aborted'));
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
    });
  }
}

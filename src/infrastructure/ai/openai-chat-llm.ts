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

    // Retry on transient failures (429, 5xx, network) with full jitter.
    // OpenAI does NOT auto-retry on the underlying fetch path; without
    // this, a single rate-limit blip kills any in-flight request.
    const MAX_ATTEMPTS = 3;
    const BASE_DELAY_MS = 250;
    const MAX_DELAY_MS = 2_000;

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
        if (attempt < MAX_ATTEMPTS) {
          await this.sleepWithJitter(attempt, BASE_DELAY_MS, MAX_DELAY_MS, request.abortSignal);
          continue;
        }
        throw err;
      }

      if (!response.ok) {
        const status = response.status;
        const text = await response.text().catch(() => '');
        const isTransient = status === 429 || (status >= 500 && status < 600);
        if (isTransient && attempt < MAX_ATTEMPTS) {
          lastError = new Error(`OpenAI chat HTTP ${status}: ${text.slice(0, 200)}`);
          await this.sleepWithJitter(attempt, BASE_DELAY_MS, MAX_DELAY_MS, request.abortSignal);
          continue;
        }
        throw new Error(`OpenAI chat failed [HTTP ${status}]: ${text.slice(0, 200)}`);
      }

      const data: unknown = await response.json();
      if (!isChatCompletionsResponse(data)) {
        throw new Error(
          `OpenAI chat: unexpected response — ${JSON.stringify(data).slice(0, 240)}`,
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

  private sleepWithJitter(
    attempt: number,
    baseMs: number,
    maxMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const expDelay = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
    const delay = Math.floor(Math.random() * expDelay);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { resolve(); }, delay);
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

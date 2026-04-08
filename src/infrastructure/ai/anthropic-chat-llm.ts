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

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_API_VERSION = '2023-06-01';
const ANTHROPIC_CHAT_MAX_ATTEMPTS = 4;
const ANTHROPIC_TRANSIENT_BACKOFF_BASE_MS = 250;
const ANTHROPIC_TRANSIENT_BACKOFF_CAP_MS = 2_000;
const ANTHROPIC_RATE_LIMIT_BACKOFF_BASE_MS = 2_000;
const ANTHROPIC_RATE_LIMIT_BACKOFF_CAP_MS = 30_000;
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
const HTTP_STATUS_5XX_MIN = 500;
const HTTP_STATUS_5XX_MAX_EXCLUSIVE = 600;
const ERROR_PREVIEW_CHARS = 200;
const MILLISECONDS_PER_SECOND = 1000;
const ANTHROPIC_DEFAULT_MAX_TOKENS = 1024;

export interface AnthropicChatLlmOptions {
  readonly apiKey: string;
  readonly defaultModel: string;
  readonly httpTimeoutMs: number;
}

interface AnthropicMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

interface AnthropicResponse {
  readonly id: string;
  readonly model: string;
  readonly stop_reason: string | null;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
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
      body['system'] = systemPrompt;
    }
    if (request.temperature !== undefined) {
      body['temperature'] = request.temperature;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= ANTHROPIC_CHAT_MAX_ATTEMPTS; attempt++) {
      if (request.abortSignal?.aborted === true) {
        throw new Error('Anthropic chat: aborted');
      }

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
          throw new Error(`Anthropic chat: request timed out after ${this.httpTimeoutMs}ms`);
        }
        lastError = err;
        if (attempt < ANTHROPIC_CHAT_MAX_ATTEMPTS) {
          await this.sleepWithJitter(attempt, ANTHROPIC_TRANSIENT_BACKOFF_BASE_MS, ANTHROPIC_TRANSIENT_BACKOFF_CAP_MS, request.abortSignal);
          continue;
        }
        throw err;
      }

      if (!response.ok) {
        const status = response.status;
        const text = await response.text().catch(() => '');
        const isRateLimit = status === HTTP_STATUS_TOO_MANY_REQUESTS;
        const isTransient = isRateLimit || (status >= HTTP_STATUS_5XX_MIN && status < HTTP_STATUS_5XX_MAX_EXCLUSIVE);
        if (isTransient && attempt < ANTHROPIC_CHAT_MAX_ATTEMPTS) {
          lastError = new Error(`Anthropic chat HTTP ${status}: ${text.slice(0, ERROR_PREVIEW_CHARS)}`);
          if (isRateLimit) {
            const retryAfterHeader = response.headers.get('retry-after');
            const retryAfterSec = retryAfterHeader !== null ? parseFloat(retryAfterHeader) : NaN;
            const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
              ? Math.min(retryAfterSec * MILLISECONDS_PER_SECOND, ANTHROPIC_RATE_LIMIT_BACKOFF_CAP_MS)
              : Math.min(ANTHROPIC_RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (attempt - 1), ANTHROPIC_RATE_LIMIT_BACKOFF_CAP_MS);
            await this.sleepFixed(delayMs, request.abortSignal);
          } else {
            await this.sleepWithJitter(attempt, ANTHROPIC_TRANSIENT_BACKOFF_BASE_MS, ANTHROPIC_TRANSIENT_BACKOFF_CAP_MS, request.abortSignal);
          }
          continue;
        }
        throw new Error(`Anthropic chat failed [HTTP ${status}]: ${text.slice(0, ERROR_PREVIEW_CHARS)}`);
      }

      const data: unknown = await response.json();
      if (!isAnthropicResponse(data)) {
        throw new Error(`Anthropic chat: unexpected response — ${JSON.stringify(data).slice(0, ERROR_PREVIEW_CHARS)}`);
      }

      const textBlock = data.content.find((b) => b.type === 'text');
      const text = textBlock?.text ?? '';

      return {
        text,
        model: data.model,
        finishReason: data.stop_reason,
      };
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Anthropic chat: retry budget exhausted');
  }

  private sleepWithJitter(attempt: number, baseMs: number, maxMs: number, signal: AbortSignal | undefined): Promise<void> {
    const expDelay = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
    const delay = Math.floor(Math.random() * expDelay);
    return this.sleepFixed(delay, signal);
  }

  private sleepFixed(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { resolve(); }, ms);
      if (signal) {
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(new Error('Anthropic chat: aborted'));
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

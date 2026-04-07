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
      );
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(
          `OpenAI chat: request timed out after ${this.httpTimeoutMs}ms`,
        );
      }
      throw err;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OpenAI chat failed [HTTP ${response.status}]: ${text.slice(0, 200)}`);
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
}

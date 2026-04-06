/**
 * OpenAI (or OpenAI-compatible) embeddings via HTTP.
 * Implements {@link EmbeddingServicePort} with Bearer auth.
 */

import type { EmbeddingServicePort } from '../../domain/retrieval/port/embedding-service.port.js';
import {
  fetchWithTimeout,
  isAbortError,
} from '../http/fetch-with-timeout.js';
import { embeddingsFromOpenAiResponse } from './openai-json.js';

export interface OpenAiEmbeddingServiceOptions {
  /** API base including `/v1`, e.g. `https://api.openai.com/v1` */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly httpTimeoutMs: number;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export class OpenAiEmbeddingService implements EmbeddingServicePort {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly httpTimeoutMs: number;

  constructor(options: OpenAiEmbeddingServiceOptions) {
    this.endpoint = `${trimTrailingSlash(options.baseUrl)}/embeddings`;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.httpTimeoutMs = options.httpTimeoutMs;
  }

  async embed(text: string): Promise<readonly number[]> {
    const results = await this.callApi(text);
    const first = results[0];
    if (first === undefined) {
      throw new Error('OpenAI embeddings: empty data array for single input');
    }
    return first;
  }

  async embedBatch(
    texts: readonly string[],
  ): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return [];
    return this.callApi([...texts]);
  }

  private async callApi(
    input: string | string[],
  ): Promise<readonly (readonly number[])[]> {
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
          body: JSON.stringify({ model: this.model, input, dimensions: 128 }),
        },
        this.httpTimeoutMs,
      );
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(
          `OpenAI embeddings: request timed out after ${this.httpTimeoutMs}ms`,
        );
      }
      throw err;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `OpenAI embeddings failed [HTTP ${response.status}]: ${text}`,
      );
    }

    const data: unknown = await response.json();
    return embeddingsFromOpenAiResponse(data);
  }
}

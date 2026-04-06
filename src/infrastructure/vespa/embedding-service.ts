/**
 * HTTP-based implementation of {@link EmbeddingServicePort}.
 *
 * Calls a remote embedding microservice (e.g. a BGE-M3 server) via the
 * OpenAI-compatible embeddings API shape:
 *   POST /embeddings  { model, input }  →  { data: [{ embedding: number[] }] }
 */

import { config } from '../../config/env.js';
import type { EmbeddingServicePort } from '../../domain/retrieval/port/embedding-service.port.js';
import { embeddingsFromOpenAiResponse } from '../ai/openai-json.js';
import {
  fetchWithTimeout,
  isAbortError,
} from '../http/fetch-with-timeout.js';

// ---------------------------------------------------------------------------
// HttpEmbeddingService
// ---------------------------------------------------------------------------

/**
 * Embedding service adapter that calls a remote HTTP embedding API.
 *
 * The target API must accept POST requests with a JSON body of
 * `{ model: string, input: string | string[] }` and respond with a JSON
 * body of `{ data: [{ index: number, embedding: number[] }] }`.
 */
export class HttpEmbeddingService implements EmbeddingServicePort {
  private readonly url: string;
  private readonly model: string;
  private readonly httpTimeoutMs: number;

  constructor(options?: {
    readonly url?: string;
    readonly model?: string;
    readonly httpTimeoutMs?: number;
  }) {
    this.url = options?.url ?? config.embedding.url;
    this.model = options?.model ?? config.embedding.model;
    this.httpTimeoutMs = options?.httpTimeoutMs ?? config.embedding.httpTimeoutMs;
  }

  // -------------------------------------------------------------------------
  // embed
  // -------------------------------------------------------------------------

  /**
   * Generates an embedding vector for a single text input.
   *
   * @param text - The text to embed.
   * @returns A dense vector of floating-point numbers.
   * @throws {Error} On HTTP error or malformed API response.
   */
  async embed(text: string): Promise<readonly number[]> {
    const results = await this.callApi(text);
    const first = results[0];
    if (first === undefined) {
      throw new Error(
        'Embedding service: API returned an empty data array for a single input.',
      );
    }
    return first;
  }

  // -------------------------------------------------------------------------
  // embedBatch
  // -------------------------------------------------------------------------

  /**
   * Generates embedding vectors for multiple texts in a single batch call.
   *
   * Results are returned in the same order as the input texts. The API
   * response `index` field is used to reorder results if the server returns
   * them out of order.
   *
   * @param texts - The texts to embed.
   * @returns One embedding per input text, in input order.
   * @throws {Error} On HTTP error or malformed API response.
   */
  async embedBatch(
    texts: readonly string[],
  ): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return [];
    return this.callApi([...texts]);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Calls the embedding API and returns embeddings ordered by their `index`.
   *
   * @param input - A single string or an array of strings.
   * @returns An array of embedding vectors in input order.
   */
  private async callApi(
    input: string | string[],
  ): Promise<readonly (readonly number[])[]> {
    const endpoint = `${this.url}/embeddings`;

    let response: Response;
    try {
      response = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, input }),
        },
        this.httpTimeoutMs,
      );
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(
          `Embedding service: request timed out after ${this.httpTimeoutMs}ms`,
        );
      }
      throw err;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Embedding service call failed [HTTP ${response.status}]: ${text}`,
      );
    }

    const data: unknown = await response.json();
    return embeddingsFromOpenAiResponse(data);
  }
}

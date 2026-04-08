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
import { PipelineDebugStep } from '../../observability/pipeline-debug-steps.js';
import { pipelineDebug } from '../../observability/request-pipeline-debug.js';

const HTTP_EMBEDDING_SERVICE_ERROR_PREVIEW_CHARS = 200;

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
  private readonly expectedDimension: number | undefined;

  constructor(options?: {
    readonly url?: string;
    readonly model?: string;
    readonly httpTimeoutMs?: number;
    readonly expectedDimension?: number;
  }) {
    const url = options?.url ?? config.embedding.url;
    if (url === undefined) {
      throw new Error('HttpEmbeddingService: EMBEDDING_SERVICE_URL is required when not using OpenAI embeddings');
    }
    this.url = url;
    this.model = options?.model ?? config.embedding.model;
    this.httpTimeoutMs = options?.httpTimeoutMs ?? config.embedding.httpTimeoutMs;
    this.expectedDimension = options?.expectedDimension ?? config.embedding.dimension;
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
    const batchSize = Array.isArray(input) ? input.length : 1;
    const httpStart = Date.now();

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
        pipelineDebug(
          {
            step: PipelineDebugStep.HTTP_EMBEDDING_TIMEOUT,
            provider: 'http_embedding_service',
            model: this.model,
            batch_size: batchSize,
            latency_ms: Date.now() - httpStart,
          },
          'pipeline embedding HTTP',
        );
        throw new Error(
          `Embedding service: request timed out after ${this.httpTimeoutMs}ms`,
        );
      }
      pipelineDebug(
        {
          step: PipelineDebugStep.HTTP_EMBEDDING_NETWORK_ERROR,
          provider: 'http_embedding_service',
          model: this.model,
          batch_size: batchSize,
        },
        'pipeline embedding HTTP',
      );
      throw err;
    }

    if (!response.ok) {
      const status = response.status;
      pipelineDebug(
        {
          step: PipelineDebugStep.HTTP_EMBEDDING_HTTP_ERROR,
          provider: 'http_embedding_service',
          model: this.model,
          batch_size: batchSize,
          http_status: status,
          latency_ms: Date.now() - httpStart,
        },
        'pipeline embedding HTTP',
      );
      const text = await response.text().catch(() => '');
      throw new Error(
        `Embedding service call failed [HTTP ${status}]: ${text.slice(0, HTTP_EMBEDDING_SERVICE_ERROR_PREVIEW_CHARS)}`,
      );
    }

    const data: unknown = await response.json();
    try {
      const vectors = embeddingsFromOpenAiResponse(data);

      // Validate embedding vectors before returning:
      // 1. Non-finite values (NaN, ±Infinity) in vectors cause Vespa ANN to produce
      //    silent wrong results — typeof NaN === 'number' passes the OpenAI response
      //    parser, so we must check finiteness explicitly here.
      // 2. Dimension mismatch indicates a model swap or corrupted response.
      for (const vec of vectors) {
        if (vec.length === 0) {
          throw new Error(
            'Embedding vector is empty (0 dimensions)',
          );
        }
        if (!vec.every(Number.isFinite)) {
          throw new Error(
            'Embedding contains non-finite values (NaN or Infinity)',
          );
        }
        if (this.expectedDimension !== undefined && vec.length !== this.expectedDimension) {
          throw new Error(
            `Embedding dimension mismatch: expected ${this.expectedDimension}, got ${vec.length}`,
          );
        }
      }

      pipelineDebug(
        {
          step: PipelineDebugStep.HTTP_EMBEDDING_OK,
          provider: 'http_embedding_service',
          model: this.model,
          batch_size: batchSize,
          latency_ms: Date.now() - httpStart,
          http_status: response.status,
        },
        'pipeline embedding HTTP',
      );
      return vectors;
    } catch (error) {
      pipelineDebug(
        {
          step: PipelineDebugStep.HTTP_EMBEDDING_PARSE_ERROR,
          provider: 'http_embedding_service',
          model: this.model,
          batch_size: batchSize,
          latency_ms: Date.now() - httpStart,
        },
        'pipeline embedding HTTP',
      );
      throw new Error(
        `Embedding service: unexpected response shape${error instanceof Error ? ` (${error.message})` : ''}`,
      );
    }
  }
}

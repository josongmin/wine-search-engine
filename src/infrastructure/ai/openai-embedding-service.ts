/**
 * OpenAI (or OpenAI-compatible) embeddings via HTTP.
 * Implements {@link EmbeddingServicePort} with Bearer auth.
 */

import type { EmbeddingServicePort } from '../../domain/retrieval/port/embedding-service.port.js';
import {
  fetchWithTimeout,
  isAbortError,
} from '../http/fetch-with-timeout.js';
import { PipelineDebugStep } from '../../observability/pipeline-debug-steps.js';
import { pipelineDebug } from '../../observability/request-pipeline-debug.js';
import { embeddingsFromOpenAiResponse } from './openai-json.js';

/** Default vector width for BGE-M3 / Vespa ANN field alignment. */
const OPENAI_EMBEDDING_DEFAULT_DIMENSIONS = 1024;
/** Truncate HTTP error bodies in thrown messages. */
const OPENAI_EMBEDDING_HTTP_ERROR_PREVIEW_CHARS = 200;

export interface OpenAiEmbeddingServiceOptions {
  /** API base including `/v1`, e.g. `https://api.openai.com/v1` */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly httpTimeoutMs: number;
  /** Requested embedding dimension. Defaults to 1024 (BGE-M3 / Vespa schema). */
  readonly dimensions?: number;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export class OpenAiEmbeddingService implements EmbeddingServicePort {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly httpTimeoutMs: number;
  private readonly dimensions: number;

  constructor(options: OpenAiEmbeddingServiceOptions) {
    this.endpoint = `${trimTrailingSlash(options.baseUrl)}/embeddings`;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.httpTimeoutMs = options.httpTimeoutMs;
    this.dimensions = options.dimensions ?? OPENAI_EMBEDDING_DEFAULT_DIMENSIONS;
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
    const batchSize = Array.isArray(input) ? input.length : 1;
    const httpStart = Date.now();

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
          body: JSON.stringify({ model: this.model, input, dimensions: this.dimensions }),
        },
        this.httpTimeoutMs,
      );
    } catch (err) {
      if (isAbortError(err)) {
        pipelineDebug(
          {
            step: PipelineDebugStep.HTTP_EMBEDDING_TIMEOUT,
            provider: 'openai_compatible',
            model: this.model,
            batch_size: batchSize,
            latency_ms: Date.now() - httpStart,
          },
          'pipeline OpenAI-compatible embedding HTTP',
        );
        throw new Error(
          `OpenAI embeddings: request timed out after ${this.httpTimeoutMs}ms`,
        );
      }
      pipelineDebug(
        {
          step: PipelineDebugStep.HTTP_EMBEDDING_NETWORK_ERROR,
          provider: 'openai_compatible',
          model: this.model,
          batch_size: batchSize,
        },
        'pipeline OpenAI-compatible embedding HTTP',
      );
      throw err;
    }

    if (!response.ok) {
      const status = response.status;
      pipelineDebug(
        {
          step: PipelineDebugStep.HTTP_EMBEDDING_HTTP_ERROR,
          provider: 'openai_compatible',
          model: this.model,
          batch_size: batchSize,
          http_status: status,
          latency_ms: Date.now() - httpStart,
        },
        'pipeline OpenAI-compatible embedding HTTP',
      );
      const text = await response.text().catch(() => '');
      throw new Error(
        `OpenAI embeddings failed [HTTP ${status}]: ${text.slice(0, OPENAI_EMBEDDING_HTTP_ERROR_PREVIEW_CHARS)}`,
      );
    }

    const data: unknown = await response.json();
    try {
      // Pass batchSize so length/index mismatches throw rather than silently
      // mis-aligning text→vector pairs (proxies sometimes drop or re-number).
      const vectors = embeddingsFromOpenAiResponse(data, batchSize);
      for (const vec of vectors) {
        if (vec.length !== this.dimensions) {
          throw new Error(
            `OpenAI embedding dimension mismatch: expected ${this.dimensions}, got ${vec.length}`,
          );
        }
        if (!vec.every(Number.isFinite)) {
          throw new Error('OpenAI embedding contains non-finite values');
        }
      }
      pipelineDebug(
        {
          step: PipelineDebugStep.HTTP_EMBEDDING_OK,
          provider: 'openai_compatible',
          model: this.model,
          batch_size: batchSize,
          latency_ms: Date.now() - httpStart,
          http_status: response.status,
        },
        'pipeline OpenAI-compatible embedding HTTP',
      );
      return vectors;
    } catch (parseErr) {
      pipelineDebug(
        {
          step: PipelineDebugStep.HTTP_EMBEDDING_PARSE_ERROR,
          provider: 'openai_compatible',
          model: this.model,
          batch_size: batchSize,
          latency_ms: Date.now() - httpStart,
        },
        'pipeline OpenAI-compatible embedding HTTP',
      );
      throw parseErr;
    }
  }
}

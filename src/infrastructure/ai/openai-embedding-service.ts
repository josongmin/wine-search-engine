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
import {
  runUnderLlmBreaker,
} from './llm-circuit-breaker-classifier.js';
import {
  createOpenAiKeyPool,
  isOpenAiKeyPoolRotatableError,
  openAiKeyPoolExhaustedError,
  orderedOpenAiKeySlots,
  type OpenAiKeySlot,
} from './openai-key-pool.js';

/** Default vector width for BGE-M3 / Vespa ANN field alignment. */
const OPENAI_EMBEDDING_DEFAULT_DIMENSIONS = 1024;
/** Truncate HTTP error bodies in thrown messages. */
const OPENAI_EMBEDDING_HTTP_ERROR_PREVIEW_CHARS = 200;

/** Circuit breaker thresholds for the OpenAI embedding endpoint. */
const OPENAI_EMBEDDING_BREAKER_NAME = 'openai-embedding';
const OPENAI_EMBEDDING_FAILURE_THRESHOLD = 3;
const OPENAI_EMBEDDING_RECOVERY_TIMEOUT_MS = 30_000;
const OPENAI_EMBEDDING_HALF_OPEN_MAX = 2;

interface OpenAiEmbeddingServiceOptions {
  /** API base including `/v1`, e.g. `https://api.openai.com/v1` */
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly apiKeys?: readonly string[] | undefined;
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
  private readonly keySlots: readonly OpenAiKeySlot[];
  private readonly model: string;
  private readonly httpTimeoutMs: number;
  private readonly dimensions: number;
  private nextSlotIndex = 0;

  constructor(options: OpenAiEmbeddingServiceOptions) {
    this.endpoint = `${trimTrailingSlash(options.baseUrl)}/embeddings`;
    this.keySlots = createOpenAiKeyPool({
      baseBreakerName: OPENAI_EMBEDDING_BREAKER_NAME,
      apiKey: options.apiKey,
      apiKeys: options.apiKeys,
      failureThreshold: OPENAI_EMBEDDING_FAILURE_THRESHOLD,
      recoveryTimeoutMs: OPENAI_EMBEDDING_RECOVERY_TIMEOUT_MS,
      halfOpenMaxAttempts: OPENAI_EMBEDDING_HALF_OPEN_MAX,
    });
    this.model = options.model;
    this.httpTimeoutMs = options.httpTimeoutMs;
    this.dimensions = options.dimensions ?? OPENAI_EMBEDDING_DEFAULT_DIMENSIONS;
  }

  async embed(text: string): Promise<readonly number[]> {
    const results = await this.runWithKeyPool((slot) => this.callApi(text, slot.apiKey));
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
    return this.runWithKeyPool((slot) => this.callApi([...texts], slot.apiKey));
  }

  private async runWithKeyPool<T>(
    fn: (slot: OpenAiKeySlot) => Promise<T>,
  ): Promise<T> {
    const slots = this.nextOrderedSlots();
    const errors: unknown[] = [];

    for (const slot of slots) {
      try {
        return await runUnderLlmBreaker(slot.circuitBreaker, slot.breakerName, () => fn(slot));
      } catch (err) {
        errors.push(err);
        if (this.keySlots.length === 1 || !isOpenAiKeyPoolRotatableError(err)) {
          throw err;
        }
      }
    }

    throw openAiKeyPoolExhaustedError('OpenAI embeddings', this.keySlots.length, errors);
  }

  private nextOrderedSlots(): readonly OpenAiKeySlot[] {
    const startIndex = this.nextSlotIndex;
    this.nextSlotIndex = (this.nextSlotIndex + 1) % this.keySlots.length;
    return orderedOpenAiKeySlots(this.keySlots, startIndex);
  }

  private async callApi(
    input: string | string[],
    apiKey: string,
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
            Authorization: `Bearer ${apiKey}`,
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

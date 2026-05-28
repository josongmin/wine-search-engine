/**
 * OpenAI (or OpenAI-compatible) embeddings via HTTP.
 * Implements {@link EmbeddingServicePort} with Bearer auth.
 */

import { createHash } from 'node:crypto';
import type { EmbeddingServicePort } from '../../domain/retrieval/port/embedding-service.port.js';
import {
  fetchWithTimeout,
  isAbortError,
} from '../http/fetch-with-timeout.js';
import { PipelineDebugStep } from '../../domain/observability/pipeline-debug-steps.js';
import { pipelineDebug } from '../../domain/observability/request-pipeline-debug.js';
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

/** Default vector width for the Vespa ANN field (matches EMBEDDING_DIMENSION SSoT). */
const OPENAI_EMBEDDING_DEFAULT_DIMENSIONS = 1024;
/** Truncate HTTP error bodies in thrown messages. */
const OPENAI_EMBEDDING_HTTP_ERROR_PREVIEW_CHARS = 200;

/**
 * Circuit breaker thresholds for the OpenAI embedding endpoint.
 *
 * Deliberately MORE aggressive than the shared LLM defaults
 * (DEFAULT_BREAKER_FAILURE_THRESHOLD=5, DEFAULT_RECOVERY_TIMEOUT_MS=60_000,
 * DEFAULT_HALF_OPEN_ATTEMPTS=3): embeddings sit on the synchronous retrieval
 * hot path, so we trip faster (3 failures) and recover faster (30s) to avoid
 * stalling query latency on a degraded endpoint. Not a SSoT drift — keep local.
 */
const OPENAI_EMBEDDING_BREAKER_NAME = 'openai-embedding';
const OPENAI_EMBEDDING_FAILURE_THRESHOLD = 3;
const OPENAI_EMBEDDING_RECOVERY_TIMEOUT_MS = 30_000;
const OPENAI_EMBEDDING_HALF_OPEN_MAX = 2;

/**
 * ML-model SemVer identifier for the production embedding artifact.
 *
 * Industry-standard practice: pinning the model NAME alone is insufficient
 * — OpenAI silently rotates underlying weights for "text-embedding-3-small"
 * (and other endpoints) without changing the slug, which can drift vector
 * geometry mid-deployment. The `@vN` suffix lets us namespace the cache
 * (and any persisted-vector catalog) by an explicit version we bump
 * deliberately when we choose to re-embed the corpus.
 *
 * Bump procedure:
 *   1. Run the offline eval against the new candidate version.
 *   2. Bump the suffix here (v1 → v2).
 *   3. Re-embed the corpus via ETL; cache keys diverge automatically,
 *      so old vectors live in dead key space and expire via TTL.
 */
export const EMBEDDING_MODEL_VERSION = 'text-embedding-3-small@v1' as const;

/** Truncate SHA-256 hex in deterministic cache keys (collision-safe, bounded length). */
const EMBEDDING_CACHE_KEY_HASH_HEX_LENGTH = 16;

/**
 * Compute a deterministic cache key for an embedding of `text` under
 * `modelVersion`. Pure function — no I/O, no side effects.
 *
 * Determinism contract:
 *   - Same `{text, modelVersion}` → same key, byte-for-byte.
 *   - Different modelVersion → different key (cache isolation across
 *     model upgrades; no accidental cross-version reuse).
 *   - Korean text in NFD vs NFC normalizes to NFC first, so visually
 *     identical strings collide on the same key even if the input
 *     decomposition differs (a common bug when text traverses OS,
 *     browser, or HTTP boundaries).
 *
 * The returned key is shaped `embedding:<modelVersion>:<sha256-16hex>`.
 * It is independent of the runtime Redis layer so unit tests can assert
 * against it without standing up Redis.
 */
export function getEmbeddingCacheKey(
  text: string,
  modelVersion: string = EMBEDDING_MODEL_VERSION,
): string {
  // NFC normalization — Korean (한글), accented Latin (é/ñ), and emoji
  // ZWJ sequences round-trip through HTTP/JSON in inconsistent forms;
  // canonicalizing eliminates that source of cache-key fragmentation.
  const normalized = text.normalize('NFC');
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, EMBEDDING_CACHE_KEY_HASH_HEX_LENGTH);
  return `embedding:${modelVersion}:${hash}`;
}

/**
 * True when `text` is non-empty after NFC normalization and trimming.
 * Used to reject empty / whitespace-only inputs at the API boundary
 * rather than silently emitting an all-zero embedding (which downstream
 * scoring math would happily multiply with, producing NaN/zero scores).
 */
function isEmbeddableText(text: string): boolean {
  return text.normalize('NFC').trim().length > 0;
}

interface OpenAiEmbeddingServiceOptions {
  /** API base including `/v1`, e.g. `https://api.openai.com/v1` */
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly apiKeys?: readonly string[] | undefined;
  readonly model: string;
  readonly httpTimeoutMs: number;
  /** Requested embedding dimension. Defaults to 1024 to match Vespa schema (EMBEDDING_DIMENSION SSoT). */
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
    // Reject empty / whitespace-only at the API boundary — emitting an
    // all-zero embedding for "" would corrupt downstream cosine scores
    // (NaN from zero-norm vectors, or silent ties at the top of the rank).
    if (!isEmbeddableText(text)) {
      throw new Error('OpenAI embeddings: text must be non-empty after trim');
    }
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
    // Reject if ANY input is empty/whitespace-only — partial-failure
    // batching silently mis-aligns text→vector pairs on the caller side.
    for (let i = 0; i < texts.length; i++) {
      const candidate = texts[i] ?? '';
      if (!isEmbeddableText(candidate)) {
        throw new Error(
          `OpenAI embeddings: text at index ${i} must be non-empty after trim`,
        );
      }
    }
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

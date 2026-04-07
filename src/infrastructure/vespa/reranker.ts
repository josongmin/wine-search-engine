/**
 * HTTP cross-encoder implementation of {@link RerankerPort}.
 *
 * Calls a remote reranker microservice that accepts (query, text) pairs and
 * returns relevance scores. The adapter sorts results by score descending and
 * returns at most `limit` results.
 */

import { config } from '../../config/env.js';
import type {
  RerankerPort,
  RerankCandidate,
  RerankResult,
} from '../../domain/ranking/port/reranker.port.js';
import {
  fetchWithTimeout,
  isAbortError,
} from '../http/fetch-with-timeout.js';
import type { EntityId } from '../../domain/shared/types/index.js';
import { isEntityId } from '../../domain/shared/types/index.js';
import { PipelineDebugStep } from '../../observability/pipeline-debug-steps.js';
import { pipelineDebug } from '../../observability/request-pipeline-debug.js';

// ---------------------------------------------------------------------------
// API response shapes
// ---------------------------------------------------------------------------

/**
 * A single scored pair returned by the reranker API.
 * Follows the common cross-encoder HTTP API convention.
 */
interface RerankApiResult {
  readonly index: number;
  readonly score: number;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isRerankApiResult(v: unknown): v is RerankApiResult {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj['index'] === 'number' && typeof obj['score'] === 'number';
}

function isRerankApiResultArray(v: unknown): v is RerankApiResult[] {
  return Array.isArray(v) && v.every(isRerankApiResult);
}

// ---------------------------------------------------------------------------
// HttpCrossEncoderReranker
// ---------------------------------------------------------------------------

/**
 * Cross-encoder reranker adapter that calls a remote HTTP reranking API.
 *
 * Expected API shape:
 *   POST {url}/rerank
 *   Body: { model: string, query: string, texts: string[] }
 *   Response: { results: [{ index: number, score: number }] }
 *
 * If the API returns results in any order, they are re-ordered by the
 * `index` field to match the input `candidates` array before sorting by
 * score.
 */
export class HttpCrossEncoderReranker implements RerankerPort {
  private readonly url: string;
  private readonly httpTimeoutMs: number;

  constructor(options?: {
    readonly url?: string;
    readonly httpTimeoutMs?: number;
  }) {
    const resolvedUrl = options?.url ?? config.reranker.url;
    if (resolvedUrl === undefined) {
      throw new Error('HttpCrossEncoderReranker requires a configured reranker URL');
    }
    this.url = resolvedUrl;
    this.httpTimeoutMs = options?.httpTimeoutMs ?? config.reranker.httpTimeoutMs;
  }

  // -------------------------------------------------------------------------
  // rerank
  // -------------------------------------------------------------------------

  /**
   * Reranks candidates using a remote cross-encoder model.
   *
   * All candidates are sent in a single batch request. The response scores
   * are paired back with their entity IDs by index position, sorted
   * descending, and truncated to `limit`.
   *
   * @param query - The user query string.
   * @param candidates - Candidates to rerank.
   * @param limit - Maximum number of results to return.
   * @returns Top `limit` reranked results, sorted by score descending.
   * @throws {Error} On HTTP error or malformed API response.
   */
  async rerank(
    query: string,
    candidates: readonly RerankCandidate[],
    limit: number,
  ): Promise<readonly RerankResult[]> {
    if (candidates.length === 0) return [];

    const texts = candidates.map((c) => c.text);
    const endpoint = `${this.url}/rerank`;
    const httpStart = Date.now();

    let response: Response;
    try {
      response = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, texts }),
        },
        this.httpTimeoutMs,
      );
    } catch (err) {
      if (isAbortError(err)) {
        pipelineDebug(
          {
            step: PipelineDebugStep.HTTP_RERANKER_TIMEOUT,
            candidate_count: candidates.length,
            limit,
            latency_ms: Date.now() - httpStart,
          },
          'pipeline cross-encoder reranker HTTP',
        );
        throw new Error(
          `Reranker service: request timed out after ${this.httpTimeoutMs}ms`,
        );
      }
      pipelineDebug(
        {
          step: PipelineDebugStep.HTTP_RERANKER_NETWORK_ERROR,
          candidate_count: candidates.length,
          limit,
        },
        'pipeline cross-encoder reranker HTTP',
      );
      throw err;
    }

    if (!response.ok) {
      const status = response.status;
      pipelineDebug(
        {
          step: PipelineDebugStep.HTTP_RERANKER_HTTP_ERROR,
          http_status: status,
          candidate_count: candidates.length,
          limit,
          latency_ms: Date.now() - httpStart,
        },
        'pipeline cross-encoder reranker HTTP',
      );
      const text = await response.text().catch(() => '');
      throw new Error(
        `Reranker service call failed [HTTP ${status}]: ${text.slice(0, 200)}`,
      );
    }

    const data: unknown = await response.json();
    let apiResults: RerankApiResult[];
    try {
      apiResults = this.parseResponse(data);
    } catch (parseErr) {
      pipelineDebug(
        {
          step: PipelineDebugStep.HTTP_RERANKER_PARSE_ERROR,
          candidate_count: candidates.length,
          limit,
          latency_ms: Date.now() - httpStart,
        },
        'pipeline cross-encoder reranker HTTP',
      );
      throw parseErr;
    }

    pipelineDebug(
      {
        step: PipelineDebugStep.HTTP_RERANKER_OK,
        candidate_count: candidates.length,
        limit,
        latency_ms: Date.now() - httpStart,
        http_status: response.status,
      },
      'pipeline cross-encoder reranker HTTP',
    );

    // Pair scores with entity IDs via index, then sort by score descending.
    const scored: Array<{ entityId: EntityId; score: number }> = [];
    let droppedCount = 0;

    for (const result of apiResults) {
      const candidate = candidates[result.index];
      if (candidate === undefined) {
        droppedCount++;
        continue;
      }
      // Validate the entityId at runtime (branded type safety).
      if (!isEntityId(candidate.entityId)) {
        droppedCount++;
        continue;
      }
      // Guard against non-finite scores from the reranker API — NaN/Infinity
      // would corrupt the downstream sort and blend with original scores.
      if (!Number.isFinite(result.score)) {
        droppedCount++;
        continue;
      }
      scored.push({ entityId: candidate.entityId, score: result.score });
    }

    if (droppedCount > 0) {
      pipelineDebug(
        {
          step: PipelineDebugStep.HTTP_RERANKER_OK,
          reranker_dropped_count: droppedCount,
          api_result_count: apiResults.length,
          candidate_count: candidates.length,
        },
        'pipeline reranker dropped results due to out-of-bounds index or invalid entityId',
      );
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((item, index) => ({
      entityId: item.entityId,
      score: item.score,
      rank: index + 1,
    } satisfies RerankResult));
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Parses the raw reranker API response into a typed array of results.
   *
   * Accepts two common response shapes:
   * 1. `{ results: [...] }` — nested under a `results` key.
   * 2. A top-level array of `{ index, score }` objects.
   *
   * @param data - The raw parsed JSON from the API.
   * @returns An array of `{ index, score }` pairs.
   * @throws {Error} If the response cannot be parsed.
   */
  private parseResponse(data: unknown): RerankApiResult[] {
    // Shape 1: top-level array.
    if (isRerankApiResultArray(data)) return data;

    // Shape 2: { results: [...] }
    if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      const results = obj['results'];
      if (isRerankApiResultArray(results)) return results;
    }

    throw new Error(
      `Reranker service: unexpected response shape — ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
}

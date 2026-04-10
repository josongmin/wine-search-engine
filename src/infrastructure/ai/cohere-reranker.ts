import type {
  RerankerPort,
  RerankCandidate,
  RerankResult,
} from '../../domain/ranking/port/reranker.port.js';
import type { EntityId } from '../../domain/shared/types/index.js';
import { isEntityId } from '../../domain/shared/types/index.js';
import {
  createCircuitBreaker,
  type CircuitBreaker,
} from '../../domain/shared/circuit-breaker/circuit-breaker.js';
import { globalCircuitBreakerRegistry } from '../../observability/circuit-breaker-registry.js';
import {
  fetchWithTimeout,
  isAbortError,
} from '../http/fetch-with-timeout.js';
import { clamp01 } from '../../domain/shared/utils/clamp.js';
import { PipelineDebugStep } from '../../observability/pipeline-debug-steps.js';
import { pipelineDebug } from '../../observability/request-pipeline-debug.js';
import { runUnderLlmBreaker } from './llm-circuit-breaker-classifier.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

const COHERE_RERANKER_HTTP_ERROR_PREVIEW_CHARS = 200;

/** Circuit breaker thresholds for the Cohere rerank endpoint — same tuning
 *  as OpenAI/Anthropic chat so providers share an equivalent failure budget. */
const COHERE_RERANK_BREAKER_FAILURE_THRESHOLD = 5;
const COHERE_RERANK_BREAKER_RECOVERY_TIMEOUT_MS = 60_000;
const COHERE_RERANK_BREAKER_HALF_OPEN_MAX_ATTEMPTS = 3;
const COHERE_RERANK_BREAKER_NAME = 'cohere-rerank';

export interface CohereRerankerOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly httpTimeoutMs: number;
}

interface CohereRerankItem {
  readonly index: number;
  readonly relevance_score: number;
}

interface CohereRerankResponse {
  readonly results: readonly CohereRerankItem[];
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function isCohereRerankItem(value: unknown): value is CohereRerankItem {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['index'] === 'number'
    && typeof record['relevance_score'] === 'number';
}

function isCohereRerankResponse(value: unknown): value is CohereRerankResponse {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record['results']) && record['results'].every(isCohereRerankItem);
}

export class CohereReranker implements RerankerPort {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly httpTimeoutMs: number;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(options: CohereRerankerOptions) {
    this.endpoint = `${trimTrailingSlash(options.baseUrl)}/rerank`;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.httpTimeoutMs = options.httpTimeoutMs;
    this.circuitBreaker = createCircuitBreaker({
      name: COHERE_RERANK_BREAKER_NAME,
      failureThreshold: COHERE_RERANK_BREAKER_FAILURE_THRESHOLD,
      recoveryTimeoutMs: COHERE_RERANK_BREAKER_RECOVERY_TIMEOUT_MS,
      halfOpenMaxAttempts: COHERE_RERANK_BREAKER_HALF_OPEN_MAX_ATTEMPTS,
    });
    globalCircuitBreakerRegistry.register(
      COHERE_RERANK_BREAKER_NAME,
      this.circuitBreaker,
    );
  }

  async rerank(
    query: string,
    candidates: readonly RerankCandidate[],
    limit: number,
  ): Promise<readonly RerankResult[]> {
    if (candidates.length === 0) return [];

    return runUnderLlmBreaker(this.circuitBreaker, COHERE_RERANK_BREAKER_NAME, () =>
      this.rerankInner(query, candidates, limit),
    );
  }

  private async rerankInner(
    query: string,
    candidates: readonly RerankCandidate[],
    limit: number,
  ): Promise<readonly RerankResult[]> {
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
          body: JSON.stringify({
            model: this.model,
            query,
            documents: candidates.map((candidate) => candidate.text),
            top_n: limit,
          }),
        },
        this.httpTimeoutMs,
      );
    } catch (err) {
      if (isAbortError(err)) {
        pipelineDebug(
          {
            step: PipelineDebugStep.HTTP_RERANKER_TIMEOUT,
            provider: 'cohere',
            model: this.model,
            candidate_count: candidates.length,
            limit,
            latency_ms: Date.now() - httpStart,
          },
          'pipeline Cohere reranker HTTP',
        );
        throw new Error(
          `Cohere reranker: request timed out after ${this.httpTimeoutMs}ms`,
        );
      }
      pipelineDebug(
        {
          step: PipelineDebugStep.HTTP_RERANKER_NETWORK_ERROR,
          provider: 'cohere',
          model: this.model,
          candidate_count: candidates.length,
          limit,
        },
        'pipeline Cohere reranker HTTP',
      );
      throw err;
    }

    if (!response.ok) {
      const status = response.status;
      pipelineDebug(
        {
          step: PipelineDebugStep.HTTP_RERANKER_HTTP_ERROR,
          provider: 'cohere',
          model: this.model,
          candidate_count: candidates.length,
          limit,
          latency_ms: Date.now() - httpStart,
          http_status: status,
        },
        'pipeline Cohere reranker HTTP',
      );
      const text = await response.text().catch(() => '');
      throw new Error(`Cohere reranker failed [HTTP ${status}]: ${text.slice(0, COHERE_RERANKER_HTTP_ERROR_PREVIEW_CHARS)}`);
    }

    const data: unknown = await response.json();
    if (!isCohereRerankResponse(data)) {
      pipelineDebug(
        {
          step: PipelineDebugStep.HTTP_RERANKER_PARSE_ERROR,
          provider: 'cohere',
          model: this.model,
          candidate_count: candidates.length,
          limit,
          latency_ms: Date.now() - httpStart,
        },
        'pipeline Cohere reranker HTTP',
      );
      throw new Error('Cohere reranker: unexpected response shape');
    }

    pipelineDebug(
      {
        step: PipelineDebugStep.HTTP_RERANKER_OK,
        provider: 'cohere',
        model: this.model,
        candidate_count: candidates.length,
        limit,
        latency_ms: Date.now() - httpStart,
        http_status: response.status,
      },
      'pipeline Cohere reranker HTTP',
    );

    const scored: Array<{ entityId: EntityId; score: number }> = [];
    for (const item of data.results) {
      // Guard: Cohere index must be a non-negative integer within candidates bounds.
      // A negative or out-of-range index silently drops the result (candidates[N]
      // is undefined). Log so operators can detect a misbehaving proxy or model.
      if (!Number.isInteger(item.index) || item.index < 0 || item.index >= candidates.length) {
        bootstrapLogger.warn(
          { index: item.index, candidatesLength: candidates.length },
          '[CohereReranker] result index out of bounds — dropping item',
        );
        continue;
      }
      const candidate = candidates[item.index];
      if (candidate === undefined || !isEntityId(candidate.entityId)) continue;
      if (!Number.isFinite(item.relevance_score)) continue;
      // clamp01: Cohere's spec implies [0,1] but does not guarantee it — a score
      // outside this range would corrupt downstream calibration and ranking.
      scored.push({ entityId: candidate.entityId, score: clamp01(item.relevance_score) });
    }

    scored.sort((a, b) => b.score - a.score);

    // Defense-in-depth: Cohere honors `top_n: limit` server-side, but if the
    // API ever returns more than `limit` items (version drift, proxy, bug),
    // the port contract (`Maximum number of results to return`) would be
    // violated. Slice locally to match HttpCrossEncoderReranker parity.
    return scored.slice(0, limit).map((item, index) => ({
      entityId: item.entityId,
      score: item.score,
      rank: index + 1,
    }));
  }
}

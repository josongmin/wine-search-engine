import type {
  RerankerPort,
  RerankCandidate,
  RerankResult,
} from '../../domain/ranking/port/reranker.port.js';
import type { EntityId } from '../../domain/shared/types/index.js';
import { isEntityId } from '../../domain/shared/types/index.js';
import {
  fetchWithTimeout,
  isAbortError,
} from '../http/fetch-with-timeout.js';
import { PipelineDebugStep } from '../../observability/pipeline-debug-steps.js';
import { pipelineDebug } from '../../observability/request-pipeline-debug.js';

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

  constructor(options: CohereRerankerOptions) {
    this.endpoint = `${trimTrailingSlash(options.baseUrl)}/rerank`;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.httpTimeoutMs = options.httpTimeoutMs;
  }

  async rerank(
    query: string,
    candidates: readonly RerankCandidate[],
    limit: number,
  ): Promise<readonly RerankResult[]> {
    if (candidates.length === 0) return [];

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
      throw new Error(`Cohere reranker failed [HTTP ${status}]: ${text}`);
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
      const candidate = candidates[item.index];
      if (candidate === undefined || !isEntityId(candidate.entityId)) continue;
      scored.push({ entityId: candidate.entityId, score: item.relevance_score });
    }

    return scored.map((item, index) => ({
      entityId: item.entityId,
      score: item.score,
      rank: index + 1,
    }));
  }
}

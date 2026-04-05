/**
 * SearchPipelinePort adapter for connecting evaluation runner to search use case.
 *
 * Wraps SearchUseCase and converts search responses to evaluation format,
 * enabling RFC-009 evaluation pipeline integration.
 */

import type { SearchUseCase } from '../../application/search/search.usecase.js';
import type {
  SearchPipelinePort,
  SearchPipelineOutput,
} from '../../domain/evaluation/service/eval-runner.js';
import type { QueryClass, DecisionStatus } from '../../domain/shared/types/index.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';

/**
 * Adapter that exposes SearchUseCase as a SearchPipelinePort for evaluation.
 *
 * Responsibilities:
 * 1. Execute queries through the search pipeline
 * 2. Convert SearchResponseV1 → SearchPipelineOutput
 * 3. Track latency and evidence for evaluation
 * 4. Detect admission gate violations
 */
export class SearchPipelineEvaluator implements SearchPipelinePort {
  constructor(private readonly searchUseCase: SearchUseCase) {}

  /**
   * Executes a single query through the search pipeline and returns
   * the output in evaluation format.
   */
  async execute(
    query: string,
    _queryClass: QueryClass,
  ): Promise<SearchPipelineOutput> {
    const startMs = Date.now();

    try {
      const response: SearchResponseV1 = await this.searchUseCase.execute(
        {
          query,
          context: {
            locale: 'en-US',
            currency: 'USD',
          },
        },
        `eval-${Date.now()}`,
      );

      const latencyMs = Date.now() - startMs;

      // Extract decision and entity from response
      const decision = response.engineDecision;
      const predictedStatus = decision.decisionStatus as DecisionStatus;
      const predictedEntityId = response.results?.[0]?.entity?.entityId;

      const output: SearchPipelineOutput = {
        predictedStatus,
        decisionConfidence: decision.decisionConfidence,
        evidenceItems: [], // Populated if decision engine supports evidence trails
        latencyMs,
        decisionSnapshot: decision.decisionSnapshot,
        ...(predictedEntityId !== undefined ? { predictedEntityId } : {}),
      };
      return output;
    } catch (_error) {
      // On exception, treat as failed decision with error latency
      const latencyMs = Date.now() - startMs;
      return {
        predictedStatus: 'failed',
        decisionConfidence: 0,
        evidenceItems: [],
        latencyMs,
        decisionSnapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1',
          threshold_profile_id: 'default',
          planner_version: '1',
          feature_flags: {},
        },
      };
    }
  }
}

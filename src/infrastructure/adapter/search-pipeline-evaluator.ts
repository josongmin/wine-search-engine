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
      const predictedStatus = decision.decisionStatus;
      const topResult = response.results[0];
      const predictedEntityId = topResult?.entity.entityId;
      const evidenceItems = topResult?.evidenceItems ?? [];

      const topResultScoreComponents = topResult ? {
        semantic: topResult.match.scoreComponents.semantic,
        popularity: topResult.match.scoreComponents.popularity,
        attributeAlignment: topResult.match.scoreComponents.attribute,
        preferenceAlignment: topResult.match.scoreComponents.preferenceAlignment,
      } : undefined;

      const output: SearchPipelineOutput = {
        predictedStatus,
        decisionConfidence: decision.decisionConfidence,
        evidenceItems,
        latencyMs,
        decisionSnapshot: decision.decisionSnapshot,
        ...(predictedEntityId !== undefined ? { predictedEntityId } : {}),
        ...(topResultScoreComponents !== undefined ? { topResultScoreComponents } : {}),
      };
      return output;
    } catch (error) {
      // On exception, treat as failed decision with error latency
      const latencyMs = Date.now() - startMs;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[SearchPipelineEvaluator] Query failed (${latencyMs}ms): ${message}`);
      return {
        predictedStatus: 'failed' as DecisionStatus,
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

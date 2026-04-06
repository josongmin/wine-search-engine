/**
 * SearchPipelinePort adapter for connecting evaluation runner to search use case.
 *
 * Wraps SearchUseCase and converts search responses to evaluation format,
 * enabling RFC-009 evaluation pipeline integration.
 */

import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { SearchUseCaseContract } from '../../config/container-search-contracts.js';
import type { EvalCase } from '../../domain/evaluation/model/eval-case.js';
import type {
  SearchPipelinePort,
  SearchPipelineOutput,
} from '../../domain/evaluation/service/eval-runner.js';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';

const log = bootstrapLogger.child({ component: 'SearchPipelineEvaluator' });

const FAILED_EVAL_PIPELINE_SNAPSHOT: DecisionSnapshot = {
  model_versions: {},
  index_versions: {},
  policy_rule_version: '1',
  threshold_profile_id: 'default',
  planner_version: '1',
  feature_flags: {},
};

function failedEvalOutput(latencyMs: number): SearchPipelineOutput {
  return {
    predictedStatus: 'failed',
    decisionConfidence: 0,
    evidenceItems: [],
    latencyMs,
    decisionSnapshot: FAILED_EVAL_PIPELINE_SNAPSHOT,
  };
}

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
  constructor(private readonly searchUseCase: SearchUseCaseContract) {}

  /**
   * Executes a single query through the search pipeline and returns
   * the output in evaluation format.
   *
   * Gold-set `queryClass` is forwarded for observability; the live search
   * execution path still uses planner-derived classification (no eval override).
   */
  async execute(
    query: string,
    queryClass: EvalCase['queryClass'],
  ): Promise<SearchPipelineOutput> {
    log.debug({ queryClass }, 'eval search pipeline execute');
    const startMs = Date.now();

    try {
      const rawResponse = await this.searchUseCase.execute(
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

      // Evaluation always targets standard search queries
      if (rawResponse.queryType !== 'search') {
        return failedEvalOutput(latencyMs);
      }
      const response = rawResponse;

      // Extract decision and entity from response
      const decision = response.engineDecision;
      const predictedStatus = decision.decisionStatus;
      const topResult = response.results[0];
      const predictedEntityId = topResult?.entity.entityId;
      const evidenceItems = topResult?.evidenceItems ?? [];

      const topResultScoreComponents = topResult
        ? {
            semantic: topResult.match.scoreComponents.semantic,
            popularity: topResult.match.scoreComponents.popularity,
            attributeAlignment: topResult.match.scoreComponents.attribute,
            preferenceAlignment: topResult.match.scoreComponents.preferenceAlignment,
          }
        : undefined;

      const output: SearchPipelineOutput = {
        predictedStatus,
        decisionConfidence: decision.decisionConfidence,
        evidenceItems,
        latencyMs,
        decisionSnapshot: decision.decisionSnapshot,
        ...(predictedEntityId !== undefined ? { predictedEntityId } : {}),
        ...(topResultScoreComponents !== undefined
          ? { topResultScoreComponents }
          : {}),
      };
      return output;
    } catch (error) {
      const latencyMs = Date.now() - startMs;
      log.error(
        { err: error, latencyMs, query, queryClass },
        'eval pipeline query failed',
      );
      return failedEvalOutput(latencyMs);
    }
  }
}

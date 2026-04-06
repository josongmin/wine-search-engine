/**
 * SearchPipelinePort adapter for connecting evaluation runner to search use case.
 *
 * Wraps SearchUseCase and converts search responses to evaluation format,
 * enabling RFC-009 evaluation pipeline integration.
 */

import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { SearchUseCaseContract } from '../../config/container-search-contracts.js';
import type { SearchExecutorEvaluationResult } from '../../application/search/port/search-executor.port.js';
import type { EvalCase } from '../../domain/evaluation/model/eval-case.js';
import type {
  SearchPipelinePort,
  SearchPipelineOutput,
} from '../../domain/evaluation/service/eval-runner.js';
import type { EvalProvenanceSlice } from '../../domain/retrieval/model/provenance.js';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import {
  preferCanonicalRetrievalChannelLabel,
  preferCanonicalRetrievalChannelLabels,
} from '../../domain/retrieval/model/retrieval-channel.js';
import { buildDecisionSnapshotFromRuntimeVersions } from '../../application/search/search-usecase-decision-snapshot.js';

const log = bootstrapLogger.child({ component: 'SearchPipelineEvaluator' });

const FAILED_EVAL_PIPELINE_SNAPSHOT: DecisionSnapshot = buildDecisionSnapshotFromRuntimeVersions();

function failedEvalOutput(latencyMs: number): SearchPipelineOutput {
  return {
    predictedStatus: 'failed',
    decisionConfidence: 0,
    executionMode: 'degraded',
    blockingEligible: false,
    degradationReasons: ['evaluation_pipeline_failed'],
    evidenceItems: [],
    latencyMs,
    decisionSnapshot: FAILED_EVAL_PIPELINE_SNAPSHOT,
  };
}

function normalizeEvalChannel(channel: EvalProvenanceSlice['topChannel']): EvalProvenanceSlice['topChannel'] {
  return preferCanonicalRetrievalChannelLabel(channel) as EvalProvenanceSlice['topChannel'];
}

function normalizeEvalSlice(slice: EvalProvenanceSlice): EvalProvenanceSlice {
  return {
    ...slice,
    channels: preferCanonicalRetrievalChannelLabels(slice.channels) as EvalProvenanceSlice['channels'],
    topChannel: normalizeEvalChannel(slice.topChannel),
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
      const requestId = `eval-${Date.now()}`;
      const evalExecution = 'executeForEvaluation' in this.searchUseCase
        && typeof this.searchUseCase.executeForEvaluation === 'function'
        ? await this.searchUseCase.executeForEvaluation(
            {
              query,
              context: {
                locale: 'en-US',
                currency: 'USD',
              },
            },
            requestId,
          )
        : {
            response: await this.searchUseCase.execute(
              {
                query,
                context: {
                  locale: 'en-US',
                  currency: 'USD',
                },
              },
              requestId,
            ),
          } satisfies SearchExecutorEvaluationResult;

      const rawResponse = evalExecution.response;

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
      const retrievalProvenanceSlices: readonly EvalProvenanceSlice[] =
        (response.meta.retrievalProvenanceSlices ?? evalExecution.retrievalProvenanceSlices ?? [])
          .map(normalizeEvalSlice);

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
        ...(decision.executionMode !== undefined ? { executionMode: decision.executionMode } : {}),
        ...(decision.blockingEligible !== undefined
          ? { blockingEligible: decision.blockingEligible }
          : {}),
        ...(decision.degradationReasons !== undefined
          ? { degradationReasons: decision.degradationReasons }
          : {}),
        evidenceItems,
        latencyMs,
        decisionSnapshot: decision.decisionSnapshot,
        ...(retrievalProvenanceSlices.length > 0 ? { retrievalProvenanceSlices } : {}),
        ...(evalExecution.funnelMetrics !== undefined
          ? { funnelMetrics: evalExecution.funnelMetrics }
          : {}),
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

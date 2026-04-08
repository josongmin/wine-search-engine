/**
 * Epic 14: Decomposed Search Use Case
 *
 * Handles "A vs B" comparison queries by reusing the standard search seam
 * for each sub-query and merging the two responses.
 */

import { DomainError } from '../../domain/shared/error/domain-error.js';
import type { SearchRequest } from './search-request.dto.js';
import type { ComparisonSearchResponse, ComparisonEntity } from '../../domain/response/model/comparison-response.js';
import type { SearchExecutorPort } from './port/search-executor.port.js';
import type {
  DecomposedSearchExecutionOptions,
  DecomposedSearchParentContext,
} from './port/search-route-usecases.port.js';
import { buildComparisonAuthorityTraceRef } from '../../domain/decision/service/authority-trace.js';

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    const error = new Error('Decomposed search aborted');
    error.name = 'AbortError';
    throw error;
  }
}

export class UnexpectedDecomposedResponseError extends DomainError {
  constructor() {
    super(
      'UNEXPECTED_DECOMPOSED_RESPONSE',
      'Decomposed search expected standard search responses but received a comparison response.',
    );
    this.name = 'UnexpectedDecomposedResponseError';
  }
}

export class DecomposedSearchUseCase {
  constructor(private readonly searchUseCase: SearchExecutorPort) {}

  /**
   * Executes two reused searches for a decomposed comparison.
   *
   * @param subQueries - [queryA, queryB]
   * @param comparisonIntent - 'compare' | 'recommend_one' | 'list_both'
   * @param originalQuery - The original "A vs B" query
   * @param requestId - Parent request ID
   * @param startTime - Start timestamp for latency measurement
   */
  async execute(
    subQueries: [string, string],
    comparisonIntent: 'compare' | 'recommend_one' | 'list_both',
    originalQuery: string,
    requestId: string,
    startTime: number,
    parentContext?: DecomposedSearchParentContext,
    options?: DecomposedSearchExecutionOptions,
  ): Promise<ComparisonSearchResponse> {
    throwIfAborted(options?.abortSignal);

    const baseRequest: Omit<SearchRequest, 'query'> = {
      options: { mode: 'auto', explain: parentContext?.explain ?? false, clarification: false },
      ...(parentContext?.context !== undefined ? { context: parentContext.context } : {}),
      ...(parentContext?.sessionContext !== undefined
        ? { sessionContext: parentContext.sessionContext }
        : {}),
      ...(parentContext?.queryBudget !== undefined ? { queryBudget: parentContext.queryBudget } : {}),
    };

    // Reuse the main search seam for both sub-queries while honoring caller cancellation.
    // Use Promise.allSettled to avoid unhandled rejection when one sub-query fails
    // while the other is still in flight (the classic Promise.all double-rejection issue).
    const [settledA, settledB] = await Promise.allSettled([
      this.searchUseCase.execute(
        { ...baseRequest, query: subQueries[0] },
        `${requestId}-a`,
        { abortSignal: options?.abortSignal },
      ),
      this.searchUseCase.execute(
        { ...baseRequest, query: subQueries[1] },
        `${requestId}-b`,
        { abortSignal: options?.abortSignal },
      ),
    ]);
    if (settledA.status === 'rejected') {
      throw settledA.reason instanceof Error ? settledA.reason : new Error(String(settledA.reason));
    }
    if (settledB.status === 'rejected') {
      throw settledB.reason instanceof Error ? settledB.reason : new Error(String(settledB.reason));
    }
    const rawResultA = settledA.value;
    const rawResultB = settledB.value;

    throwIfAborted(options?.abortSignal);

    // Sub-queries should never themselves be comparison queries; narrow via discriminant
    if (rawResultA.queryType !== 'search' || rawResultB.queryType !== 'search') {
      throw new UnexpectedDecomposedResponseError();
    }
    const resultA = rawResultA;
    const resultB = rawResultB;

    // Build comparison entities from SearchResponseV1 results
    const entityA: ComparisonEntity = {
      subQuery: subQueries[0],
      topResult: resultA.results[0] ?? null,
      resultCount: resultA.results.length,
      resolutionStatus: resultA.engineDecision.decisionStatus,
      allResults: resultA.results,
    };

    const entityB: ComparisonEntity = {
      subQuery: subQueries[1],
      topResult: resultB.results[0] ?? null,
      resultCount: resultB.results.length,
      resolutionStatus: resultB.engineDecision.decisionStatus,
      allResults: resultB.results,
    };

    // Compute overall status
    const overallStatus = this.computeOverallStatus(
      resultA.engineDecision.decisionStatus,
      resultB.engineDecision.decisionStatus,
    );
    const leftAuthorityTraceRef =
      resultA.engineDecision.authorityTraceRef ?? resultA.engineDecision.decisionTraceRef;
    const rightAuthorityTraceRef =
      resultB.engineDecision.authorityTraceRef ?? resultB.engineDecision.decisionTraceRef;
    const authorityTraceRef = buildComparisonAuthorityTraceRef({
      originalQuery,
      comparisonIntent,
      overallStatus,
      leftAuthorityTraceRef,
      rightAuthorityTraceRef,
    });

    const executionTimeMs = Date.now() - startTime;

    return {
      queryType: 'comparison',
      originalQuery,
      comparisonIntent,
      entities: [entityA, entityB],
      overallStatus,
      requestId,
      executionTimeMs,
      authorityTraceRef,
      runtimeCorrelationRef: requestId,
    };
  }

  /**
   * Computes the overall decision status for a comparison.
   * Both resolved → resolved
   * One ambiguous → ambiguous
   * One/both no_match → failed
   */
  private computeOverallStatus(
    statusA: string,
    statusB: string,
  ): 'resolved' | 'ambiguous' | 'failed' {
    if (statusA === 'resolved' && statusB === 'resolved') {
      return 'resolved';
    }
    if (statusA === 'failed' || statusB === 'failed') {
      return 'failed';
    }
    if (statusA === 'ambiguous' || statusB === 'ambiguous') {
      return 'ambiguous';
    }
    return 'failed';
  }
}

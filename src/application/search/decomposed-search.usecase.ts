/**
 * Epic 14: Decomposed Search Use Case
 *
 * Handles "A vs B" comparison queries by decomposing them into
 * parallel entity resolution + merging results.
 */

import type { SearchRequest } from './search-request.dto.js';
import type { ComparisonSearchResponse, ComparisonEntity } from '../../domain/response/model/comparison-response.js';
import type { SearchExecutorPort } from './port/search-executor.port.js';
import type { DecomposedSearchParentContext } from './port/search-route-usecases.port.js';

export class DecomposedSearchUseCase {
  constructor(private readonly searchUseCase: SearchExecutorPort) {}

  /**
   * Executes parallel search for two sub-queries from a decomposed comparison.
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
  ): Promise<ComparisonSearchResponse> {
    const baseRequest: Omit<SearchRequest, 'query'> = {
      options: { mode: 'auto', explain: false, clarification: false },
      ...(parentContext?.context !== undefined ? { context: parentContext.context } : {}),
      ...(parentContext?.sessionContext !== undefined
        ? { sessionContext: parentContext.sessionContext }
        : {}),
      ...(parentContext?.queryBudget !== undefined ? { queryBudget: parentContext.queryBudget } : {}),
    };

    // Execute both sub-queries in parallel
    const [rawResultA, rawResultB] = await Promise.all([
      this.searchUseCase.execute(
        { ...baseRequest, query: subQueries[0] },
        `${requestId}-a`,
      ),
      this.searchUseCase.execute(
        { ...baseRequest, query: subQueries[1] },
        `${requestId}-b`,
      ),
    ]);

    // Sub-queries should never themselves be comparison queries; narrow via discriminant
    if (rawResultA.queryType !== 'search' || rawResultB.queryType !== 'search') {
      throw new Error('Decomposed sub-query returned unexpected comparison response');
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

    const executionTimeMs = Date.now() - startTime;

    return {
      queryType: 'comparison',
      originalQuery,
      comparisonIntent,
      entities: [entityA, entityB],
      overallStatus,
      requestId,
      executionTimeMs,
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
    if (statusA === 'ambiguous' || statusB === 'ambiguous') {
      return 'ambiguous';
    }
    return 'failed';
  }
}

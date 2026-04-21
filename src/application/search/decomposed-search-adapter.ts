/**
 * T1.3b: DecomposedSearchAdapter
 *
 * Breaks the circular dependency between SearchUseCase and DecomposedSearchUseCase.
 * The delegate is resolved lazily via a closure set at container bootstrap so the
 * reference is never undefined at execute() time (after wiring completes).
 *
 * Usage in container-usecases.ts:
 *   const decomposedRef: { impl?: DecomposedSearchUseCase } = {};
 *   const adapter = new DecomposedSearchAdapter(() => {
 *     if (decomposedRef.impl === undefined) throw new Error('...');
 *     return decomposedRef.impl;
 *   });
 *   const searchUseCase = new SearchUseCase({ ..., decomposedSearch: adapter });
 *   decomposedRef.impl = new DecomposedSearchUseCase(searchUseCase);
 */

import type { DecomposedSearchUseCasePort } from './port/search-route-usecases.port.js';
import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type {
  DecomposedSearchExecutionOptions,
  DecomposedSearchParentContext,
} from './port/search-route-usecases.port.js';
import type {
  ComparisonDecompositionLegs,
  ComparisonIntent,
} from '../../domain/query/model/query-decomposition.js';

export class DecomposedSearchAdapter implements DecomposedSearchUseCasePort {
  constructor(
    private readonly resolveDelegate: () => DecomposedSearchUseCasePort,
  ) {}

  async execute(
    subQueries: [string, string],
    comparisonLegs: ComparisonDecompositionLegs,
    comparisonIntent: ComparisonIntent,
    originalQuery: string,
    requestId: string,
    startTime: number,
    parentContext?: DecomposedSearchParentContext,
    options?: DecomposedSearchExecutionOptions,
  ): Promise<ComparisonSearchResponse> {
    return this.resolveDelegate().execute(
      subQueries,
      comparisonLegs,
      comparisonIntent,
      originalQuery,
      requestId,
      startTime,
      parentContext,
      options,
    );
  }
}

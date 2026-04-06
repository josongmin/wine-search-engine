/**
 * T1.3b: DecomposedSearchAdapter
 *
 * Breaks the circular dependency between SearchUseCase and DecomposedSearchUseCase.
 * Pattern: adapter holds a mutable delegate ref set after both use cases are constructed.
 *
 * Usage in container-usecases.ts:
 *   const adapter = new DecomposedSearchAdapter();
 *   // ... construct searchUseCase passing adapter ...
 *   adapter.setDelegate(decomposedSearchUseCase);
 */

import type { DecomposedSearchUseCasePort } from './port/search-route-usecases.port.js';
import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type { DecomposedSearchParentContext } from './port/search-route-usecases.port.js';

export class DecomposedSearchAdapter implements DecomposedSearchUseCasePort {
  private delegate: DecomposedSearchUseCasePort | undefined;

  /**
   * Set the concrete delegate after it is constructed.
   * Must be called before any execute() invocation.
   */
  setDelegate(delegate: DecomposedSearchUseCasePort): void {
    this.delegate = delegate;
  }

  async execute(
    subQueries: [string, string],
    comparisonIntent: 'compare' | 'recommend_one' | 'list_both',
    originalQuery: string,
    requestId: string,
    startTime: number,
    parentContext?: DecomposedSearchParentContext,
  ): Promise<ComparisonSearchResponse> {
    if (this.delegate === undefined) {
      throw new Error(
        '[DecomposedSearchAdapter] delegate not set — call setDelegate() before execute()',
      );
    }
    return this.delegate.execute(
      subQueries,
      comparisonIntent,
      originalQuery,
      requestId,
      startTime,
      parentContext,
    );
  }
}

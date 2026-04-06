import type { SearchResponseV1 } from '../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../domain/response/model/comparison-response.js';
import type { DrinkingWindowBlock } from '../domain/response/model/result-item.js';
import type { SearchResponseV2Machine } from '../domain/response/model/result-item-v2.js';

export type WineToolExecutionResult =
  | SearchResponseV1
  | SearchResponseV2Machine
  | ComparisonSearchResponse
  | DrinkingWindowBlock
  | { error: string };

export interface WineToolExecutorContract {
  execute(
    toolName: string,
    input: unknown,
    requestId: string,
  ): Promise<WineToolExecutionResult>;
}

export interface AdaptiveToolExecutionResult<T = WineToolExecutionResult> {
  readonly result: T;
  readonly fallbackApplied?: 'mixed' | undefined;
}

export interface AdaptiveToolExecutorContract {
  executeWithFallback(
    toolName: string,
    input: unknown,
    requestId: string,
  ): Promise<AdaptiveToolExecutionResult>;
}

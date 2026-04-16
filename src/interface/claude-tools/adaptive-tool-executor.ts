/**
 * Epic 17.2: Adaptive Tool Executor with Fallback
 *
 * Wraps WineToolExecutor with intelligent fallback logic:
 * - When search_wines returns empty results with mode='auto' or undefined
 * - Retry ONCE with mode='mixed' (advanced reasoning)
 * - NO infinite recursion: fallback calls base.execute() directly
 * - Mark fallback in result for transparency
 */

import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type { DrinkingWindowBlock } from '../../domain/response/model/result-item.js';
import type { SearchResponseV2Machine } from '../../domain/response/model/result-item-v2.js';
import { type WineToolExecutor } from './tool-executor.js';

/**
 * All possible tool results including the V2 machine format (T6.3).
 */
type AnyToolResult =
  | SearchResponseV1
  | SearchResponseV2Machine
  | ComparisonSearchResponse
  | DrinkingWindowBlock
  | { error: string };

/**
 * Result from executeWithFallback, includes fallback tracking.
 */
interface AdaptiveToolResult<T> {
  /** The result from tool execution */
  readonly result: T;
  /** Optional: which fallback mode was applied (e.g., 'mixed') */
  readonly fallbackApplied?: 'mixed' | undefined;
}

/**
 * Adaptive tool executor with 1-shot fallback for empty results.
 *
 * Wraps WineToolExecutor and adds:
 * - Empty result detection for search_wines
 * - Auto mode detection
 * - Single retry with mode='mixed' if conditions met
 * - No infinite recursion (fallback calls base.execute directly)
 * - Fallback attempt tracking via requestId suffix ("-fb")
 */
export class AdaptiveToolExecutor {
  private readonly baseExecutor: WineToolExecutor;

  constructor(wineToolExecutor: WineToolExecutor) {
    this.baseExecutor = wineToolExecutor;
  }

  /**
   * Execute a tool with adaptive fallback.
   *
   * Logic:
   * 1. Call base.execute(toolName, input, requestId)
   * 2. IF search_wines AND result is empty AND mode is auto/undefined:
   *    - Generate fallback requestId: ${requestId}-fb
   *    - Retry with base.execute() directly (NOT recursively)
   *    - Pass mode='mixed' in modified input
   *    - Return { result: fallbackResult, fallbackApplied: 'mixed' } if non-empty
   * 3. ELSE return { result }
   *
   * NO infinite recursion: fallback always calls base.execute() directly.
   *
   * @param toolName - Name of tool to execute
   * @param input - Raw input
   * @param requestId - Parent request ID
   * @returns AdaptiveToolResult with fallback tracking
   */
  async executeWithFallback(
    toolName: string,
    input: unknown,
    requestId: string,
  ): Promise<AdaptiveToolResult<AnyToolResult>> {
    // Execute base tool (no v2Options — V1 path)
    const result = await this.baseExecutor.execute(toolName, input, requestId);

    // Check if we should apply fallback
    if (
      toolName === 'search_wines' &&
      this.isEmptyResult(result) &&
      this.isModeAuto(input)
    ) {
      // Construct fallback input with mode='mixed'
      const fallbackInput = {
        ...(typeof input === 'object' && input !== null ? input : {}),
        retrieval_mode: 'mixed',
      };

      // Generate fallback requestId
      const fallbackRequestId = `${requestId}-fb`;

      // Execute fallback (NOT recursively) — calls base.execute directly
      const fallbackResult = await this.baseExecutor.execute(
        toolName,
        fallbackInput,
        fallbackRequestId,
      );

      // If fallback returned non-empty results, return with fallbackApplied flag
      if (!this.isEmptyResult(fallbackResult)) {
        return {
          result: fallbackResult,
          fallbackApplied: 'mixed',
        };
      }
    }

    // No fallback: return original result
    return { result };
  }

  /**
   * Check if a tool result is empty (no results found).
   *
   * For search_wines results (SearchResponseV1):
   * - Empty if results array is length 0
   * - Empty if engineDecision.decisionStatus is 'failed' or 'ambiguous'
   *
   * For other types: not empty by default (no fallback needed)
   *
   * @param result - Tool result to check
   * @returns true if result is empty
   */
  private isEmptyResult(result: AnyToolResult): boolean {
    // Check if it's a SearchResponseV1
    if (
      'queryType' in result &&
      result.queryType === 'search' &&
      'results' in result &&
      Array.isArray((result as unknown as Record<string, unknown>)['results']) &&
      'engineDecision' in result
    ) {
      const searchResult = result;
      const status = searchResult.engineDecision.decisionStatus;
      return (
        searchResult.results.length === 0 ||
        status === 'failed' ||
        status === 'ambiguous'
      );
    }

    // Not a search result: not empty
    return false;
  }

  /**
   * Check if input specifies auto mode (or no explicit mode).
   *
   * Returns true if:
   * - input is an object
   * - retrieval_mode is 'auto' or undefined
   *
   * Returns false if:
   * - retrieval_mode is 'entity', 'hybrid', or 'mixed'
   * - input is not an object
   *
   * @param input - Tool input to check
   * @returns true if mode is auto or undefined
   */
  private isModeAuto(input: unknown): boolean {
    if (typeof input !== 'object' || input === null) {
      return false;
    }

    const inputObj = input as Record<string, unknown>;
    const mode = inputObj.retrieval_mode;

    // Mode is auto if undefined or explicitly 'auto'
    return mode === undefined || mode === 'auto';
  }
}

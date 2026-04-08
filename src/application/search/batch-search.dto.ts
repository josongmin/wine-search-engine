import type { RequestExecutionContext } from '../../domain/shared/request-execution-context.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type {
  SearchQueryBudget,
  SearchRequestContext,
  SearchSessionContext,
} from './search-request.dto.js';

export interface BatchSearchRequestItem {
  readonly id: string;
  readonly query: string;
  readonly limit?: number | undefined;
  readonly retrieval_mode?: 'auto' | 'entity' | 'hybrid' | 'mixed' | undefined;
  readonly context?: SearchRequestContext | undefined;
  readonly sessionContext?: SearchSessionContext | undefined;
  readonly queryBudget?: SearchQueryBudget | undefined;
  /**
   * When true, the corresponding sub-search returns counterfactuals in its
   * response. Defaults to false to keep batch responses minimal.
   */
  readonly explain?: boolean | undefined;
}

export interface BatchSearchOptions {
  readonly fail_fast?: boolean | undefined;
  readonly timeout_ms?: number | undefined;
}

export type BatchErrorCode =
  | 'POLICY_BLOCKED'
  | 'QUERY_PARSE_ERROR'
  | 'RETRIEVAL_TIMEOUT'
  | 'REQUEST_ABORTED'
  | 'INTERNAL_ERROR';

/** HTTP / executor context (not part of the JSON batch body). */
export type BatchSearchExecutionContext = RequestExecutionContext;

export interface BatchSearchError {
  readonly code: BatchErrorCode;
  readonly message: string;
}

export interface BatchSearchResultSuccess {
  readonly id: string;
  readonly status: 'succeeded';
  readonly response: SearchResponseV1;
}

export interface BatchSearchResultFailure {
  readonly id: string;
  /**
   * `failed` — the item ran but threw an error (e.g. timeout, network issue,
   * policy block, query parse error).
   */
  readonly status: 'failed';
  readonly error: BatchSearchError;
}

export interface BatchSearchResultNotExecuted {
  readonly id: string;
  /**
   * `not_executed` — the item was never started (e.g. an earlier item failed in
   * fail_fast mode, or the batch was aborted before this item was reached).
   */
  readonly status: 'not_executed';
  readonly error: BatchSearchError;
}

export type BatchSearchResultItem =
  | BatchSearchResultSuccess
  | BatchSearchResultFailure
  | BatchSearchResultNotExecuted;

export interface BatchSearchResponse {
  readonly batch_id: string;
  readonly total: number;
  readonly succeeded: number;
  /** Items that ran but threw an error. */
  readonly failed: number;
  /** Items that were never started (fail_fast abort or pre-run skip). */
  readonly not_executed: number;
  readonly batch_status: 'succeeded' | 'partial_failure' | 'failed';
  readonly has_failures: boolean;
  readonly results: readonly BatchSearchResultItem[];
  readonly processing_time_ms: number;
}

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
}

export interface BatchSearchOptions {
  readonly fail_fast?: boolean | undefined;
  readonly timeout_ms?: number | undefined;
}

export type BatchErrorCode =
  | 'POLICY_BLOCKED'
  | 'QUERY_PARSE_ERROR'
  | 'RETRIEVAL_TIMEOUT'
  | 'INTERNAL_ERROR';

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
  readonly status: 'failed';
  readonly error: BatchSearchError;
}

export type BatchSearchResultItem = BatchSearchResultSuccess | BatchSearchResultFailure;

export interface BatchSearchResponse {
  readonly batch_id: string;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly results: readonly BatchSearchResultItem[];
  readonly processing_time_ms: number;
}

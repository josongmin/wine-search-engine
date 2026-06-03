import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../../domain/response/model/comparison-response.js';
import type { QueryPlanV1 } from '../../../domain/query/model/query-plan.js';
import type {
  BatchSearchExecutionContext,
  BatchSearchOptions,
  BatchSearchRequestItem,
  BatchSearchResponse,
} from '../batch-search.dto.js';
import type { InterpretRequest } from '../interpret-request.dto.js';
import type { InterpretResultWithV2 } from '../interpret.usecase.js';
import type { ResolveRequest } from '../resolve-request.dto.js';
import type { ResolveResponse } from '../resolve-response.dto.js';
import type {
  EntityLookupV2Command,
  EntityLookupV2Result,
} from '../entity-lookup-v2/entity-lookup-v2.dto.js';
import type { AutocompleteResponse } from '../autocomplete-response.dto.js';
import type { RequestExecutionContext } from '../../../domain/shared/request-execution-context.js';
import type { HybridSearchRequest } from '../hybrid-request.dto.js';
import type { SearchQueryBudget, SearchRequestContext, SearchSessionContext } from '../search-request.dto.js';
import type { NormalizedConstraint } from '../../../domain/shared/types/constraint-bundle.js';
import type {
  ComparisonDecompositionLegs,
  ComparisonIntent,
} from '../../../domain/query/model/query-decomposition.js';

export interface DecomposedSearchParentContext {
  readonly context?: SearchRequestContext | undefined;
  readonly sessionContext?: SearchSessionContext | undefined;
  readonly queryBudget?: SearchQueryBudget | undefined;
  readonly filters?: readonly NormalizedConstraint[] | undefined;
  readonly preferences?: readonly NormalizedConstraint[] | undefined;
  readonly perSideFilters?: readonly [
    readonly NormalizedConstraint[] | undefined,
    readonly NormalizedConstraint[] | undefined,
  ] | undefined;
  /**
   * Forwards the parent search request's `options.explain` to each sub-search
   * so that explain=true on a comparison query produces counterfactuals on
   * both legs.
   */
  readonly explain?: boolean | undefined;
  /**
   * Caller-provided execution mode override for BOTH legs (api_override
   * semantics — mirrors the search-family retrieval-mode override). When set, each
   * sub-search runs with this exact `options.mode` and the leg's auto-detected
   * retrieval mode is bypassed. Bench #117 RCA: the planner reasonably emits
   * `retrieval_mode: 'entity'` for exact-pair compares; without this override
   * the inner search would run a hybrid/auto pipeline that scores low on the
   * tight "Opus One 2018 vs Almaviva 2019" intent.
   */
  readonly retrievalMode?: 'auto' | 'entity' | 'hybrid' | 'mixed' | undefined;
}

export type DecomposedSearchExecutionOptions = RequestExecutionContext;

export interface DecomposedSearchUseCasePort {
  execute(
    subQueries: [string, string],
    comparisonLegs: ComparisonDecompositionLegs,
    comparisonIntent: ComparisonIntent,
    originalQuery: string,
    requestId: string,
    startTime: number,
    parentContext?: DecomposedSearchParentContext,
    options?: DecomposedSearchExecutionOptions,
  ): Promise<ComparisonSearchResponse>;
}

export interface BatchSearchUseCasePort {
  execute(
    requests: readonly BatchSearchRequestItem[],
    options?: BatchSearchOptions,
    batchId?: string,
    executionContext?: BatchSearchExecutionContext,
  ): Promise<BatchSearchResponse>;
}

export type InterpretExecutionOptions = RequestExecutionContext;

export interface InterpretUseCasePort {
  execute(
    request: InterpretRequest & { readonly buildV2: true; readonly requestId?: string | undefined },
    options?: InterpretExecutionOptions,
  ): Promise<InterpretResultWithV2>;
  execute(
    request: InterpretRequest & { readonly buildV2?: boolean | undefined; readonly requestId?: string | undefined },
    options?: InterpretExecutionOptions,
  ): Promise<QueryPlanV1 | InterpretResultWithV2>;
}

export type ResolveExecutionOptions = RequestExecutionContext;

export interface ResolveUseCasePort {
  execute(request: ResolveRequest, options?: ResolveExecutionOptions): Promise<ResolveResponse>;
}

export type EntityLookupV2ExecutionOptions = RequestExecutionContext;

/** Port for the dedicated `/v2/entity-lookup` use case (T-ELV2-01). */
export interface EntityLookupV2UseCasePort {
  execute(
    command: EntityLookupV2Command,
    options?: EntityLookupV2ExecutionOptions,
  ): Promise<EntityLookupV2Result>;
}

export type AutocompleteExecutionOptions = RequestExecutionContext;

export interface AutocompleteUseCasePort {
  execute(request: ResolveRequest, options?: AutocompleteExecutionOptions): Promise<AutocompleteResponse>;
}

export type HybridExecutionOptions = RequestExecutionContext;

export interface HybridUseCasePort {
  execute(
    request: HybridSearchRequest,
    requestId: string,
    options?: HybridExecutionOptions,
  ): Promise<SearchResponseV1 | ComparisonSearchResponse>;
}

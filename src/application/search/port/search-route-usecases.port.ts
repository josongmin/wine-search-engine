import type { ComparisonSearchResponse } from '../../../domain/response/model/comparison-response.js';
import type {
  EntityLookupV2Command,
  EntityLookupV2Result,
} from '../entity-lookup-v2/entity-lookup-v2.dto.js';
import type { RequestExecutionContext } from '../../../domain/shared/request-execution-context.js';
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

export type EntityLookupV2ExecutionOptions = RequestExecutionContext;

/** Port for the dedicated `/v2/entity-lookup` use case (T-ELV2-01). */
export interface EntityLookupV2UseCasePort {
  execute(
    command: EntityLookupV2Command,
    options?: EntityLookupV2ExecutionOptions,
  ): Promise<EntityLookupV2Result>;
}


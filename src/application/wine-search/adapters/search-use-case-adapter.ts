/**
 * SearchUseCaseAdapter — adapts the production
 * `SearchUseCase` to the `SearchUseCasePort` consumed by the
 * Plan-then-Execute `ExecutionRunner`.
 *
 * The adapter is intentionally a structural translator:
 *  - it maps `SearchUseCaseInput` (the wine-search-analysis-driven slice
 *    of {@link SearchRequest}) into a `SearchRequest`,
 *  - it threads `requestId` and `abortSignal` through to the use case,
 *  - it asserts the underlying response is a `SearchResponseV1` (the
 *    runner's port type) and surfaces a typed error otherwise.
 *
 * The only policy at this seam is authority propagation:
 *  - preserve analyzer-authored `callerInterpretation` when present,
 *  - otherwise fall back to the legacy generic caller-controlled interpretation
 *    for non-entity/non-mixed agent searches so the downstream pipeline
 *    executes them as retrieval primitives instead of re-running planner
 *    intent/routing.
 */

import type { SearchExecutionOptions } from '../../search/port/search-executor.port.js';
import type { SearchRequest } from '../../search/search-request.dto.js';
import { createCanonicalEntityId } from '../../../domain/shared/types/entity-id.js';
import type { SearchUseCase } from '../../search/search.usecase.js';
import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import { DomainError } from '../../../domain/shared/error/domain-error.js';
import type {
  SearchUseCaseInput,
} from '../execution-plan-schemas.js';
import type {
  SearchUseCasePort,
} from '../execution-runner.js';

const CALLER_CONTROLLED_SEARCH_INTENT = 'semantic_discovery' as const;
const CALLER_CONTROLLED_SEARCH_QUERY_CLASS = 'semantic_preference' as const;
const AGENT_INTERNAL_TRUSTED_EXECUTION_PRINCIPAL = 'agent_internal_trusted' as const;

function shouldBypassPlanner(
  input: SearchUseCaseInput,
): boolean {
  return input.mode !== 'entity' && input.mode !== 'mixed';
}

function shouldBypassPublicQueryEntrySecurityForInternalPrimitive(
  input: SearchUseCaseInput,
): boolean {
  return input.primitiveRoute === 'lookup_wine' || input.anchorEntityId !== undefined;
}

/** Thrown when the underlying `SearchUseCase` returns a comparison response
 *  for what the runner expects to be a single-search call. */
export class UnexpectedSearchAdapterResponseError extends DomainError {
  constructor(observedQueryType: string) {
    super(
      'UNEXPECTED_SEARCH_ADAPTER_RESPONSE',
      `SearchUseCaseAdapter expected queryType='search' but received '${observedQueryType}'.`,
    );
    this.name = 'UnexpectedSearchAdapterResponseError';
  }
}

export class SearchUseCaseAdapter implements SearchUseCasePort {
  constructor(private readonly useCase: SearchUseCase) {}

  async execute(
    input: SearchUseCaseInput,
    requestId: string,
    options?: { readonly abortSignal?: AbortSignal | undefined },
  ): Promise<SearchResponseV1> {
    const request = mapSearchUseCaseInputToSearchRequest(input);
    const useCaseOptions: SearchExecutionOptions = {
      requestId,
      ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
      ...(shouldBypassPublicQueryEntrySecurityForInternalPrimitive(input)
        ? { executionPrincipal: AGENT_INTERNAL_TRUSTED_EXECUTION_PRINCIPAL }
        : {}),
    };
    const response = await this.useCase.execute(request, requestId, useCaseOptions);
    if (response.queryType !== 'search') {
      throw new UnexpectedSearchAdapterResponseError(response.queryType);
    }
    return response;
  }
}

/**
 * Pure mapping from the analysis-driven `SearchUseCaseInput` shape to the
 * application `SearchRequest`. Lives at module scope (not on the class) so
 * it can be exercised directly in unit tests without instantiating a
 * use case stub.
 *
 * Optional fields are spread-merged so `exactOptionalPropertyTypes` keeps
 * the request shape clean (no `undefined`-valued keys).
 */
export function mapSearchUseCaseInputToSearchRequest(
  input: SearchUseCaseInput,
): SearchRequest {
  if (input.primitiveRoute === 'lookup_wine') {
    return {
      query: input.query,
      primitiveRoute: 'lookup_wine',
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    };
  }

  // RFC-021 T-PSA-02: reference-similarity is path-authoritative. When the
  // dispatcher supplied a resolved anchor entity, emit the internal
  // `similar_to_entity` primitive route + anchor — NOT a callerInterpretation.
  // The dedicated plan builder fixes route=mixed/retrievalMode=similar_items and
  // seeds the anchor directly (no free-text re-resolution). `query` is carried
  // for provenance only; it is never used to resolve the anchor.
  if (input.anchorEntityId !== undefined) {
    return {
      query: input.query,
      primitiveRoute: 'similar_to_entity',
      anchorEntityId: createCanonicalEntityId(input.anchorEntityId),
      ...(input.filters !== undefined && input.filters.length > 0
        ? { filters: input.filters }
        : {}),
      ...(input.preferences !== undefined && input.preferences.length > 0
        ? { preferences: input.preferences }
        : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    };
  }
  const callerInterpretation = input.callerInterpretation
    ?? (shouldBypassPlanner(input)
      ? {
          authority: 'caller' as const,
          intent: CALLER_CONTROLLED_SEARCH_INTENT,
          queryClass: CALLER_CONTROLLED_SEARCH_QUERY_CLASS,
        }
      : undefined);
  return {
    query: input.query,
    ...(input.filters !== undefined && input.filters.length > 0
      ? { filters: input.filters }
      : {}),
    ...(input.preferences !== undefined && input.preferences.length > 0
      ? { preferences: input.preferences }
      : {}),
    ...(input.mode !== undefined
      ? {
          options: {
            mode: input.mode,
            explain: false,
            clarification: false,
          },
          retrieval_mode: input.mode,
        }
      : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.representativeConcept !== undefined
      ? { representativeConcept: input.representativeConcept }
      : {}),
    ...(callerInterpretation !== undefined ? { callerInterpretation } : {}),
    // T-IR-05: forward the primitive agent tool's retrieval lane onto the
    // SearchRequest so `search_semantic` / `search_lexical` gate channels at
    // the candidate pool exactly like the HTTP `/v1/search/{...}` routes.
    ...(input.retrievalLane !== undefined ? { retrievalLane: input.retrievalLane } : {}),
  };
}

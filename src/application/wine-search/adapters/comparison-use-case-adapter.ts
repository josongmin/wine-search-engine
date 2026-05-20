/**
 * ComparisonUseCaseAdapter — adapts `DecomposedSearchUseCase` to the
 * `ComparisonUseCasePort` shape required by `ExecutionRunner`.
 *
 * The runner emits a `ComparisonUseCaseInput`:
 *   {
 *     originalQuery,
 *     intent: 'compare' | 'recommend_one' | 'list_both',
 *     legs: [ComparisonLeg, ComparisonLeg],          // { surface, constraints }
 *     sharedFilters?, sharedPreferences?,
 *   }
 *
 * The domain `DecomposedSearchUseCase.execute(...)` consumes:
 *   subQueries: [string, string],
 *   comparisonLegs: ComparisonDecompositionLegs,     // [{ rawQuery, retrievalQuery,
 *                                                    //   mode, retrievalMode, evidenceSource }]
 *   comparisonIntent: ComparisonIntent,
 *   originalQuery: string,
 *   requestId: string,
 *   startTime: number,
 *   parentContext?,
 *   options?,
 *
 * Mapping decisions (all behaviour-preserving):
 *  - `legs[i].surface` becomes both the sub-query string and the
 *    `rawQuery`/`retrievalQuery` of the corresponding domain leg.
 *  - The runner-port `ComparisonLeg.constraints` are interpreted as
 *    per-side hard filters and forwarded via
 *    `parentContext.perSideFilters[i]`.
 *  - `sharedFilters` / `sharedPreferences` propagate as
 *    `parentContext.filters` / `parentContext.preferences`.
 *  - `mode`, `retrievalMode`, and `evidenceSource` fall back to the
 *    canonical "entity / auto / entity_default" tuple, matching what
 *    `buildEntityComparisonLeg(...)` produces in
 *    `query-decomposition.ts`. The runner-port surface intentionally does
 *    not expose concept-leg fields — those are produced by upstream
 *    decomposition, not by the deterministic router.
 *
 * `startTime` is captured at adapter entry (Date.now) so the returned
 * `ComparisonSearchResponse.executionTimeMs` reflects the elapsed time of
 * this call rather than the parent request as a whole.
 */

import type { DecomposedSearchUseCase } from '../../search/decomposed-search.usecase.js';
import type {
  DecomposedSearchExecutionOptions,
  DecomposedSearchParentContext,
} from '../../search/port/search-route-usecases.port.js';
import type {
  ComparisonDecompositionLeg,
  ComparisonDecompositionLegs,
  ComparisonIntent,
} from '../../../domain/query/model/query-decomposition.js';
import type { ComparisonSearchResponse } from '../../../domain/response/model/comparison-response.js';
import type { NormalizedConstraint } from '../../../domain/shared/types/index.js';
import type {
  ComparisonUseCaseInput,
} from '../execution-plan-schemas.js';
import type {
  ComparisonUseCasePort,
} from '../execution-runner.js';

export class ComparisonUseCaseAdapter implements ComparisonUseCasePort {
  constructor(private readonly useCase: DecomposedSearchUseCase) {}

  async execute(
    input: ComparisonUseCaseInput,
    requestId: string,
    options?: { readonly abortSignal?: AbortSignal | undefined },
  ): Promise<ComparisonSearchResponse> {
    const startTime = Date.now();
    const subQueries: [string, string] = [input.legs[0].surface, input.legs[1].surface];
    const comparisonLegs = mapComparisonLegsToDecompositionLegs(input.legs);
    const parentContext = buildParentContext(input);
    const useCaseOptions: DecomposedSearchExecutionOptions = {
      requestId,
      ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
    };

    return this.useCase.execute(
      subQueries,
      comparisonLegs,
      input.intent as ComparisonIntent,
      input.originalQuery,
      requestId,
      startTime,
      parentContext,
      useCaseOptions,
    );
  }
}

// ---------------------------------------------------------------------------
// Pure mapping helpers (exported for test coverage)
// ---------------------------------------------------------------------------

/**
 * Convert a single runner-port `ComparisonLeg` to a domain
 * `ComparisonDecompositionLeg`. The runner-port surface only carries the
 * lexical leg surface, so the entity-default tuple is used for all the
 * fields the runner does not expose.
 */
export function mapComparisonLegToDecompositionLeg(
  leg: ComparisonUseCaseInput['legs'][number],
): ComparisonDecompositionLeg {
  return {
    rawQuery: leg.surface,
    retrievalQuery: leg.surface,
    mode: 'entity',
    retrievalMode: 'auto',
    evidenceSource: 'entity_default',
  };
}

export function mapComparisonLegsToDecompositionLegs(
  legs: ComparisonUseCaseInput['legs'],
): ComparisonDecompositionLegs {
  return [
    mapComparisonLegToDecompositionLeg(legs[0]),
    mapComparisonLegToDecompositionLeg(legs[1]),
  ];
}

/**
 * Translate the runner-port shared/per-leg constraints into a
 * `DecomposedSearchParentContext`. Empty arrays are dropped to preserve
 * `exactOptionalPropertyTypes` hygiene on the downstream call.
 */
export function buildParentContext(
  input: ComparisonUseCaseInput,
): DecomposedSearchParentContext | undefined {
  const shared = input.sharedFilters !== undefined && input.sharedFilters.length > 0
    ? { filters: [...input.sharedFilters] as readonly NormalizedConstraint[] }
    : {};
  const sharedPrefs =
    input.sharedPreferences !== undefined && input.sharedPreferences.length > 0
      ? { preferences: [...input.sharedPreferences] as readonly NormalizedConstraint[] }
      : {};
  const perSide = buildPerSideFilters(input.legs);
  const parent: DecomposedSearchParentContext = {
    ...shared,
    ...sharedPrefs,
    ...(perSide !== undefined ? { perSideFilters: perSide } : {}),
  };
  return Object.keys(parent).length > 0 ? parent : undefined;
}

function buildPerSideFilters(
  legs: ComparisonUseCaseInput['legs'],
):
  | readonly [
    readonly NormalizedConstraint[] | undefined,
    readonly NormalizedConstraint[] | undefined,
  ]
  | undefined {
  const left = legs[0].constraints.length > 0
    ? ([...legs[0].constraints] as readonly NormalizedConstraint[])
    : undefined;
  const right = legs[1].constraints.length > 0
    ? ([...legs[1].constraints] as readonly NormalizedConstraint[])
    : undefined;
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return [left, right] as const;
}

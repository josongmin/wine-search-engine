/**
 * Epic 14: Decomposed Search Use Case
 *
 * Handles "A vs B" comparison queries by reusing the standard search seam
 * for each sub-query and merging the two responses.
 */

import { DomainError } from '../../domain/shared/error/domain-error.js';
import type { SearchRequest } from './search-request.dto.js';
import type { ComparisonSearchResponse, ComparisonEntity } from '../../domain/response/model/comparison-response.js';
import type { SearchExecutorPort } from './port/search-executor.port.js';
import type {
  DecomposedSearchExecutionOptions,
  DecomposedSearchParentContext,
} from './port/search-route-usecases.port.js';
import { buildComparisonAuthorityTraceRef } from '../../domain/decision/service/authority-trace.js';
import { throwIfAborted } from '../../domain/shared/cooperative-abort.js';
import type {
  ComparisonDecompositionLegs,
  ComparisonIntent,
} from '../../domain/query/model/query-decomposition.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { NormalizedConstraint } from '../../domain/shared/types/index.js';

export class UnexpectedDecomposedResponseError extends DomainError {
  constructor() {
    super(
      'UNEXPECTED_DECOMPOSED_RESPONSE',
      'Decomposed search expected standard search responses but received a comparison response.',
    );
    this.name = 'UnexpectedDecomposedResponseError';
  }
}

export class DecomposedSearchUseCase {
  constructor(private readonly searchUseCase: SearchExecutorPort) {}

  private resolveLegExecutionMode(
    leg: ComparisonDecompositionLegs[number],
    /**
     * Optional caller override (compare_wines.retrieval_mode → parentContext.retrievalMode).
     * When provided, it bypasses the leg's auto-detected mode entirely — this is the
     * api_override path, mirroring `search_wines.retrieval_mode` semantics. See
     * `DecomposedSearchParentContext.retrievalMode` for the rationale.
     */
    overrideMode?: 'auto' | 'entity' | 'hybrid' | 'mixed',
  ): 'auto' | 'entity' | 'hybrid' | 'mixed' {
    if (overrideMode !== undefined) {
      return overrideMode;
    }
    return leg.mode === 'entity' ? 'entity' : leg.retrievalMode;
  }

  private normalizeConceptValue(value: string | undefined): string | undefined {
    const normalized = value?.normalize('NFKC').trim().toLowerCase();
    return normalized !== undefined && normalized.length > 0 ? normalized : undefined;
  }

  private normalizeComparableString(value: string | undefined): string | undefined {
    const normalized = value
      ?.trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    return normalized !== undefined && normalized.length > 0 ? normalized : undefined;
  }

  private geographyContains(
    observed: string | undefined,
    expected: string | undefined,
  ): boolean {
    const normalizedObserved = this.normalizeComparableString(observed);
    const normalizedExpected = this.normalizeComparableString(expected);
    return normalizedObserved !== undefined
      && normalizedExpected !== undefined
      && normalizedObserved.includes(normalizedExpected);
  }

  private splitRegionPath(value: string | undefined): readonly string[] {
    if (value === undefined) {
      return [];
    }
    return value
      .split('/')
      .map((part) => this.normalizeConceptValue(part))
      .filter((part): part is string => part !== undefined);
  }

  private resultMatchesAppellationProjection(
    result: SearchResponseV1['results'][number],
    canonicalConcept: string,
  ): boolean {
    return this.geographyContains(result.entity.appellation, canonicalConcept)
      || this.geographyContains(result.entity.producer, canonicalConcept)
      || this.geographyContains(result.entity.canonicalLabel, canonicalConcept);
  }

  private resultMatchesConcept(
    result: SearchResponseV1['results'][number],
    conceptEntityType: NonNullable<ComparisonEntity['conceptEntityType']>,
    canonicalConcept: string,
  ): boolean {
    const canonical = this.normalizeConceptValue(canonicalConcept);
    if (canonical === undefined) {
      return false;
    }

    switch (conceptEntityType) {
      case 'country':
        return this.geographyContains(result.entity.country, canonicalConcept);
      case 'region':
        return this.splitRegionPath(result.entity.region).includes(canonical)
          || this.geographyContains(result.entity.region, canonicalConcept);
      case 'appellation':
        return this.resultMatchesAppellationProjection(result, canonicalConcept);
      case 'grape_primary':
        return (result.entity.grapes ?? [])
          .map((grape) => this.normalizeConceptValue(grape))
          .includes(canonical);
      case 'wine_type':
        return this.normalizeConceptValue(result.entity.wineType) === canonical;
    }
  }

  private resultMatchesConstraint(
    result: SearchResponseV1['results'][number],
    constraint: NormalizedConstraint,
  ): boolean {
    const normalize = (value: string | undefined) => this.normalizeConceptValue(value);
    const entity = result.entity;

    switch (constraint.attribute) {
      case 'country': {
        const target = typeof constraint.value === 'string' ? normalize(constraint.value) : undefined;
        if (target === undefined) {
          return false;
        }
        const includes = this.geographyContains(entity.country, target);
        return constraint.operator === 'exclude' ? !includes : includes;
      }
      case 'region': {
        const target = typeof constraint.value === 'string' ? normalize(constraint.value) : undefined;
        if (target === undefined) {
          return false;
        }
        const observed = this.splitRegionPath(entity.region);
        const includes = observed.includes(target) || this.geographyContains(entity.region, target);
        return constraint.operator === 'exclude' ? !includes : includes;
      }
      case 'appellation': {
        const target = typeof constraint.value === 'string' ? normalize(constraint.value) : undefined;
        if (target === undefined) {
          return false;
        }
        const includes = this.resultMatchesAppellationProjection(result, target);
        return constraint.operator === 'exclude' ? !includes : includes;
      }
      case 'grape_primary': {
        const target = typeof constraint.value === 'string' ? normalize(constraint.value) : undefined;
        if (target === undefined) {
          return false;
        }
        const grapes = (entity.grapes ?? [])
          .map((grape) => normalize(grape))
          .filter((grape): grape is string => grape !== undefined);
        const includes = grapes.includes(target);
        return constraint.operator === 'exclude' ? !includes : includes;
      }
      case 'wine_type': {
        const target = typeof constraint.value === 'string' ? normalize(constraint.value) : undefined;
        const observed = normalize(entity.wineType);
        if (target === undefined || observed === undefined) {
          return false;
        }
        return constraint.operator === 'exclude' ? observed !== target : observed === target;
      }
      case 'vintage_year': {
        const observed = entity.vintage;
        if (typeof observed !== 'number' || !Number.isFinite(observed) || typeof constraint.value !== 'number') {
          return false;
        }
        if (constraint.operator === '>=') {
          return observed >= constraint.value;
        }
        if (constraint.operator === '<=') {
          return observed <= constraint.value;
        }
        if (constraint.operator === '=') {
          return observed === constraint.value;
        }
        return false;
      }
      default:
        return true;
    }
  }

  private applySideFilters(
    results: readonly SearchResponseV1['results'][number][],
    sideFilters: readonly NormalizedConstraint[] | undefined,
  ): readonly SearchResponseV1['results'][number][] {
    if (sideFilters === undefined || sideFilters.length === 0) {
      return results;
    }
    return results.filter((entry) =>
      sideFilters.every((constraint) => this.resultMatchesConstraint(entry, constraint)),
    );
  }

  private buildConceptConsistentResultSet(
    leg: ComparisonDecompositionLegs[number],
    result: SearchResponseV1,
    sideFilters?: readonly NormalizedConstraint[],
  ): readonly SearchResponseV1['results'][number][] {
    const conceptEntityType = leg.conceptEntityType;
    const canonicalConcept = leg.canonicalConcept;
    if (
      leg.mode !== 'concept'
      || canonicalConcept === undefined
      || conceptEntityType === undefined
    ) {
      return this.applySideFilters(result.results, sideFilters);
    }

    return this.applySideFilters(result.results.filter((entry) =>
      this.resultMatchesConcept(entry, conceptEntityType, canonicalConcept),
    ), sideFilters);
  }

  private buildComparisonEntity(
    subQuery: string,
    leg: ComparisonDecompositionLegs[number],
    result: SearchResponseV1,
    sideFilters?: readonly NormalizedConstraint[],
  ): ComparisonEntity {
    const allResults = this.buildConceptConsistentResultSet(leg, result, sideFilters);
    const topResult = allResults[0] ?? null;
    const isConceptLeg = leg.mode === 'concept';

    return {
      subQuery,
      comparisonMode: leg.mode,
      ...(leg.canonicalConcept !== undefined
        ? { canonicalConcept: leg.canonicalConcept }
        : {}),
      ...(leg.conceptEntityType !== undefined
        ? { conceptEntityType: leg.conceptEntityType }
        : {}),
      ...(isConceptLeg
        && leg.canonicalConcept !== undefined
        && leg.conceptEntityType !== undefined
        ? {
            conceptAggregate: {
              canonicalConcept: leg.canonicalConcept,
              conceptEntityType: leg.conceptEntityType,
              representativeResult: topResult,
              prototypeAxis: allResults,
              aggregateResultCount: allResults.length,
            },
          }
        : {}),
      topResult,
      resultCount: allResults.length,
      resolutionStatus: result.engineDecision.decisionStatus === 'failed'
        ? 'failed'
        : isConceptLeg && allResults.length > 0
          ? 'resolved'
          : isConceptLeg
            ? 'failed'
          : result.engineDecision.decisionStatus,
      allResults,
    };
  }

  /**
   * Executes two reused searches for a decomposed comparison.
   *
   * @param subQueries - [queryA, queryB]
   * @param comparisonLegs - Upstream typed leg metadata for retrieval mode and concept/entity handling.
   * @param comparisonIntent - 'compare' | 'recommend_one' | 'list_both'
   * @param originalQuery - The original "A vs B" query
   * @param requestId - Parent request ID
   * @param startTime - Start timestamp for latency measurement
   */
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
    throwIfAborted(options?.abortSignal, 'Decomposed search aborted');

    const baseRequest: Omit<SearchRequest, 'query'> = {
      options: { mode: 'auto', explain: parentContext?.explain ?? false, clarification: false },
      ...(parentContext?.context !== undefined ? { context: parentContext.context } : {}),
      ...(parentContext?.sessionContext !== undefined
        ? { sessionContext: parentContext.sessionContext }
        : {}),
      ...(parentContext?.queryBudget !== undefined ? { queryBudget: parentContext.queryBudget } : {}),
      ...(parentContext?.filters !== undefined && parentContext.filters.length > 0
        ? { filters: parentContext.filters }
        : {}),
      ...(parentContext?.preferences !== undefined && parentContext.preferences.length > 0
        ? { preferences: parentContext.preferences }
        : {}),
    };

    // Reuse the main search seam for both sub-queries while honoring caller cancellation.
    // Use Promise.allSettled to avoid unhandled rejection when one sub-query fails
    // while the other is still in flight (the classic Promise.all double-rejection issue).
    const [settledA, settledB] = await Promise.allSettled([
      this.searchUseCase.execute(
        {
          ...baseRequest,
          ...(parentContext?.perSideFilters?.[0] !== undefined
            ? {
                filters: [
                  ...(baseRequest.filters ?? []),
                  ...parentContext.perSideFilters[0],
                ],
              }
            : {}),
          query: comparisonLegs[0].retrievalQuery,
          ...(comparisonLegs[0].mode === 'concept'
            && comparisonLegs[0].conceptEntityType !== undefined
            && comparisonLegs[0].canonicalConcept !== undefined
            ? {
                representativeConcept: {
                  field: comparisonLegs[0].conceptEntityType,
                  value: comparisonLegs[0].canonicalConcept,
                },
              }
            : {}),
          options: {
            explain: parentContext?.explain ?? false,
            clarification: false,
            mode: this.resolveLegExecutionMode(comparisonLegs[0], parentContext?.retrievalMode),
          },
        },
        `${requestId}-a`,
        options,
      ),
      this.searchUseCase.execute(
        {
          ...baseRequest,
          ...(parentContext?.perSideFilters?.[1] !== undefined
            ? {
                filters: [
                  ...(baseRequest.filters ?? []),
                  ...parentContext.perSideFilters[1],
                ],
              }
            : {}),
          query: comparisonLegs[1].retrievalQuery,
          ...(comparisonLegs[1].mode === 'concept'
            && comparisonLegs[1].conceptEntityType !== undefined
            && comparisonLegs[1].canonicalConcept !== undefined
            ? {
                representativeConcept: {
                  field: comparisonLegs[1].conceptEntityType,
                  value: comparisonLegs[1].canonicalConcept,
                },
              }
            : {}),
          options: {
            explain: parentContext?.explain ?? false,
            clarification: false,
            mode: this.resolveLegExecutionMode(comparisonLegs[1], parentContext?.retrievalMode),
          },
        },
        `${requestId}-b`,
        options,
      ),
    ]);
    if (settledA.status === 'rejected') {
      throw settledA.reason instanceof Error ? settledA.reason : new Error(String(settledA.reason));
    }
    if (settledB.status === 'rejected') {
      throw settledB.reason instanceof Error ? settledB.reason : new Error(String(settledB.reason));
    }
    const rawResultA = settledA.value;
    const rawResultB = settledB.value;

    throwIfAborted(options?.abortSignal, 'Decomposed search aborted');

    // Sub-queries should never themselves be comparison queries; narrow via discriminant
    if (rawResultA.queryType !== 'search' || rawResultB.queryType !== 'search') {
      throw new UnexpectedDecomposedResponseError();
    }
    const resultA = rawResultA;
    const resultB = rawResultB;

    // Build comparison entities from SearchResponseV1 results
    const entityA = this.buildComparisonEntity(
      subQueries[0],
      comparisonLegs[0],
      resultA,
      parentContext?.perSideFilters?.[0],
    );
    const entityB = this.buildComparisonEntity(
      subQueries[1],
      comparisonLegs[1],
      resultB,
      parentContext?.perSideFilters?.[1],
    );

    // Compute overall status
    const overallStatus = this.computeOverallStatus(
      entityA.resolutionStatus,
      entityB.resolutionStatus,
    );
    const leftAuthorityTraceRef =
      resultA.engineDecision.authorityTraceRef ?? resultA.engineDecision.decisionTraceRef;
    const rightAuthorityTraceRef =
      resultB.engineDecision.authorityTraceRef ?? resultB.engineDecision.decisionTraceRef;
    const authorityTraceRef = buildComparisonAuthorityTraceRef({
      originalQuery,
      comparisonIntent,
      overallStatus,
      leftAuthorityTraceRef,
      rightAuthorityTraceRef,
    });

    const executionTimeMs = Date.now() - startTime;

    return {
      queryType: 'comparison',
      originalQuery,
      comparisonIntent,
      entities: [entityA, entityB],
      overallStatus,
      requestId,
      executionTimeMs,
      authorityTraceRef,
      runtimeCorrelationRef: requestId,
    };
  }

  /**
   * Computes the overall decision status for a comparison.
   * Both resolved → resolved
   * One ambiguous → ambiguous
   * One/both no_match → failed
   */
  private computeOverallStatus(
    statusA: string,
    statusB: string,
  ): 'resolved' | 'ambiguous' | 'failed' {
    if (statusA === 'resolved' && statusB === 'resolved') {
      return 'resolved';
    }
    if (statusA === 'failed' || statusB === 'failed') {
      return 'failed';
    }
    if (statusA === 'ambiguous' || statusB === 'ambiguous') {
      return 'ambiguous';
    }
    return 'failed';
  }
}

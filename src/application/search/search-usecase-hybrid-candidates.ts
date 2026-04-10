import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { HybridCandidate } from '../../domain/retrieval/model/hybrid-candidate.js';
import type { HybridRetrievalInput } from '../../domain/retrieval/model/retrieval-input.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { EntityId } from '../../domain/shared/types/index.js';
import { pipelineDebug } from '../../observability/request-pipeline-debug.js';
import type {
  BrowseRetrieverPort,
  CandidatePoolPort,
  CompareRetrieverPort,
} from './port/search-pipeline-deps.port.js';
import type { RankingDegradationSignal } from '../../domain/ranking/model/ranking-runtime-signal.js';
import type { SpecializedFallbackReason } from './specialized-fallback-reason.js';
import type { SpecializedRouteObservability } from './specialized-route-observability.js';
import { buildRetrievalPlan } from '../../domain/retrieval/service/retrieval-plan-builder.js';
import type { RequestExecutionContext } from '../../domain/shared/request-execution-context.js';

/** Cap for producer/region/compare specialized hybrid retrieval. */
export const SPECIALIZED_HYBRID_RETRIEVAL_LIMIT = 20;

export function extractProducerBrowseSeed(plan: QueryPlanV1): string | undefined {
  // Tiebreak by surfaceForm for deterministic anchor selection when confidence is equal.
  // Without a tiebreaker, equal-confidence anchors produce different producer_browse seeds
  // across identical queries (JS sort is not stable across all V8 versions for equal keys).
  const strongestAnchor = [...plan.anchors].sort((left, right) => {
    const diff = right.confidence - left.confidence;
    return diff !== 0 ? diff : left.surfaceForm.localeCompare(right.surfaceForm);
  })[0];
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional: empty string from trim() should fall through to normalizedForm
  const candidate = strongestAnchor?.surfaceForm.trim() || strongestAnchor?.normalizedForm.trim();
  return candidate !== undefined && candidate.length > 0 ? candidate : undefined;
}

function isReadonlyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

export function extractRegionBrowseSeed(plan: QueryPlanV1): string | undefined {
  // Primary: explicit region/appellation/country constraint — most reliable signal.
  const regionConstraint = [...plan.constraints.hard, ...plan.constraints.soft, ...plan.constraints.inferred].find(
    (constraint) =>
      constraint.attribute === 'region' ||
      constraint.attribute === 'appellation' ||
      constraint.attribute === 'country',
  );

  if (regionConstraint !== undefined) {
    if (typeof regionConstraint.value === 'string' && regionConstraint.value.trim().length > 0) {
      return regionConstraint.value.trim();
    }
    if (isReadonlyStringArray(regionConstraint.value) && regionConstraint.value.length > 0) {
      return regionConstraint.value[0];
    }
  }

  // Secondary: hierarchical slash-notation queries (e.g. "Burgundy / Pinot Noir").
  // Only treat as a region seed when the query is clearly structured this way.
  const hierarchy = plan.normalizedQuery
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (hierarchy.length >= 2) {
    return hierarchy.join(' / ');
  }

  // No reliable region signal — return undefined rather than guessing from
  // the full query text. A false seed produces a wrong region_browse execution.
  return undefined;
}

export interface HybridCandidateRetrievalPorts {
  readonly candidatePool: CandidatePoolPort;
  readonly browseRetriever?: BrowseRetrieverPort | undefined;
  readonly compareRetriever?: CompareRetrieverPort | undefined;
}

export interface HybridCandidateRetrievalResult {
  readonly candidates: readonly HybridCandidate[];
  readonly routeDegradation?: RankingDegradationSignal | undefined;
  readonly specializedRouteObservability?: SpecializedRouteObservability | undefined;
}

export function buildHybridRetrievalInputForPlan(
  plan: QueryPlanV1,
  route: HybridRetrievalInput['route'] = 'hybrid',
  anchorEntityId?: EntityId,
  compiled?: CompiledWineQuery,
  requestContext?: RequestExecutionContext,
): HybridRetrievalInput {
  const retrievalPlan = compiled?.query.retrievalPlan ?? buildRetrievalPlan(plan.constraints);
  const structuredQueries = buildStructuredQueryExpansions(plan, retrievalPlan);
  return {
    queryPlan: plan,
    route,
    ...(compiled !== undefined ? { compiledRetrievalMode: compiled.execution.effectiveRetrievalMode } : {}),
    lexicalQueries: uniqueStrings([plan.normalizedQuery, ...structuredQueries.lexical]),
    semanticQueries: uniqueStrings([plan.rawQuery, ...structuredQueries.semantic]),
    hardConstraints: plan.constraints.hard,
    softConstraints: plan.constraints.soft,
    retrievalPlan,
    ...(anchorEntityId !== undefined ? { anchorEntityId } : {}),
    ...(requestContext !== undefined ? { requestContext } : {}),
  };
}

function buildStructuredQueryExpansions(
  plan: QueryPlanV1,
  retrievalPlan: ReturnType<typeof buildRetrievalPlan>,
): {
  readonly lexical: readonly string[];
  readonly semantic: readonly string[];
} {
  const lexical: string[] = [];
  const semantic: string[] = [];
  for (const constraint of plan.constraints.hard) {
    const phrase = retrievalValueToPhrase(constraint.value);
    if (phrase !== undefined) {
      lexical.push(phrase);
      if (constraint.attribute === 'region' || constraint.attribute === 'country' || constraint.attribute === 'appellation') {
        semantic.push(phrase);
      }
    }
  }
  for (const boost of [...retrievalPlan.softBoosts, ...retrievalPlan.inferredBoosts]) {
    const phrase = retrievalValueToPhrase(boost.value);
    if (phrase === undefined) {
      continue;
    }
    lexical.push(phrase);
    if (boost.attribute === 'region' || boost.attribute === 'country' || boost.attribute === 'grape_family') {
      semantic.push(phrase);
    }
  }
  return { lexical: uniqueStrings(lexical), semantic: uniqueStrings(semantic) };
}

function retrievalValueToPhrase(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim().length > 0 ? value.trim() : undefined;
  }
  if (typeof value === 'number') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    return parts.length > 0 ? parts.join(' ') : undefined;
  }
  if (
    typeof value === 'object'
    && value !== null
    && 'min' in value
    && 'max' in value
  ) {
    const min = typeof value.min === 'number' ? value.min.toString() : undefined;
    const max = typeof value.max === 'number' ? value.max.toString() : undefined;
    return [min, max].filter((entry): entry is string => entry !== undefined).join(' ');
  }
  return undefined;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

/**
 * Specialized browse/compare paths first; falls back to {@link CandidatePoolPort.generate}.
 *
 * E2-U4: Accepts optional CompiledWineQuery. When present, specialised path dispatch
 * uses compiled.execution.effectiveRetrievalMode (authoritative) instead of
 * plan.retrievalMode (V1 fallback).
 */
export async function retrieveHybridCandidatesForPlan(
  plan: QueryPlanV1,
  ports: HybridCandidateRetrievalPorts,
  resolveEntity: (p: QueryPlanV1) => Promise<EntityResolveResult>,
  compiled?: CompiledWineQuery,
  requestContext?: RequestExecutionContext,
): Promise<HybridCandidateRetrievalResult> {
  // E2-U4: compiled-first mode for specialised path dispatch
  const effectiveMode = compiled?.execution.effectiveRetrievalMode ?? plan.retrievalMode;

  const limit = SPECIALIZED_HYBRID_RETRIEVAL_LIMIT;
  let fallbackAnchorEntityId: EntityId | undefined;
  const degradationReasons = new Set<SpecializedFallbackReason>();
  const requestedRoute = (
    effectiveMode === 'producer_browse' ||
    effectiveMode === 'region_browse' ||
    effectiveMode === 'compare_candidates'
  )
    ? effectiveMode
    : null;

  pipelineDebug(
    {
      step: 'retrieval.hybrid_candidates.start',
      retrieval_mode: effectiveMode,
      query_class: plan.queryClass,
    },
    'pipeline hybrid retrieval',
  );

  switch (effectiveMode) {
    case 'producer_browse': {
      const producerName = extractProducerBrowseSeed(plan);
      if (ports.browseRetriever === undefined) {
        degradationReasons.add('producer_browse_unavailable');
        break;
      }
      if (producerName !== undefined) {
        const candidates = await ports.browseRetriever.browseProducer(
          producerName,
          plan.constraints,
          limit,
        );
        if (candidates.length > 0) {
          pipelineDebug(
            {
              step: 'retrieval.producer_browse',
              candidate_count: candidates.length,
            },
            'pipeline specialized retrieval',
          );
          return {
            candidates,
            specializedRouteObservability: {
              specializedRouteRequested: 'producer_browse',
              specializedRouteExecuted: 'producer_browse',
              fallbackApplied: false,
            },
          };
        }
        degradationReasons.add('producer_browse_fallback');
      } else {
        degradationReasons.add('producer_browse_fallback');
      }
      break;
    }
    case 'region_browse': {
      const regionName = extractRegionBrowseSeed(plan);
      if (ports.browseRetriever === undefined) {
        degradationReasons.add('region_browse_unavailable');
        break;
      }
      if (regionName !== undefined) {
        const candidates = await ports.browseRetriever.browseRegion(
          regionName,
          plan.constraints,
          limit,
        );
        if (candidates.length > 0) {
          pipelineDebug(
            {
              step: 'retrieval.region_browse',
              candidate_count: candidates.length,
            },
            'pipeline specialized retrieval',
          );
          return {
            candidates,
            specializedRouteObservability: {
              specializedRouteRequested: 'region_browse',
              specializedRouteExecuted: 'region_browse',
              fallbackApplied: false,
            },
          };
        }
        degradationReasons.add('region_browse_fallback');
      } else {
        degradationReasons.add('region_browse_fallback');
      }
      break;
    }
    case 'compare_candidates': {
      if (ports.compareRetriever !== undefined) {
        const anchorResolution = await resolveEntity(plan);
        // Only use a resolver-validated entity as anchor — never fall back to
        // unverified raw planner candidateEntityIds, which can produce wrong compares
        // and would be mislabelled as 'compare_candidates_fallback' instead of
        // 'compare_anchor_resolution_failed'.
        const anchorEntityId = anchorResolution.topEntity?.entityId;
        fallbackAnchorEntityId = anchorEntityId;
        if (anchorEntityId !== undefined) {
          const candidates = await ports.compareRetriever.compareAgainstAnchor(
            anchorEntityId,
            plan.constraints,
            limit,
          );
          if (candidates.length > 0) {
            pipelineDebug(
              {
                step: 'retrieval.compare_candidates',
                candidate_count: candidates.length,
              },
              'pipeline specialized retrieval',
            );
            return {
              candidates,
              specializedRouteObservability: {
                specializedRouteRequested: 'compare_candidates',
                specializedRouteExecuted: 'compare_candidates',
                fallbackApplied: false,
              },
            };
          }
          degradationReasons.add('compare_candidates_fallback');
        } else {
          // Resolver returned no validated entity — label correctly and fall through.
          degradationReasons.add('compare_anchor_resolution_failed');
        }
      } else {
        degradationReasons.add('compare_retriever_unavailable');
      }
      break;
    }
    default:
      break;
  }

  const retrievalInput = buildHybridRetrievalInputForPlan(
    plan,
    'hybrid',
    fallbackAnchorEntityId,
    compiled,
    requestContext,
  );

  pipelineDebug({ step: 'retrieval.candidate_pool.fallback' }, 'pipeline candidate pool generate');
  const candidates = ports.candidatePool.execute !== undefined
    ? await ports.candidatePool.execute(retrievalInput)
    : await ports.candidatePool.generate(retrievalInput);
  return {
    candidates,
    ...(degradationReasons.size > 0
      ? {
          routeDegradation: {
            executionMode: 'degraded',
            degradationReasons: [...degradationReasons],
          },
        }
      : {}),
    ...(requestedRoute !== null
      ? {
          specializedRouteObservability: {
            specializedRouteRequested: requestedRoute,
            specializedRouteExecuted: null,
            fallbackApplied: degradationReasons.size > 0,
            ...(degradationReasons.size > 0 ? { fallbackReason: [...degradationReasons][0] } : {}),
          },
        }
      : {}),
  };
}

import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
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
import type { SpecializedRouteName, SpecializedRouteObservability } from './specialized-route-observability.js';

/** Cap for producer/region/compare specialized hybrid retrieval. */
export const SPECIALIZED_HYBRID_RETRIEVAL_LIMIT = 20;

export function extractProducerBrowseSeed(plan: QueryPlanV1): string | undefined {
  const strongestAnchor = [...plan.anchors].sort((left, right) => right.confidence - left.confidence)[0];
  const candidate = strongestAnchor?.surfaceForm.trim() || strongestAnchor?.normalizedForm.trim();
  return candidate !== undefined && candidate.length > 0 ? candidate : undefined;
}

export function extractRegionBrowseSeed(plan: QueryPlanV1): string | undefined {
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
    if (Array.isArray(regionConstraint.value) && regionConstraint.value[0] !== undefined) {
      const [firstValue] = regionConstraint.value as readonly unknown[];
      return typeof firstValue === 'string' ? firstValue : undefined;
    }
  }

  const hierarchy = plan.normalizedQuery
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (hierarchy.length >= 2) {
    return hierarchy.join(' / ');
  }

  const compact = plan.normalizedQuery
    .replace(/\b(?:wine|wines|show|browse|from|region|appellation)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return compact.length > 0 ? compact : undefined;
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
): HybridRetrievalInput {
  return {
    queryPlan: plan,
    route,
    lexicalQueries: [plan.normalizedQuery],
    semanticQueries: [plan.rawQuery],
    hardConstraints: plan.constraints.hard,
    softConstraints: plan.constraints.soft,
    ...(anchorEntityId !== undefined ? { anchorEntityId } : {}),
  };
}

/**
 * Specialized browse/compare paths first; falls back to {@link CandidatePoolPort.generate}.
 */
export async function retrieveHybridCandidatesForPlan(
  plan: QueryPlanV1,
  ports: HybridCandidateRetrievalPorts,
  resolveEntity: (p: QueryPlanV1) => Promise<EntityResolveResult>,
): Promise<HybridCandidateRetrievalResult> {
  const limit = SPECIALIZED_HYBRID_RETRIEVAL_LIMIT;
  let fallbackAnchorEntityId = plan.anchors[0]?.candidateEntityIds[0];
  const degradationReasons = new Set<SpecializedFallbackReason>();
  const requestedRoute = (
    plan.retrievalMode === 'producer_browse' ||
    plan.retrievalMode === 'region_browse' ||
    plan.retrievalMode === 'compare_candidates'
  )
    ? plan.retrievalMode as SpecializedRouteName
    : null;

  pipelineDebug(
    {
      step: 'retrieval.hybrid_candidates.start',
      retrieval_mode: plan.retrievalMode,
      query_class: plan.queryClass,
    },
    'pipeline hybrid retrieval',
  );

  switch (plan.retrievalMode) {
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
        const anchorEntityId = anchorResolution.topEntity?.entityId
          ?? plan.anchors[0]?.candidateEntityIds[0];
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
  );

  pipelineDebug({ step: 'retrieval.candidate_pool.fallback' }, 'pipeline candidate pool generate');
  const candidates = await ports.candidatePool.generate(retrievalInput);
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

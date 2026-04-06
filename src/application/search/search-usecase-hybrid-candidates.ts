import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { HybridCandidate } from '../../domain/retrieval/model/hybrid-candidate.js';
import type { HybridRetrievalInput } from '../../domain/retrieval/model/retrieval-input.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type {
  BrowseRetrieverPort,
  CandidatePoolPort,
  CompareRetrieverPort,
} from './port/search-pipeline-deps.port.js';

/** Cap for producer/region/compare specialized hybrid retrieval. */
export const SPECIALIZED_HYBRID_RETRIEVAL_LIMIT = 20;

export function extractProducerBrowseSeed(plan: QueryPlanV1): string | undefined {
  const strongestAnchor = [...plan.anchors].sort((left, right) => right.confidence - left.confidence)[0];
  const candidate = strongestAnchor?.surfaceForm.trim() ?? strongestAnchor?.normalizedForm.trim();
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

export function buildHybridRetrievalInputForPlan(
  plan: QueryPlanV1,
  route: HybridRetrievalInput['route'] = 'hybrid',
): HybridRetrievalInput {
  return {
    queryPlan: plan,
    route,
    lexicalQueries: [plan.normalizedQuery],
    semanticQueries: [plan.rawQuery],
    hardConstraints: plan.constraints.hard,
    softConstraints: plan.constraints.soft,
  };
}

/**
 * Specialized browse/compare paths first; falls back to {@link CandidatePoolPort.generate}.
 */
export async function retrieveHybridCandidatesForPlan(
  plan: QueryPlanV1,
  ports: HybridCandidateRetrievalPorts,
  resolveEntity: (p: QueryPlanV1) => Promise<EntityResolveResult>,
): Promise<readonly HybridCandidate[]> {
  const limit = SPECIALIZED_HYBRID_RETRIEVAL_LIMIT;

  switch (plan.retrievalMode) {
    case 'producer_browse': {
      const producerName = extractProducerBrowseSeed(plan);
      if (producerName !== undefined && ports.browseRetriever !== undefined) {
        const candidates = await ports.browseRetriever.browseProducer(
          producerName,
          plan.constraints,
          limit,
        );
        if (candidates.length > 0) {
          return candidates;
        }
      }
      break;
    }
    case 'region_browse': {
      const regionName = extractRegionBrowseSeed(plan);
      if (regionName !== undefined && ports.browseRetriever !== undefined) {
        const candidates = await ports.browseRetriever.browseRegion(
          regionName,
          plan.constraints,
          limit,
        );
        if (candidates.length > 0) {
          return candidates;
        }
      }
      break;
    }
    case 'compare_candidates': {
      if (ports.compareRetriever !== undefined) {
        const anchorResolution = await resolveEntity(plan);
        const anchorEntityId = anchorResolution.topEntity?.entityId
          ?? plan.anchors[0]?.candidateEntityIds[0];
        if (anchorEntityId !== undefined) {
          const candidates = await ports.compareRetriever.compareAgainstAnchor(
            anchorEntityId,
            plan.constraints,
            limit,
          );
          if (candidates.length > 0) {
            return candidates;
          }
        }
      }
      break;
    }
    default:
      break;
  }

  const retrievalInput = buildHybridRetrievalInputForPlan(plan, 'hybrid');

  return ports.candidatePool.generate(retrievalInput);
}

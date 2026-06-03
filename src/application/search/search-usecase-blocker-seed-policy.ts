import type { AnchorCandidate } from '../../domain/query/model/anchor-candidate.js';
import type { QueryClass } from '../../domain/shared/types/query-class.js';
import type { AmbiguityInfo } from '../../domain/query/port/ambiguity-dictionary.port.js';
import { isExactLikeLookupStrategy } from '../../domain/query/service/lookup-strategy-taxonomy.js';

export function hasDeterministicSingletonAliasWitness(
  anchors: readonly AnchorCandidate[],
): boolean {
  const uniqueAnchorEntityIds = new Set(
    anchors.flatMap((anchor) => anchor.candidateEntityIds.map(String)),
  );
  if (uniqueAnchorEntityIds.size !== 1) {
    return false;
  }

  return anchors.some((anchor) =>
    anchor.source === 'alias'
    && anchor.confidence === 1
    && anchor.candidateEntityIds.length === 1
    && (anchor.lookupStrategies?.some((strategy) => isExactLikeLookupStrategy(strategy)) ?? false),
  );
}

/**
 * Blocker seeds are a high-recall recovery tool for anchor-miss paths.
 *
 * When the planner already produced an authoritative singleton alias
 * witness, adding blocker-only entities widens the candidate pool without
 * increasing recall and can manufacture false ambiguity in the entity route.
 *
 * Keep this policy narrow:
 * - exactly one unique entity is already covered by anchors
 * - at least one anchor is a deterministic singleton alias witness
 * - that witness is full-confidence (1.0) and maps to a single entity
 */
export function shouldSuppressBlockerSeedExpansion(
  anchors: readonly AnchorCandidate[],
): boolean {
  return hasDeterministicSingletonAliasWitness(anchors);
}

export function shouldSuppressBlockerSeedExpansionForKnownShortAmbiguity(args: {
  readonly queryClass: QueryClass;
  readonly anchors: readonly AnchorCandidate[];
  readonly persistedAmbiguity: AmbiguityInfo | null;
}): boolean {
  if (args.persistedAmbiguity === null) {
    return false;
  }
  if (hasDeterministicSingletonAliasWitness(args.anchors)) {
    return false;
  }
  return args.queryClass === 'short_entity' || args.queryClass === 'ambiguous_short_form';
}

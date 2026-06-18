import type { AnchorCandidate } from '../../domain/query/model/anchor-candidate.js';
import type { QueryClass } from '../../domain/shared/types/query-class.js';
import type { AmbiguityInfo } from '../../domain/query/port/ambiguity-dictionary.port.js';
import {
  findRawQueryExactSafeSingletonAliasWitness as findRawQueryExactSafeSingletonAliasWitnessInternal,
  hasDeterministicSingletonAliasWitness as hasDeterministicSingletonAliasWitnessInternal,
} from '../../domain/query/service/exact-safe-anchor-witness.js';

export function hasDeterministicSingletonAliasWitness(
  anchors: readonly AnchorCandidate[],
): boolean {
  return hasDeterministicSingletonAliasWitnessInternal(anchors);
}

export function findRawQueryExactSafeSingletonAliasWitness(
  rawQuery: string,
  normalizedQuery: string,
  anchors: readonly AnchorCandidate[],
) {
  return findRawQueryExactSafeSingletonAliasWitnessInternal(rawQuery, normalizedQuery, anchors);
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
  readonly rawQuery?: string | undefined;
  readonly queryClass: QueryClass;
  readonly anchors: readonly AnchorCandidate[];
  readonly persistedAmbiguity: AmbiguityInfo | null;
  readonly normalizedQuery?: string | undefined;
}): boolean {
  if (args.persistedAmbiguity === null) {
    return false;
  }
  if (hasDeterministicSingletonAliasWitness(args.anchors)) {
    return false;
  }
  if (
    typeof args.rawQuery === 'string'
    && typeof args.normalizedQuery === 'string'
    && findRawQueryExactSafeSingletonAliasWitness(args.rawQuery, args.normalizedQuery, args.anchors) !== undefined
  ) {
    return false;
  }
  return args.queryClass === 'short_entity' || args.queryClass === 'ambiguous_short_form';
}

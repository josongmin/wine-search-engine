import type { EntityId } from '../../shared/types/index.js';
import type { AliasType } from '../../alias/model/alias.js';
import type { MatchSignalSet } from './match-signal-set.js';

/**
 * A candidate that has been scored, calibrated, and ranked by the resolver.
 */
export interface ResolvedCandidate {
  /** The entity this candidate represents. */
  readonly entityId: EntityId;

  /** The canonical display name for the entity. */
  readonly canonicalLabel: string;

  /** The calibrated score assigned to this candidate in [0, 1]. */
  readonly calibratedScore: number;

  /** 1-based rank among all candidates (1 = best). */
  readonly rank: number;

  /** References to evidence items that support this candidate. */
  readonly evidenceRefs: readonly string[];
}

/**
 * A raw candidate entity entering the resolver pipeline before scoring.
 * Carries all source signals needed for the weighted scoring function.
 */
export interface ResolverCandidate {
  /** The entity this candidate represents. */
  readonly entityId: EntityId;

  /** The type of entity (e.g. 'wine', 'producer', 'region'). */
  readonly entityType: string;

  /** The canonical display name for the entity. */
  readonly canonicalLabel: string;

  /** Alias matches that contributed to this candidate's selection. */
  readonly aliasMatches: readonly AliasMatchInfo[];

  /** Optional attribute hints (vintage, region, grape, etc.). */
  readonly attributeHints?: Readonly<Record<string, unknown>>;

  /** The full set of match signals for scoring. */
  readonly sourceSignals: MatchSignalSet;
}

/**
 * Information about a single alias match that contributed to candidate selection.
 */
export interface AliasMatchInfo {
  /** The alias surface form that matched. */
  readonly aliasValue: string;

  /** The type of the matched alias. */
  readonly aliasType: AliasType;

  /** Raw match score in [0, 1]. */
  readonly matchScore: number;
}

import type { CanonicalEntityId } from '../../shared/types/index.js';
import type { AliasType } from '../../alias/model/alias.js';
import type { MatchSignalSet } from './match-signal-set.js';
import type { EntityCandidateSource } from './entity-candidate-generator-input.js';
import type { SourceRecordRef } from '../../entity/model/source-record-ref.js';
import type { ResolverCandidateTrace } from './decision-trace.js';
import type { LookupIdentityCertificate } from '../../shared/types/search-snapshot-lookup-runtime.js';

/**
 * A candidate that has been scored, calibrated, and ranked by the resolver.
 */
export interface ResolvedCandidate {
  /** The entity this candidate represents. */
  readonly entityId: CanonicalEntityId;

  /** The canonical display name for the entity. */
  readonly canonicalLabel: string;

  /** The calibrated score assigned to this candidate in [0, 1]. */
  readonly calibratedScore: number;

  /** 1-based rank among all candidates (1 = best). */
  readonly rank: number;

  /** References to evidence items that support this candidate. */
  readonly evidenceRefs: readonly string[];

  /**
   * Generalized candidate source provenance.
   *
   * Runtime-produced candidates should always populate this. It remains
   * optional for backward compatibility with older fixtures and tests.
   */
  readonly source?: EntityCandidateSource | undefined;

  /**
   * Full source provenance set for this candidate.
   *
   * Unlike {@link source}, this preserves mixed-source candidates that were
   * supported by several upstream generators (alias + planner heuristic, etc.).
   */
  readonly sources?: readonly EntityCandidateSource[] | undefined;

  /**
   * TA2-4: Whether this candidate originated from a blocker seed rather than
   * an alias anchor lookup. Present and `true` for candidates that entered the
   * pipeline via `blockerOnlyIds` — i.e. the blocker found the entity but the
   * alias extractor did not. Absent (undefined) for anchor-sourced candidates.
   *
   * Used downstream for provenance tagging and corrective retry logging.
   */
  readonly blockerSeed?: true | undefined;

  /**
   * T-E4-02: Per-candidate structured trace capturing the resolver's internal
   * score/calibration/boundary state at ranking time.
   *
   * Present when the resolver populates trace data. Enables exact-route failure
   * reproduction from a single request trace without access to separate logs.
   */
  readonly trace?: ResolverCandidateTrace | undefined;
}

/**
 * A raw candidate entity entering the resolver pipeline before scoring.
 * Carries all source signals needed for the weighted scoring function.
 */
export interface ResolverCandidate {
  /** The entity this candidate represents. */
  readonly entityId: CanonicalEntityId;

  /** The type of entity (e.g. 'wine', 'producer', 'region'). */
  readonly entityType: string;

  /** The canonical display name for the entity. */
  readonly canonicalLabel: string;

  /** Alias matches that contributed to this candidate's selection. */
  readonly aliasMatches: readonly AliasMatchInfo[];

  /** Optional attribute hints (vintage, region, grape, etc.). */
  readonly attributeHints?: Readonly<Record<string, unknown>>;

  /** Indexed lineage references preserved for entity-route result synthesis. */
  readonly sourceRecordRefs?: readonly SourceRecordRef[] | undefined;

  /**
   * Registry-backed exact-safe identity certificates that matched the RAW
   * query surface. Present only for candidates whose anchor/query surface was
   * promoted by the dedicated lookup exact-safe registry.
   */
  readonly identityCertificates?: readonly LookupIdentityCertificate[] | undefined;

  /** The full set of match signals for scoring. */
  readonly sourceSignals: MatchSignalSet;

  /**
   * TA2-4: Origin of this candidate.
   *
   * - `'alias'` / `'planner_heuristic'` / `'entity_lookup'` — classic alias-anchor path.
   * - `'blocker_seed'` — entity returned by Blocker.block() that was NOT present in
   *   any anchor's candidateEntityIds. Carries ZERO_SIGNALS; relies on attribute-hint
   *   scoring. Absent on candidates built before TA2-4 was wired.
   */
  readonly source?: EntityCandidateSource | undefined;

  /**
   * Full source provenance set for this raw candidate.
   *
   * Preferred internal truth when the same entity is supported by multiple
   * upstream generators. `source` remains as the single-source compatibility
   * surface and may be undefined for mixed/legacy candidates.
   */
  readonly sources?: readonly EntityCandidateSource[] | undefined;
}

/**
 * Information about a single alias match that contributed to candidate selection.
 */
export interface AliasMatchInfo {
  /** The alias surface form that matched. */
  readonly aliasValue: string;

  /**
   * The type of the matched alias.
   *
   * Optional for degraded / legacy substrates that can recover a matching
   * surface but cannot recover the per-alias type. Downstream scorers must
   * treat `undefined` as unknown and fall back to strategy/signal-based guards
   * instead of crashing the exact-entity route.
   */
  readonly aliasType?: AliasType | undefined;

  /** Raw match score in [0, 1]. */
  readonly matchScore: number;
}

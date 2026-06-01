import type { QueryClass } from '../../shared/types/index.js';
import type { QueryPolicy } from '../../query/model/query-policy.js';
import type { QueryUncertainty } from '../../query/model/query-uncertainty.js';
import type { NormalizedQueryViews } from '../../query/model/query-views.js';
import type { AnchorCandidate } from '../../query/model/anchor-candidate.js';
import type { ResolverCandidate } from './resolved-candidate.js';

/**
 * Input required to run the entity resolution pipeline.
 */
export interface ResolverInput {
  /** The original user query string. */
  readonly rawQuery: string;

  /** Lowercased, accent-stripped, whitespace-collapsed form. */
  readonly normalizedQuery: string;

  /** Multi-view query normalization snapshot for noisy lookup debugging. */
  readonly normalizedQueryViews?: NormalizedQueryViews | undefined;

  /** Query class label used to select thresholds. */
  readonly queryClass: QueryClass;

  /** Compiled policy directives. */
  readonly policy: QueryPolicy;

  /** Anchor entities extracted from the query. */
  readonly anchorCandidates: readonly AnchorCandidate[];

  /** Uncertainty assessment from the query planner. */
  readonly uncertainty: QueryUncertainty;

  /** Pre-loaded candidate entities (may come from external retrieval). */
  readonly candidateEntities: readonly ResolverCandidate[];

  /**
   * Controls whether the resolver re-applies its internal blocker gate to the
   * provided candidate pool.
   *
   * - `enforce_blocker` (default): resolver calls `Blocker.block()` and keeps
   *   only candidates whose IDs survive blocking.
   * - `trust_candidate_pool`: caller asserts `candidateEntities` is already the
   *   authoritative entity pool (for example, built from exact alias/entity-id
   *   hydration upstream). Resolver skips the extra blocker filter so exact
   *   candidates are not erased by a degraded / unavailable blocker substrate.
   */
  readonly blockingPolicy?: 'enforce_blocker' | 'trust_candidate_pool' | undefined;

  /**
   * TA2-4: Blocker-seeded candidates — entities returned by `Blocker.block()`
   * that were NOT already covered by any anchor's `candidateEntityIds`.
   *
   * These carry zero-filled signal sets (`ZERO_SIGNALS`) and `source:
   * 'blocker_seed'`. They enter the scorer's attribute-hint pathway.
   *
   * Produced upstream by `buildResolverCandidatesFromGenerator()` when
   * the caller supplies `blockerOnlyIds`.  If undefined (not yet wired),
   * the pipeline falls back to the current anchors-only behaviour.
   */
  readonly blockerSeedCandidates?: readonly ResolverCandidate[] | undefined;
}

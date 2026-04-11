import type { EntityId } from '../../shared/types/index.js';
import type { AnchorCandidate } from '../../query/model/anchor-candidate.js';
import type { RetrievalDocument } from '../../retrieval/model/retrieval-document.js';

/**
 * TA2-1: Shared entity candidate generator contract.
 *
 * Captures every source that can produce entity hypotheses for the resolver
 * pipeline. Prior to TA2 the pipeline only consumed `plan.anchors` — blocking
 * candidates that survived the alias lookup but were never seeded from the
 * blocker's own recall output.
 *
 * Generator sources (non-exclusive; same entityId may appear from several):
 *   1. anchor   — classic AnchorCandidate produced by AnchorExtractor (alias match)
 *   2. blocker  — IDs returned directly by Blocker.block() that were NOT already
 *                 present in any anchor's candidateEntityIds; these are high-recall
 *                 seeds without full signal sets
 *   3. fuzzy    — FuzzyMatcher hits passed through planner.fuzzyExpansions when
 *                 no anchor was found; currently fold into AnchorCandidate but
 *                 tracked separately here for signal quality separation
 *
 * Design invariants:
 *   - No parallel truth structures. This type is the single entry point that
 *     `buildResolverCandidatesFromPlan()` consumes. It does NOT replace
 *     QueryPlanV2/CandidateProvenance/componentScores.
 *   - `preloadedDocs` is an optional hot-cache from an upstream prefetch so
 *     generators don't each trigger their own N+1 document fetches.
 *   - The contract is additive — new sources can be added without changing
 *     the consumer signature.
 */
export interface EntityCandidateGeneratorInput {
  /**
   * Raw user query string (passed through for blocker recall).
   */
  readonly rawQuery: string;

  /**
   * Lowercased, accent-stripped, whitespace-collapsed query.
   */
  readonly normalizedQuery: string;

  /**
   * Anchor candidates extracted by the planner (alias match source).
   * May be empty for pure intent / attribute queries.
   */
  readonly anchors: readonly AnchorCandidate[];

  /**
   * Entity IDs returned by `Blocker.block()` that are NOT already covered by
   * any anchor's `candidateEntityIds`.
   *
   * These are seeded as `source: 'blocker_seed'` candidates with zero-filled
   * signal sets — they will receive full signal population once their documents
   * are fetched.
   *
   * Undefined (not present) means the blocker has not been called yet.
   * An empty array means blocker was called and returned nothing beyond anchors.
   */
  readonly blockerOnlyIds?: readonly EntityId[] | undefined;

  /**
   * Pre-loaded document map from an upstream prefetch step.
   * When present, `buildResolverCandidatesFromGenerator()` skips re-fetching
   * these IDs. Keys are string-coerced EntityIds.
   *
   * This is an optimisation cache — absence does NOT break correctness, only
   * latency.
   */
  readonly preloadedDocs?: ReadonlyMap<string, RetrievalDocument> | undefined;
}

/**
 * Source tag added to `AnchorCandidate.source` for blocker-seeded candidates.
 *
 * TA2-2: The existing union `'alias' | 'planner_heuristic' | 'entity_lookup'`
 * is extended with this value. Blockers produce entity IDs from high-recall
 * inverted-index queries. They carry no alias surface form, so signal sets are
 * initialised to zero and rely on the scorer's attribute-hint pathway.
 */
export type BlockerSeedSource = 'blocker_seed';

/**
 * Extended source union including the blocker-seed provenance tag.
 * Replace `AnchorCandidate['source']` references with this type
 * when both classic and blocker-seeded candidates are in scope.
 */
export type EntityCandidateSource =
  | AnchorCandidate['source']
  | BlockerSeedSource;

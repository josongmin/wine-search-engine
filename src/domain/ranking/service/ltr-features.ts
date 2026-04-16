/**
 * LTR feature extraction (Epic-10 SOTA++ Real LTR foundation).
 *
 * Produces a fixed-shape feature vector from a retrieved candidate plus
 * its query context. The vector is consumed by:
 *   - LightGBM LambdaMART training pipeline (offline)
 *   - Vespa second-phase rerank (when serve parity is verified)
 *   - Online observability / drift monitoring
 *
 * Features are deterministic, side-effect-free, and computed without LLM
 * calls. Raw values are NOT clamped here — clamping is the LTR caller's
 * responsibility (some models prefer raw signals; others want [0, 1]).
 */

import type { HybridCandidate } from '../../retrieval/model/hybrid-candidate.js';
import { containsHangul } from '../../shared/utils/hangul.js';
import type { NormalizedConstraint } from '../../shared/types/index.js';
import type { ConstraintGraph } from '../../query/model/constraint-graph.js';
import { computeGraphCoverage } from '../../query/service/compute-graph-coverage.js';
import { projectHardTierSubgraph } from '../../query/service/graph-tier-projection.js';

/** Default neutral confidence when a signal cannot be measured. */
const DEFAULT_NEUTRAL_CONFIDENCE = 0.5;
/** Threshold above which a learned facet score counts as "strong match" for LTR binary features. */
const LEARNED_FACET_STRONG_THRESHOLD = 0.6;
/** Score for partial label match: query contains canonical label as substring. */
const PARTIAL_LABEL_MATCH_SCORE = 0.5;
/** Hangul Syllables block — used to detect Korean queries. */
// Hangul detection delegates to @shared/utils/hangul (SSoT).
/**
 * Returns the current calendar year. Recomputed per call to avoid a
 * year-rollover bug for long-lived processes: a module-scope constant
 * initialized at load time would go stale on Dec 31 → Jan 1 and mis-classify
 * drinking-window ranges for an entire year until the process restarts.
 * `new Date().getFullYear()` is cheap enough to call N times per query.
 */
function ltrCurrentYear(): number {
  return new Date().getFullYear();
}

interface LTRFeatureVector {
  // Retrieval signals (5)
  readonly bm25_score: number;
  readonly dense_score: number;
  readonly anchor_score: number;
  readonly fusion_score: number;
  readonly cross_channel_overlap: number;

  // Constraint match signals (5)
  readonly hard_constraint_match_ratio: number;
  readonly soft_constraint_match_ratio: number;
  readonly inferred_constraint_match_ratio: number;
  readonly constraint_violation_count: number;
  readonly constraint_satisfaction_confidence: number;

  // Entity signals (4)
  readonly entity_link_confidence: number;
  readonly canonical_label_match: number;
  readonly producer_match: number;
  readonly region_match: number;

  // Quality signals (4)
  readonly critic_score_normalized: number;
  readonly producer_prestige: number;
  readonly popularity_score: number;
  readonly drinking_window_in_range: number;

  // Query-doc cross signals (4)
  readonly query_length_tokens: number;
  readonly query_has_korean: number;
  readonly doc_label_korean_alias_match: number;
  readonly query_doc_script_compat: number;

  // Degradation signals (4)
  readonly is_dense_degraded: number;
  readonly is_sparse_degraded: number;
  readonly is_anchor_degraded: number;
  readonly degraded_channel_count: number;

  // Situation facet signals (4) — Track C learned facets (gift / beginner).
  // Absent score → 0 (no signal); strong threshold derived from LEARNED_FACET_STRONG_THRESHOLD.
  /** Raw gift suitability score [0, 1] from ETL normalizer. 0 when absent. */
  readonly gift_suitability_score: number;
  /** Raw beginner suitability score [0, 1] from ETL normalizer. 0 when absent. */
  readonly beginner_suitability_score: number;
  /** 1 if gift suitability ≥ LEARNED_FACET_STRONG_THRESHOLD, 0 otherwise. */
  readonly gift_suitability_strong: number;
  /** 1 if beginner suitability ≥ LEARNED_FACET_STRONG_THRESHOLD, 0 otherwise. */
  readonly beginner_suitability_strong: number;

  // Graph-aware signals (4) — Wave I3.
  // Absent graph → all four are 0 (backward-compatible).
  /**
   * 1 if the candidate matches the hard-tier subgraph's rootSatisfied
   * predicate (AND/OR/XOR semantics applied via `computeGraphCoverage`).
   * 0 when no graph is present or the hard-tier subgraph is unsatisfied.
   */
  readonly graph_root_satisfied: number;
  /**
   * Fraction of hard-tier slot nodes matched by the candidate (under
   * graph node-kind semantics — OR branches with one matched child
   * count as satisfied, XOR with exactly one counts as satisfied,
   * beyond-one counts as unsatisfied). 0..1 ratio.
   */
  readonly graph_hard_tier_coverage: number;
  /**
   * 1 if the graph contains at least one `group_xor` node AND at least
   * one of its children was satisfied by this candidate (i.e. the
   * XOR decision is not a gate fail for this candidate). 0 otherwise.
   *
   * Signals to the LTR model that "candidate respects a user XOR
   * choice" which is semantically distinct from AND hard-match.
   */
  readonly graph_xor_branch_match: number;
  /**
   * Origin tag encoded as ordered integer so LTR can learn from it:
   *   0 = no graph
   *   1 = `deterministic_from_atoms` (Phase 1a trivial projection)
   *   2 = `planner_emitted` (deterministic detector — F1/H)
   *   3 = `hybrid` (LLM-sourced topology — Phase 1b.2)
   *
   * Monotonic so tree-based models can treat it as a simple ordinal;
   * categorical encoders can still split on exact values.
   */
  readonly graph_origin_encoded: number;
}

export interface LTRFeatureExtractionInput {
  readonly query: string;
  readonly normalizedQuery: string;
  readonly candidate: HybridCandidate;
  readonly hardConstraints: readonly NormalizedConstraint[];
  readonly softConstraints: readonly NormalizedConstraint[];
  readonly inferredConstraints?: readonly NormalizedConstraint[];
  readonly degradationFlags: {
    readonly dense: boolean;
    readonly sparse: boolean;
    readonly anchor: boolean;
  };
  readonly entityLinkConfidence?: number;
  /**
   * ADR-010/011 Wave I3: when the compiled query carries a
   * ConstraintGraph, the extractor emits graph-aware features
   * (`graph_root_satisfied`, `graph_hard_tier_coverage`,
   * `graph_xor_branch_match`, `graph_origin_encoded`). Absent →
   * all four features are 0 (backward-compatible). Extracted via
   * the shared `computeGraphCoverage` helper so the 9-class XOR /
   * OR / AND semantics does not drift across LTR + hard gate +
   * provenance closure.
   */
  readonly constraintGraph?: ConstraintGraph | undefined;
}

function safeNumber(value: unknown, fallback = 0): number {
  if (typeof value !== 'number') return fallback;
  return Number.isFinite(value) ? value : fallback;
}

function countSatisfiedConstraints(
  matchedSet: ReadonlySet<string>,
  constraints: readonly NormalizedConstraint[],
): { satisfied: number; total: number } {
  if (constraints.length === 0) return { satisfied: 0, total: 0 };
  let satisfied = 0;
  for (const c of constraints) {
    if (matchedSet.has(c.attribute)) satisfied++;
  }
  return { satisfied, total: constraints.length };
}

function ratio(satisfied: number, total: number): number {
  return total > 0 ? satisfied / total : 0;
}

/**
 * Extract a fixed-shape LTR feature vector from a retrieved candidate.
 * Pure function — no I/O, no clamping, deterministic for the same input.
 */
export function extractLTRFeatures(input: LTRFeatureExtractionInput): LTRFeatureVector {
  const c = input.candidate;
  const q = input.normalizedQuery;
  const qTokens = q.length === 0 ? 0 : q.split(/\s+/u).filter((s) => s.length > 0).length;
  const hasKorean = containsHangul(input.query) ? 1 : 0;

  // Retrieval signals — read directly from HybridCandidate. These fields are
  // all optional on the canonical IR type; `?? 0` collapses absence into "no
  // contribution from this channel", which is the correct LTR semantic for
  // browse/compare candidates that legitimately bypass a channel.
  const bm25 = safeNumber(c.sparseRawScore, 0);
  const dense = safeNumber(c.denseRawScore, 0);
  const anchor = safeNumber(c.anchorRawScore, 0);
  // fusionRrfTotal is the canonical RRF total, set only by FusionService.
  // Browse/Compare candidates bypass fusion → fusionRrfTotal absent → 0.
  const fusion = safeNumber(c.fusionRrfTotal, 0);
  let crossChannel = 0;
  if (c.sparseRank !== undefined) crossChannel++;
  if (c.denseRank !== undefined) crossChannel++;
  if (c.anchorRank !== undefined) crossChannel++;
  if (c.learnedSparseRank !== undefined) crossChannel++;

  // Constraint match signals — precompute matched set once (Rule 16: avoid
  // per-function Set allocation when the same data is reused across calls).
  const matchedSet = new Set(c.matchedConstraints);
  const hardMatch = countSatisfiedConstraints(matchedSet, input.hardConstraints);
  const softMatch = countSatisfiedConstraints(matchedSet, input.softConstraints);
  const inferredMatch = countSatisfiedConstraints(matchedSet, input.inferredConstraints ?? []);
  const violationList = c.unmetHardConstraints ?? [];

  // Entity signals — lowercase query once, reuse across all comparisons
  // (avoids N string allocations per candidate for each .toLowerCase() call)
  const qLower = q.toLowerCase();
  const labelLower = c.canonicalLabel?.toLowerCase();
  const labelMatch = labelLower !== undefined && labelLower.includes(qLower) ? 1 :
    labelLower !== undefined && qLower.includes(labelLower) ? PARTIAL_LABEL_MATCH_SCORE : 0;
  const producerLower = c.producer?.toLowerCase();
  const producerMatch = producerLower !== undefined && qLower.includes(producerLower) ? 1 : 0;
  const regionLower = c.region?.toLowerCase();
  const regionMatch = regionLower !== undefined && qLower.includes(regionLower) ? 1 : 0;

  // Quality signals
  const critic = safeNumber((c as { criticScoreNormalized?: number }).criticScoreNormalized, 0);
  const prestige = safeNumber((c as { producerPrestige?: number }).producerPrestige, 0);
  const popularity = safeNumber((c as { popularityScore?: number }).popularityScore, 0);
  const dwStart = safeNumber(c.drinkingWindowStart, 0);
  const dwEnd = safeNumber(c.drinkingWindowEnd, 0);
  const currentYear = ltrCurrentYear();
  const dwInRange = dwStart > 0 && dwEnd > 0 && currentYear >= dwStart && currentYear <= dwEnd ? 1 : 0;

  // Korean alias match
  const docHasKoreanAlias = c.searchTextKo !== undefined && c.searchTextKo.length > 0;
  const koreanAliasMatch = hasKorean === 1 && docHasKoreanAlias ? 1 : 0;
  const scriptCompat = hasKorean === 1
    ? (docHasKoreanAlias ? 1 : 0)
    : 1;

  // Degradation signals
  const dDense = input.degradationFlags.dense ? 1 : 0;
  const dSparse = input.degradationFlags.sparse ? 1 : 0;
  const dAnchor = input.degradationFlags.anchor ? 1 : 0;

  // Wave I3: graph-aware features. Absent graph → all four = 0.
  const graphFeatures = extractGraphFeatures(matchedSet, input.constraintGraph);

  return {
    bm25_score: bm25,
    dense_score: dense,
    anchor_score: anchor,
    fusion_score: fusion,
    cross_channel_overlap: crossChannel,

    hard_constraint_match_ratio: ratio(hardMatch.satisfied, hardMatch.total),
    soft_constraint_match_ratio: ratio(softMatch.satisfied, softMatch.total),
    inferred_constraint_match_ratio: ratio(inferredMatch.satisfied, inferredMatch.total),
    constraint_violation_count: violationList.length,
    // When zero hard constraints exist, satisfaction is trivially perfect (1.0):
    // there are no constraints to violate. DEFAULT_NEUTRAL_CONFIDENCE (0.5)
    // was incorrect here — it penalized unconstrained queries as if they were
    // 50% unsatisfied. Identified in Phase B audit round 3.
    constraint_satisfaction_confidence: hardMatch.total > 0
      ? hardMatch.satisfied / hardMatch.total
      : 1.0,

    entity_link_confidence: safeNumber(input.entityLinkConfidence, DEFAULT_NEUTRAL_CONFIDENCE),
    canonical_label_match: labelMatch,
    producer_match: producerMatch,
    region_match: regionMatch,

    critic_score_normalized: critic,
    producer_prestige: prestige,
    popularity_score: popularity,
    drinking_window_in_range: dwInRange,

    query_length_tokens: qTokens,
    query_has_korean: hasKorean,
    doc_label_korean_alias_match: koreanAliasMatch,
    query_doc_script_compat: scriptCompat,

    is_dense_degraded: dDense,
    is_sparse_degraded: dSparse,
    is_anchor_degraded: dAnchor,
    degraded_channel_count: dDense + dSparse + dAnchor,

    // Situation facet signals (gift / beginner learned facets)
    gift_suitability_score: c.giftSuitabilityScore ?? 0,
    beginner_suitability_score: c.beginnerSuitabilityScore ?? 0,
    gift_suitability_strong: (c.giftSuitabilityScore ?? 0) >= LEARNED_FACET_STRONG_THRESHOLD ? 1 : 0,
    beginner_suitability_strong: (c.beginnerSuitabilityScore ?? 0) >= LEARNED_FACET_STRONG_THRESHOLD ? 1 : 0,

    graph_root_satisfied: graphFeatures.rootSatisfied,
    graph_hard_tier_coverage: graphFeatures.hardTierCoverage,
    graph_xor_branch_match: graphFeatures.xorBranchMatch,
    graph_origin_encoded: graphFeatures.originEncoded,
  };
}

// ─── Wave I3: graph-aware feature helpers ────────────────────────────────────

interface GraphFeatureBundle {
  readonly rootSatisfied: number;
  readonly hardTierCoverage: number;
  readonly xorBranchMatch: number;
  readonly originEncoded: number;
}

function encodeGraphOrigin(graph: ConstraintGraph): number {
  switch (graph.origin) {
    case 'deterministic_from_atoms': return 1;
    case 'planner_emitted': return 2;
    case 'hybrid': return 3;
  }
}

/**
 * Extract the 4-feature graph bundle. Pure — no IO, no clamping, no
 * per-feature caching; the ranker calls this per-candidate so a tight
 * O(|graph.nodes|) body is all we allow.
 *
 * When `graph === undefined`, every feature is 0 (backward-compatible
 * with pre-I3 consumers and with `CONSTRAINT_GRAPH_EMIT=false` rollback).
 */
function extractGraphFeatures(
  matchedAttributes: ReadonlySet<string>,
  graph: ConstraintGraph | undefined,
): GraphFeatureBundle {
  if (graph === undefined) {
    return {
      rootSatisfied: 0,
      hardTierCoverage: 0,
      xorBranchMatch: 0,
      originEncoded: 0,
    };
  }

  // Hard-tier root-satisfaction + coverage ratio come from the shared
  // `computeGraphCoverage` helper (same one Phase 1b.1 provenance-closure
  // + Phase 1b.3b ranker hard-gate use). Guarantees LTR-gate semantic
  // alignment.
  const hardSubgraph = projectHardTierSubgraph(graph);
  const hardCoverage = computeGraphCoverage(hardSubgraph, matchedAttributes);
  const rootSatisfied = hardCoverage.rootSatisfied ? 1 : 0;
  const hardTierCoverage = hardCoverage.coverageRatio;

  // XOR branch-match: does the candidate satisfy at least one branch of
  // ANY xor group anywhere in the graph? O(|nodes|) scan. Matches only
  // slot children of XOR groups so `group_xor` over nested groups is
  // treated fairly (the recursive coverage result decides satisfaction).
  let xorBranchMatch = 0;
  let sawXor = false;
  for (const node of graph.nodes) {
    if (node.kind !== 'group_xor') continue;
    sawXor = true;
    for (const childId of node.children) {
      const child = graph.nodes.find((n) => n.nodeId === childId);
      if (child === undefined) continue;
      if (child.kind === 'slot' && matchedAttributes.has(child.attribute)) {
        xorBranchMatch = 1;
        break;
      }
    }
    if (xorBranchMatch === 1) break;
  }
  // When there is no XOR group at all, the feature is 0 (not 1) — the
  // signal is "this candidate respects a user XOR choice". Absence of
  // the XOR group is informationally equivalent to "no XOR choice was
  // expressed", so 0 is correct.
  void sawXor;

  return {
    rootSatisfied,
    hardTierCoverage,
    xorBranchMatch,
    originEncoded: encodeGraphOrigin(graph),
  };
}

/** Stable list of LTR feature names — used for parity hashing. */
export const LTR_FEATURE_NAMES: readonly (keyof LTRFeatureVector)[] = [
  'bm25_score',
  'dense_score',
  'anchor_score',
  'fusion_score',
  'cross_channel_overlap',
  'hard_constraint_match_ratio',
  'soft_constraint_match_ratio',
  'inferred_constraint_match_ratio',
  'constraint_violation_count',
  'constraint_satisfaction_confidence',
  'entity_link_confidence',
  'canonical_label_match',
  'producer_match',
  'region_match',
  'critic_score_normalized',
  'producer_prestige',
  'popularity_score',
  'drinking_window_in_range',
  'query_length_tokens',
  'query_has_korean',
  'doc_label_korean_alias_match',
  'query_doc_script_compat',
  'is_dense_degraded',
  'is_sparse_degraded',
  'is_anchor_degraded',
  'degraded_channel_count',
  'gift_suitability_score',
  'beginner_suitability_score',
  'gift_suitability_strong',
  'beginner_suitability_strong',
  'graph_root_satisfied',
  'graph_hard_tier_coverage',
  'graph_xor_branch_match',
  'graph_origin_encoded',
] as const;

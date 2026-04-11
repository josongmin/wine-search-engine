/**
 * RFC-013 S3 -- Calibrated entropy abstain.
 * Computes normalized Shannon entropy over top-K retrieval scores.
 * If entropy exceeds threshold, the engine abstains and requests clarification.
 */

import type {
  TypedAbstainDecision,
  AbstainReason,
  ChannelDegradationSummary,
  StructuredClarifyPayload,
} from '../model/abstain-decision.js';

/** Decimal places for entropy values in trace strings and detail messages. */
const ENTROPY_TRACE_DECIMAL_PLACES = 4;
import type { ConstraintRelation } from './constraint-reasoner.js';
import type { ConstraintAtom } from '../../shared/types/constraint-atom.js';

/** Attribute names that represent price constraints (extrinsic/budget). */
const PRICE_ATTRIBUTES = new Set(['price', 'priceMin', 'priceMax', 'price_min', 'price_max']);

/** Attribute names that represent quality/critic-score constraints. */
const QUALITY_ATTRIBUTES = new Set(['criticScore', 'critic_score', 'rating', 'score', 'points']);

export type AbstainDecision =
  | { readonly abstain: false; readonly entropy?: number; readonly reason?: string }
  | { readonly abstain: true; readonly entropy: number };

/** Context passed to shouldAbstain to influence gate behaviour. */
export interface AbstainContext {
  /**
   * Whether an LTR model is currently active for scoring.
   *
   * RCA-01: The entropy gate is designed for LTR logit scores which have
   * wide spread (~5-10 range). Heuristic linear scores are clamped to [0,1]
   * and cluster tightly in [0.2, 0.6], producing entropy ≈ 0.999 regardless
   * of threshold. Setting ltrAvailable=false bypasses the gate entirely,
   * reducing ambiguous rate from 83% → <20% in heuristic-only environments.
   */
  readonly ltrAvailable: boolean;
}

export class AbstainPolicy {
  constructor(
    /** Normalized Shannon entropy threshold above which retrieval scores are
     *  considered indistinguishable (engine should abstain and request
     *  clarification). 0.95 = "top-K scores are ~95% as uniform as a perfectly
     *  flat distribution". Raised from 0.82 (RCA5-01: the 0.82 threshold was
     *  mathematically impossible to clear without LTR/reranker — default score
     *  spread of 0.15-0.25 across top-10 produces entropy ~0.87, so 83% of
     *  queries abstained. 0.95 requires near-completely-flat score distribution
     *  before abstaining). Calibrated on 200-query gold set (RFC-013 §3):
     *  precision@3 drops below 0.5 above this cutoff. */
    private readonly entropyThreshold: number = 0.95,
    /** Minimum candidates required before entropy is meaningful. With <3
     *  candidates entropy is dominated by sampling noise, not true ambiguity. */
    private readonly minCandidates: number = 3,
  ) {}

  shouldAbstain(scores: readonly number[], context?: AbstainContext): AbstainDecision {
    // RCA-01: heuristic scores always produce entropy > 0.95 regardless of
    // threshold. Bypass the gate entirely when LTR is not available so the
    // engine can return results instead of abstaining 83% of the time.
    if (context?.ltrAvailable === false) {
      return { abstain: false, reason: 'ltr_unavailable_entropy_bypass' };
    }

    if (scores.length < this.minCandidates) {
      return { abstain: false };
    }
    const entropy = this.normalizedEntropy(scores);
    if (entropy >= this.entropyThreshold) {
      return { abstain: true, entropy };
    }
    return { abstain: false, entropy };
  }

  /**
   * E6: Typed evaluate() — returns a structured TypedAbstainDecision when the
   * engine should abstain, or `false` when results can be returned.
   *
   * Decision priority (evaluated in order):
   *  1. `no_match`             — candidateCount === 0
   *  2. `semantic_conflict`    — soft_tension or contradiction in constraintRelations
   *  3. `insufficient_evidence`— dense + anchor both degraded
   *  4. `low_confidence`       — entropy gate fires (requires ltrAvailable)
   *
   * ClarifyPayload split responsibility (intentional design):
   *  - `budget_gap`            — built HERE (no_match + price + quality constraints)
   *  - `preference_gap`        — built HERE (low_confidence + any constraints)
   *  - `constraint_conflict`   — built in search-usecase-execute-builders.ts
   *                              (semantic_conflict path; requires top-K labels from ranked results)
   *  - `anchor_disambiguation` — built in search-usecase-execute-builders.ts
   *                              (low_confidence path; requires anchor surface forms from resolver)
   *
   * The constraint_conflict and anchor_disambiguation kinds require application-layer
   * data (ranked result labels, resolver anchor info) not available at domain-policy
   * evaluation time. They are therefore delegated to the execute-builders layer which
   * has access to the full pipeline context. AbstainPolicy only builds payloads from
   * data it directly receives (atoms, relations, scores).
   */
  evaluate(
    topKScores: readonly number[],
    constraintRelations: readonly ConstraintRelation[],
    channelDegradation: ChannelDegradationSummary,
    context?: AbstainContext,
    constraintAtoms?: readonly ConstraintAtom[],
  ): TypedAbstainDecision | false {
    // Priority 1: no candidates at all
    if (topKScores.length === 0) {
      const noMatchClarify = buildNoMatchClarifyPayload(constraintAtoms ?? []);
      return {
        shouldAbstain: true,
        reason: 'no_match',
        detail: 'Hard constraint filter produced zero candidates.',
        recoverableBy: 'relax_constraints',
        ...(noMatchClarify !== undefined && { clarifyPayload: noMatchClarify }),
      };
    }

    // Priority 2: semantic conflict from EPIC-2 ConstraintReasoner
    const conflictRelations = constraintRelations.filter(
      (r) => r.type === 'soft_tension' || r.type === 'contradiction',
    );
    if (conflictRelations.length > 0) {
      return {
        shouldAbstain: true,
        reason: 'semantic_conflict',
        detail: `${conflictRelations.length} constraint relation(s) detected: ${conflictRelations.map((r) => r.type).join(', ')}.`,
        recoverableBy: 'clarify',
        conflictingRelations: conflictRelations,
      };
    }

    // Priority 3: both dense and anchor channels degraded — sparse-only result
    if (channelDegradation.denseDegraded && channelDegradation.anchorDegraded) {
      return {
        shouldAbstain: true,
        reason: 'insufficient_evidence',
        detail: 'Dense and anchor retrieval channels are both degraded; sparse-only results are insufficient for confident ranking.',
        recoverableBy: 'retry_with_dense',
      };
    }

    // Priority 4: entropy gate (low_confidence)
    const entropyDecision = this.shouldAbstain(topKScores, context);
    if (entropyDecision.abstain) {
      const entropyVal = entropyDecision.entropy;
      const lowConfClarify = buildLowConfidenceClarifyPayload(constraintAtoms ?? []);
      return {
        shouldAbstain: true,
        reason: 'low_confidence' as AbstainReason,
        detail: `Top-K score distribution is near-uniform (entropy=${entropyVal.toFixed(ENTROPY_TRACE_DECIMAL_PLACES)}). Cannot confidently rank results.`,
        recoverableBy: 'clarify',
        entropy: entropyVal,
        ...(lowConfClarify !== undefined && { clarifyPayload: lowConfClarify }),
      };
    }

    return false;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────
  private normalizedEntropy(scores: readonly number[]): number {
    // Early guard: empty or single-element distributions have entropy 0 by
    // definition. Without this, intermediate steps below produce NaN
    // (e/sumExp where sumExp=0) that propagates silently. (Bugbash R17)
    if (scores.length < 2) return 0;
    // Filter out non-finite inputs before computing softmax. NaN or ±Infinity
    // scores come from upstream pipeline defects (failed LTR inference, RRF
    // overflow). Including them produces NaN entropy that silently bypasses the
    // gate — filtering is the correct defensive response.
    const finiteScores = scores.filter((s) => Number.isFinite(s));
    if (finiteScores.length < 2) return 0;
    let maxScore = -Infinity;
    for (const s of finiteScores) { if (s > maxScore) maxScore = s; }
    const expScores = finiteScores.map((s) => {
      const e = Math.exp(s - maxScore);
      // Guard: underflow (e === 0) is fine for softmax; NaN is not. NaN can
      // appear if maxScore is Infinity (all scores equal +Inf) — return 0 so
      // the contribution is simply excluded from the sum.
      return Number.isFinite(e) ? e : 0;
    });
    const sumExp = expScores.reduce((a, b) => a + b, 0);
    if (sumExp === 0) return 0;
    const probs = expScores.map((e) => e / sumExp);
    const rawEntropy = probs.reduce((h, p) => (p <= 0 ? h : h - p * Math.log2(p)), 0);
    const maxEntropy = Math.log2(finiteScores.length);
    return maxEntropy > 0 ? rawEntropy / maxEntropy : 0;
  }
}

// ─── Module-scope helpers for ClarifyPayload construction ────────────────────

/**
 * Returns true if any atom in the list represents a price constraint.
 */
function hasPriceConstraint(atoms: readonly ConstraintAtom[]): boolean {
  for (const atom of atoms) {
    if (PRICE_ATTRIBUTES.has(atom.attribute)) return true;
  }
  return false;
}

/**
 * Returns true if any atom in the list represents a quality/critic-score constraint.
 */
function hasQualityConstraint(atoms: readonly ConstraintAtom[]): boolean {
  for (const atom of atoms) {
    if (QUALITY_ATTRIBUTES.has(atom.attribute)) return true;
  }
  return false;
}

/**
 * Returns true if the atom list contains any constraint at all (hard, soft, or inferred).
 */
function hasAnyConstraint(atoms: readonly ConstraintAtom[]): boolean {
  return atoms.length > 0;
}

/**
 * Build a `budget_gap` StructuredClarifyPayload for `no_match` abstains where
 * the query has both price AND quality constraints that cannot be jointly satisfied.
 * Returns undefined if the condition does not apply.
 */
function buildNoMatchClarifyPayload(
  atoms: readonly ConstraintAtom[],
): StructuredClarifyPayload | undefined {
  if (!hasPriceConstraint(atoms) || !hasQualityConstraint(atoms)) return undefined;
  return {
    kind: 'budget_gap',
    question:
      'No wines match your combined price and quality requirements. Would you like to adjust your budget or lower the minimum score?',
    options: ['Relax price range', 'Lower minimum score', 'Try both'],
    gapDescription:
      'The price constraint and quality/score constraint cannot be jointly satisfied by available wines.',
  };
}

/**
 * Build a `preference_gap` StructuredClarifyPayload for `low_confidence` abstains
 * where constraints are present but result quality is too low to rank confidently.
 * Returns undefined if no constraints are present (unconstrained query should not
 * request preference clarification).
 */
function buildLowConfidenceClarifyPayload(
  atoms: readonly ConstraintAtom[],
): StructuredClarifyPayload | undefined {
  if (!hasAnyConstraint(atoms)) return undefined;
  return {
    kind: 'preference_gap',
    question:
      'I found wines matching your criteria but cannot confidently rank them. Could you share more about your taste preferences to help narrow it down?',
  };
}

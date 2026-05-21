/**
 * RFC-019 Stage 6: Retrieval Plan Builder
 *
 * Converts a ConstraintBundle into a structured RetrievalPlan with three
 * distinct tiers:
 *
 *   1. HARD filter tokens (Vespa YQL WHERE clauses) — gating
 *   2. SOFT boost tokens (post-retrieval ranking features) — scoring
 *   3. INFERRED expansion tokens (ranking features + sensory priors) — priors
 *
 * The existing pipeline conflates soft and inferred: both flow to
 * `computeSoftConstraint()` with inferred at INFERRED_CONSTRAINT_WEIGHT_MULTIPLIER
 * (currently 0.7x) weight. This module separates
 * them structurally so the ranker can weight them independently and so the
 * downstream RFC-018 drinking window predictor can consume inferred sensory
 * priors as fallbacks for missing index values.
 *
 * Design contract (RFC-019 §6.6):
 *   - Hard filters are UNCHANGED (same tokens as hardConstraintsToSparseFilterTokens)
 *   - Soft boosts are a new STRUCTURED list — not flat YQL, stay in memory
 *   - Inferred expansions are SEPARATED from soft and can include sensory
 *     priors (tannin/body/acidity/sweetness) for Phase 7 integration
 */

import type { ConstraintBundle, NormalizedConstraint } from '../../shared/types/index.js';
import { SENSORY_PRIOR_ATTRIBUTES } from '../../shared/constants/constraint-attributes.js';
import { hardConstraintsToSparseFilterTokens } from './constraint-to-sparse-filter-tokens.js';

/** A scoring boost/expansion signal derived from a constraint. */
export interface BoostSignal {
  /** The attribute name (e.g. 'grape_family', 'tannin'). */
  readonly attribute: string;
  /** The target value for matching. */
  readonly value: NormalizedConstraint['value'];
  /** Operator for matching (e.g. '=', 'in', '>='). */
  readonly operator: NormalizedConstraint['operator'];
  /** Score contribution weight in [0,1]. Higher = stronger boost. */
  readonly weight: number;
  /** Provenance (source constraint's mapping_version). */
  readonly source: string;
}

/** Inferred sensory prior — fallback for missing index values (RFC-018 integration). */
export interface SensoryPrior {
  readonly attribute: 'body' | 'tannin' | 'acidity' | 'sweetness';
  /** Target value on normalized [0,1] scale. */
  readonly value: number;
  /** Confidence of the prior (originating constraint's confidence). */
  readonly confidence: number;
  /** Source — which composition rule or ontology edge produced this. */
  readonly source: string;
}

/** Structured retrieval plan — three tiers. */
export interface RetrievalPlan {
  /** Hard YQL filter tokens — gating. */
  readonly hardFilterTokens: readonly string[];
  /** Soft boost signals — applied post-retrieval by ranker. */
  readonly softBoosts: readonly BoostSignal[];
  /** Inferred expansion boosts — independent weight from soft. */
  readonly inferredBoosts: readonly BoostSignal[];
  /** Sensory priors for RFC-018 fallback (body/tannin/acidity/sweetness). */
  readonly sensoryPriors: readonly SensoryPrior[];
  /** Plan version for replay parity. */
  readonly planVersion: string;
}

const PLAN_VERSION = 'retrieval-plan-v1.0';

/**
 * Inferred constraints are weaker than explicit soft constraints by design.
 * Their boost weight is the originating confidence scaled by this factor.
 *
 * EXPORTED so tests assert against the SOURCE value (not a test-local copy) —
 * a divergent test constant would let a silent weight regression pass.
 * Must be in (0,1]: 0 would erase inferred signal entirely; >1 would make
 * inferred boosts *stronger* than soft, inverting the tier semantics.
 */
export const INFERRED_CONSTRAINT_WEIGHT_MULTIPLIER = 0.7;

/**
 * Upper bound on the number of boost signals emitted per tier (soft / inferred).
 *
 * A retrieval plan is a bounded artifact: the ranker applies every boost as a
 * weighted-sum term per candidate, so an unbounded boost list is both a
 * latency hazard (O(candidates × boosts)) and an audit hazard (an adversarial
 * or buggy upstream could emit thousands of constraints). The cap is generous
 * relative to the largest legitimate constraint bundle observed (≤ ~20 atoms
 * across hard/soft/inferred) so it never clips real intent, while bounding the
 * worst case. Excess boosts are dropped DETERMINISTICALLY — highest weight
 * first, then by stable comparator — so the strongest signals always survive.
 */
export const MAX_BOOSTS_PER_TIER = 64;

/**
 * Lower/upper bounds for any boost weight emitted in a plan. The {@link BoostSignal}
 * contract documents `weight ∈ [0,1]`; upstream `confidence` is NOT guaranteed
 * to be finite or in-range (LLM-sourced constraints can emit 1.5, NaN, -0.2).
 * Every weight is clamped to [WEIGHT_MIN, WEIGHT_MAX] so the documented
 * invariant actually holds and downstream weighted sums never see NaN/∞.
 */
export const BOOST_WEIGHT_MIN = 0;
export const BOOST_WEIGHT_MAX = 1;

const UNKNOWN_SOURCE = 'unknown';

/**
 * NFC-normalize a string-bearing constraint value so Korean (한글) and accented
 * Latin values are byte-identical regardless of upstream composition form.
 *
 * "까베르네" can arrive NFC-composed or NFD-decomposed depending on the OS/IME
 * that produced the query; the two are visually identical but compare unequal
 * and hash differently. Without normalization the SAME query can yield two
 * distinct plans (determinism break) and split a soft boost into two terms
 * downstream. Numbers, ranges, and arrays are normalized element-wise.
 *
 * Returns a value of the SAME union member kind as the input (string→string,
 * array→array, …) so the BoostSignal value contract is preserved.
 */
function normalizeConstraintValue(
  value: NormalizedConstraint['value'],
): NormalizedConstraint['value'] {
  if (typeof value === 'string') {
    return value.normalize('NFC');
  }
  if (Array.isArray(value)) {
    // The only array member of the union is ReadonlyArray<string>; Array.isArray
    // widens to any[], so narrow the element type explicitly before mapping.
    const entries = value as ReadonlyArray<string>;
    return entries.map((entry) => entry.normalize('NFC'));
  }
  // number | { min, max } — no string content, returned unchanged.
  return value;
}

/**
 * Clamp a raw confidence into the documented BoostSignal weight range.
 *
 * NaN/±Infinity → BOOST_WEIGHT_MIN. We do NOT route through the shared
 * `clamp01` here on purpose: `clamp01` emits a one-shot "upstream bug" process
 * warning on non-finite input, but an out-of-range LLM confidence (e.g. 1.5)
 * is an EXPECTED input at this boundary, not a bug — clamping it is the
 * designed behavior, so it must stay quiet. Bounds reference the exported
 * invariant constants so the range stays in lockstep with the contract.
 */
function toBoostWeight(confidence: number): number {
  if (!Number.isFinite(confidence)) return BOOST_WEIGHT_MIN;
  if (confidence < BOOST_WEIGHT_MIN) return BOOST_WEIGHT_MIN;
  if (confidence > BOOST_WEIGHT_MAX) return BOOST_WEIGHT_MAX;
  return confidence;
}

/**
 * Stable, value-based comparator for boost signals. Produces a total order
 * that depends ONLY on signal content (not input position), so reordering the
 * input constraint array yields a byte-identical plan (order-independence
 * invariant). Ordering: descending weight (strongest signal first), then
 * ascending attribute, operator, source, and serialized value as tie-breakers.
 */
function compareBoostSignals(a: BoostSignal, b: BoostSignal): number {
  if (a.weight !== b.weight) return b.weight - a.weight; // desc weight
  if (a.attribute !== b.attribute) return a.attribute < b.attribute ? -1 : 1;
  if (a.operator !== b.operator) return a.operator < b.operator ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  const av = JSON.stringify(a.value);
  const bv = JSON.stringify(b.value);
  if (av !== bv) return av < bv ? -1 : 1;
  return 0;
}

/**
 * Build a structured retrieval plan from a constraint bundle.
 *
 * Hard constraints → existing filter tokens (unchanged path).
 * Soft constraints → boost signals with weight = clamped confidence.
 * Inferred constraints → boost signals (weight × multiplier) AND sensory
 * priors (when the attribute is numeric-sensory).
 *
 * Determinism / SOTA invariants enforced here:
 *  - **Order-independence**: boosts are sorted by a content-only comparator,
 *    so permuting the input arrays never changes the output.
 *  - **Bounded fan-out**: each tier is capped at {@link MAX_BOOSTS_PER_TIER},
 *    dropping the WEAKEST signals first (deterministic).
 *  - **Weight invariant**: every weight is clamped to [0,1] — NaN/∞/out-of-range
 *    confidences can never leak into downstream weighted sums.
 *  - **NFC preservation**: Korean/accented string values are NFC-normalized so
 *    the same logical query always produces the same plan.
 */
export function buildRetrievalPlan(bundle: ConstraintBundle): RetrievalPlan {
  const hardFilterTokens = [...hardConstraintsToSparseFilterTokens(bundle.hard)];

  const softBoosts: BoostSignal[] = bundle.soft.map((c) => ({
    attribute: c.attribute,
    value: normalizeConstraintValue(c.value),
    operator: c.operator,
    weight: toBoostWeight(c.confidence),
    source: c.mapping_version ?? UNKNOWN_SOURCE,
  }));

  const inferredBoosts: BoostSignal[] = [];
  const sensoryPriors: SensoryPrior[] = [];

  for (const c of bundle.inferred) {
    // Sensory attributes with a finite numeric value → also produce SensoryPrior.
    // Number.isFinite guards against NaN/∞ priors leaking into RFC-018 fallback,
    // which would poison the drinking-window predictor with non-finite floors.
    if (
      SENSORY_PRIOR_ATTRIBUTES.has(c.attribute)
      && typeof c.value === 'number'
      && Number.isFinite(c.value)
    ) {
      sensoryPriors.push({
        attribute: c.attribute as SensoryPrior['attribute'],
        value: c.value,
        confidence: toBoostWeight(c.confidence),
        source: c.mapping_version ?? UNKNOWN_SOURCE,
      });
    }
    // All inferred constraints contribute a boost (same boost semantics).
    inferredBoosts.push({
      attribute: c.attribute,
      value: normalizeConstraintValue(c.value),
      operator: c.operator,
      // Inferred is weaker than soft by design — scale by the multiplier, then
      // clamp. Clamping the PRODUCT (not just the input) keeps the [0,1]
      // invariant even when confidence is itself out of range.
      weight: toBoostWeight(c.confidence * INFERRED_CONSTRAINT_WEIGHT_MULTIPLIER),
      source: c.mapping_version ?? UNKNOWN_SOURCE,
    });
  }

  // Deterministic order + bounded fan-out. Sort by content-only comparator,
  // then keep the strongest MAX_BOOSTS_PER_TIER (sort is desc-weight, so slice
  // from the front retains the strongest signals).
  softBoosts.sort(compareBoostSignals);
  inferredBoosts.sort(compareBoostSignals);
  sensoryPriors.sort(compareSensoryPriors);

  return {
    hardFilterTokens,
    softBoosts: softBoosts.slice(0, MAX_BOOSTS_PER_TIER),
    inferredBoosts: inferredBoosts.slice(0, MAX_BOOSTS_PER_TIER),
    sensoryPriors,
    planVersion: PLAN_VERSION,
  };
}

/**
 * Stable, content-only comparator for sensory priors. First-writer-wins
 * semantics in {@link extractSensoryPriorsFromRetrievalPlan} require a
 * deterministic order so the same bundle always resolves the same prior per
 * attribute. Order: ascending attribute, then descending confidence, then value.
 */
function compareSensoryPriors(a: SensoryPrior, b: SensoryPrior): number {
  if (a.attribute !== b.attribute) return a.attribute < b.attribute ? -1 : 1;
  if (a.confidence !== b.confidence) return b.confidence - a.confidence; // desc
  if (a.value !== b.value) return a.value - b.value;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return 0;
}

/** Plan version constant (for trace). */
export function retrievalPlanVersion(): string {
  return PLAN_VERSION;
}

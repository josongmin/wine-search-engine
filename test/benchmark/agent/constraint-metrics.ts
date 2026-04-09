/**
 * RFC-020: Constraint Extraction Measurement Metrics
 *
 * Implements the 3 SOTA KPIs from §4.1:
 *   P1. Semantic Constraint Recall (SCR) — Amazon e-commerce 2024
 *   P2. Entity Linking Accuracy (ELA@1) — TAC KBP
 *   P3. Slot F1 (entity-level, SemEval-2013 scheme)
 *
 * All metrics return `null` when ground truth is missing so the scorer can
 * drop them from the geometric mean (no penalty for unmeasurable scenarios).
 */

import type { ConstraintBundle, NormalizedConstraint } from '../../../src/domain/shared/types/index.js';
import type { ExpectedConstraint, ExpectedEntity } from './scenario.js';
import { resolveEntity } from '../../../src/domain/attribute/service/entity-resolver.js';

// ─────────────────────────────────────────────────────────────────────────
// Constraint matching primitive
// ─────────────────────────────────────────────────────────────────────────

/**
 * Normalized equality check: matches industry practice (case-insensitive +
 * NFKC fold + whitespace trim). Used by both SCR and Slot F1.
 */
function stringMatches(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.trim().normalize('NFKC').toLowerCase() === b.trim().normalize('NFKC').toLowerCase();
}

/**
 * Range overlap check: two numeric ranges overlap iff max(a.min, b.min) ≤
 * min(a.max, b.max). Used for price/vintage range matching.
 */
function rangesOverlap(a: { min?: number; max?: number }, b: { min?: number; max?: number }): boolean {
  const aMin = a.min ?? -Infinity;
  const aMax = a.max ?? Infinity;
  const bMin = b.min ?? -Infinity;
  const bMax = b.max ?? Infinity;
  return Math.max(aMin, bMin) <= Math.min(aMax, bMax);
}

/**
 * Does `actual` match `expected` under strict semantic equality?
 *
 * - Attribute must match exactly.
 * - Operator: strict mode requires exact match; relaxed mode allows
 *   cross-operator matches like extracted `range [30k, 50k]` matching
 *   expected `≤ 50k`.
 * - Value: string equality via NFKC fold, number equality with 0.1%
 *   tolerance, range overlap for numeric ranges, subset inclusion for arrays.
 */
export type MatchMode = 'strict' | 'relaxed' | 'type_only';

export function constraintMatches(
  actual: NormalizedConstraint,
  expected: ExpectedConstraint,
  mode: MatchMode,
): boolean {
  if (actual.attribute !== expected.attribute) return false;
  if (mode === 'type_only') return true;

  // Operator compatibility
  if (mode === 'strict' && actual.operator !== expected.operator) return false;
  if (mode === 'relaxed') {
    // Allow >= / <= to match range if the single-bound operator lies within the range
    const compatible =
      actual.operator === expected.operator ||
      (actual.operator === 'range' && (expected.operator === '<=' || expected.operator === '>=')) ||
      (expected.operator === 'range' && (actual.operator === '<=' || actual.operator === '>='));
    if (!compatible) return false;
  }

  // Value matching
  const a = actual.value;
  const e = expected.value;

  // String vs string
  if (typeof a === 'string' && typeof e === 'string') return stringMatches(a, e);

  // Number vs number (with tolerance)
  if (typeof a === 'number' && typeof e === 'number') {
    const TOLERANCE_MULTIPLIER = 0.001;
    const MIN_TOLERANCE = 0.001;
    const tolerance = Math.max(Math.abs(e) * TOLERANCE_MULTIPLIER, MIN_TOLERANCE);
    return Math.abs(a - e) < tolerance;
  }

  // Range vs range
  if (
    typeof a === 'object' && a !== null && 'min' in a && 'max' in a &&
    typeof e === 'object' && e !== null && 'min' in e && 'max' in e
  ) {
    return rangesOverlap(a as { min: number; max: number }, e as { min?: number; max?: number });
  }

  // Range vs number (single-bound operator like >= 2018 matching range [2018, 2020])
  if (
    typeof a === 'object' && a !== null && 'min' in a && 'max' in a &&
    typeof e === 'number'
  ) {
    const aRange = a as { min: number; max: number };
    return e >= aRange.min && e <= aRange.max;
  }
  if (
    typeof a === 'number' &&
    typeof e === 'object' && e !== null && 'min' in e && 'max' in e
  ) {
    const eRange = e as { min?: number; max?: number };
    const aMin = eRange.min ?? -Infinity;
    const aMax = eRange.max ?? Infinity;
    return a >= aMin && a <= aMax;
  }

  // Array vs array (subset inclusion)
  if (Array.isArray(a) && Array.isArray(e)) {
    const aSet = new Set(a.map((v) => (typeof v === 'string' ? v.normalize('NFKC').toLowerCase() : v)));
    for (const ev of e) {
      const normalized = typeof ev === 'string' ? ev.normalize('NFKC').toLowerCase() : ev;
      if (!aSet.has(normalized)) return false;
    }
    return true;
  }

  // Array vs single string (string ∈ array)
  if (Array.isArray(a) && typeof e === 'string') {
    return a.some((v) => typeof v === 'string' && stringMatches(v, e));
  }
  if (typeof a === 'string' && Array.isArray(e)) {
    return e.some((v) => typeof v === 'string' && stringMatches(a, v));
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// P1: Semantic Constraint Recall (SCR)
// ─────────────────────────────────────────────────────────────────────────

export interface ConstraintRecallScore {
  /** hard bucket recall [0,1] or null if no expected hard constraints. */
  readonly scrHard: number | null;
  /** soft bucket recall [0,1] or null. */
  readonly scrSoft: number | null;
  /** inferred bucket recall [0,1] or null. */
  readonly scrInferred: number | null;
  /** Weighted overall SCR (hard=0.6, soft=0.2, inferred=0.2) or null if no buckets measurable. */
  readonly scrOverall: number | null;
  /** Diagnostic: which expected constraints were MISSED (for debugging). */
  readonly missedConstraints: readonly ExpectedConstraint[];
}

/**
 * Compute Semantic Constraint Recall bucket-wise.
 *
 * Each bucket is measured independently — missing-bucket expectations yield
 * `null` for that bucket (not a 0 penalty). This lets scenarios opt into
 * measuring just hard (common) without penalizing them for unspecified
 * inferred constraints.
 */
export function scoreSemanticConstraintRecall(
  extracted: ConstraintBundle,
  expected: {
    readonly hard?: readonly ExpectedConstraint[];
    readonly soft?: readonly ExpectedConstraint[];
    readonly inferred?: readonly ExpectedConstraint[];
  },
  mode: MatchMode = 'relaxed',
): ConstraintRecallScore {
  const missed: ExpectedConstraint[] = [];

  const bucketScore = (
    actual: readonly NormalizedConstraint[],
    expectedBucket: readonly ExpectedConstraint[] | undefined,
  ): number | null => {
    if (expectedBucket === undefined || expectedBucket.length === 0) return null;
    let hits = 0;
    for (const e of expectedBucket) {
      const found = actual.some((a) => constraintMatches(a, e, mode));
      if (found) hits++;
      else missed.push(e);
    }
    return hits / expectedBucket.length;
  };

  const scrHard = bucketScore(extracted.hard, expected.hard);
  const scrSoft = bucketScore(extracted.soft, expected.soft);
  const scrInferred = bucketScore(extracted.inferred, expected.inferred);

  // Weighted overall — hard is most important for retrieval correctness
  const weights = { hard: 0.6, soft: 0.2, inferred: 0.2 };
  let weightedSum = 0;
  let totalWeight = 0;
  if (scrHard !== null) { weightedSum += scrHard * weights.hard; totalWeight += weights.hard; }
  if (scrSoft !== null) { weightedSum += scrSoft * weights.soft; totalWeight += weights.soft; }
  if (scrInferred !== null) { weightedSum += scrInferred * weights.inferred; totalWeight += weights.inferred; }

  const scrOverall = totalWeight > 0 ? weightedSum / totalWeight : null;

  return {
    scrHard,
    scrSoft,
    scrInferred,
    scrOverall,
    missedConstraints: missed,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// P2: Entity Linking Accuracy (ELA@1)
// ─────────────────────────────────────────────────────────────────────────

export interface EntityLinkingScore {
  /** Precision = correctly linked / total linked. */
  readonly precision: number | null;
  /** Recall = correctly linked / total expected. */
  readonly recall: number | null;
  /** F1 score (harmonic mean of precision and recall). */
  readonly f1: number | null;
  /** Micro accuracy @ 1 = fraction of expected entities correctly linked. */
  readonly ela1: number | null;
  /** Diagnostic: entities that failed to link correctly. */
  readonly linkErrors: readonly { expected: ExpectedEntity; actualCanonical: string | null }[];
}

/**
 * Compute Entity Linking Accuracy (TAC KBP-style).
 *
 * For each expected entity, resolve the `surface` through the Entity Resolver
 * and check if the resolved canonical + type match the expected values.
 * Returns precision/recall/F1 and ELA@1.
 */
export function scoreEntityLinkingAccuracy(
  expected: readonly ExpectedEntity[] | undefined,
): EntityLinkingScore {
  if (expected === undefined || expected.length === 0) {
    return {
      precision: null,
      recall: null,
      f1: null,
      ela1: null,
      linkErrors: [],
    };
  }

  let correct = 0;
  let linked = 0;
  const errors: { expected: ExpectedEntity; actualCanonical: string | null }[] = [];

  for (const exp of expected) {
    const resolved = resolveEntity(exp.surface.toLowerCase().normalize('NFKC'));
    if (resolved === null) {
      errors.push({ expected: exp, actualCanonical: null });
      continue;
    }
    linked++;
    const canonicalMatch = stringMatches(resolved.canonicalValue, exp.canonical);
    const typeMatch = resolved.entityType === exp.type;
    if (canonicalMatch && typeMatch) {
      correct++;
    } else {
      errors.push({ expected: exp, actualCanonical: resolved.canonicalValue });
    }
  }

  const precision = linked > 0 ? correct / linked : 0;
  const recall = correct / expected.length;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const ela1 = recall;

  return {
    precision,
    recall,
    f1,
    ela1,
    linkErrors: errors,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// P3: Slot F1 (entity-level, SemEval-2013)
// ─────────────────────────────────────────────────────────────────────────

export interface SlotF1Score {
  /** Strict F1 — attribute + operator + value exact match. */
  readonly strict: number | null;
  /** Relaxed F1 — operator can flex (>= matches range, etc.). */
  readonly relaxed: number | null;
  /** Type-only F1 — attribute match alone (ignores value). */
  readonly typeOnly: number | null;
}

/**
 * Compute Slot F1 scores across all three match modes.
 *
 * Flattens hard+soft+inferred to a single slot list (matches SemEval scheme
 * which doesn't distinguish constraint types — treats them as entity slots).
 */
export function scoreSlotF1(
  extracted: ConstraintBundle,
  expected: {
    readonly hard?: readonly ExpectedConstraint[];
    readonly soft?: readonly ExpectedConstraint[];
    readonly inferred?: readonly ExpectedConstraint[];
  },
): SlotF1Score {
  const allExpected = [
    ...(expected.hard ?? []),
    ...(expected.soft ?? []),
    ...(expected.inferred ?? []),
  ];
  if (allExpected.length === 0) {
    return { strict: null, relaxed: null, typeOnly: null };
  }
  const allActual = [...extracted.hard, ...extracted.soft, ...extracted.inferred];

  const computeF1 = (mode: MatchMode): number => {
    let tp = 0;
    const matchedExpected = new Set<number>();
    const matchedActual = new Set<number>();

    for (let ai = 0; ai < allActual.length; ai++) {
      for (let ei = 0; ei < allExpected.length; ei++) {
        if (matchedExpected.has(ei) || matchedActual.has(ai)) continue;
        if (constraintMatches(allActual[ai]!, allExpected[ei]!, mode)) {
          tp++;
          matchedExpected.add(ei);
          matchedActual.add(ai);
          break;
        }
      }
    }

    const fp = allActual.length - tp;
    const fn = allExpected.length - tp;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  };

  return {
    strict: computeF1('strict'),
    relaxed: computeF1('relaxed'),
    typeOnly: computeF1('type_only'),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// P4: Constraint Satisfaction Rate (CSR)
// ─────────────────────────────────────────────────────────────────────────

export interface ConstraintSatisfactionScore {
  readonly csrHard: number | null;
  readonly csrSoft: number | null;
  readonly csrInferred: number | null;
  readonly csrOverall: number | null;
}

/** SCR-aligned tier weights for CSR overall computation. */
const CSR_WEIGHT_HARD = 0.6;
const CSR_WEIGHT_SOFT = 0.2;
const CSR_WEIGHT_INFERRED = 0.2;

/**
 * Check whether a single constraint is evidenced by any observation text.
 *
 * - String value → case-insensitive NFKC containment in observation.
 * - Number value → string representation appears in observation.
 * - Range value → check if any number token in the observation falls within [min, max].
 * - Array value → every element must be evidenced.
 */
function constraintEvidenced(constraint: NormalizedConstraint, observations: readonly string[]): boolean {
  const haystack = observations.map((o) => o.normalize('NFKC').toLowerCase()).join('\n');
  const val = constraint.value;

  if (typeof val === 'string') {
    return haystack.includes(val.normalize('NFKC').toLowerCase());
  }

  if (typeof val === 'number') {
    // Check both integer and decimal representations
    return haystack.includes(String(val));
  }

  if (Array.isArray(val)) {
    return val.every((item) => {
      if (typeof item === 'string') {
        return haystack.includes(item.normalize('NFKC').toLowerCase());
      }
      if (typeof item === 'number') {
        return haystack.includes(String(item));
      }
      return false;
    });
  }

  // Range object — check if any numeric token in observations falls within [min, max]
  if (typeof val === 'object' && val !== null && ('min' in val || 'max' in val)) {
    const rangeObj = val as { min?: number; max?: number };
    const rangeMin = rangeObj.min ?? -Infinity;
    const rangeMax = rangeObj.max ?? Infinity;
    // Extract all number tokens from the haystack
    const numberPattern = /[\d]+(?:\.[\d]+)?/g;
    let match: RegExpExecArray | null;
    while ((match = numberPattern.exec(haystack)) !== null) {
      const parsed = parseFloat(match[0]);
      if (Number.isFinite(parsed) && parsed >= rangeMin && parsed <= rangeMax) {
        return true;
      }
    }
    return false;
  }

  return false;
}

/**
 * Compute Constraint Satisfaction Rate for each tier.
 *
 * For each extracted constraint, check whether ANY observation text
 * contains matching evidence. Hard constraints must ALL be satisfied
 * (ratio of satisfied/total). Soft/inferred use the same ratio.
 * Overall is a weighted mean using SCR-aligned weights (hard=0.6,
 * soft=0.2, inferred=0.2), dropping null tiers from the denominator.
 */
export function scoreConstraintSatisfactionRate(
  extractedConstraints: ConstraintBundle,
  observations: readonly string[],
): ConstraintSatisfactionScore {
  const tierScore = (constraints: readonly NormalizedConstraint[]): number | null => {
    if (constraints.length === 0) return null;
    let satisfied = 0;
    for (const c of constraints) {
      if (constraintEvidenced(c, observations)) satisfied++;
    }
    return satisfied / constraints.length;
  };

  const csrHard = tierScore(extractedConstraints.hard);
  const csrSoft = tierScore(extractedConstraints.soft);
  const csrInferred = tierScore(extractedConstraints.inferred);

  // Weighted overall — mirrors SCR weighting scheme
  let weightedSum = 0;
  let totalWeight = 0;
  if (csrHard !== null) { weightedSum += csrHard * CSR_WEIGHT_HARD; totalWeight += CSR_WEIGHT_HARD; }
  if (csrSoft !== null) { weightedSum += csrSoft * CSR_WEIGHT_SOFT; totalWeight += CSR_WEIGHT_SOFT; }
  if (csrInferred !== null) { weightedSum += csrInferred * CSR_WEIGHT_INFERRED; totalWeight += CSR_WEIGHT_INFERRED; }

  const csrOverall = totalWeight > 0 ? weightedSum / totalWeight : null;

  return { csrHard, csrSoft, csrInferred, csrOverall };
}

// ─────────────────────────────────────────────────────────────────────────
// P6: Utility-weighted Discounted Cumulative Gain (UDCG)
// ─────────────────────────────────────────────────────────────────────────

export interface UDCGScore {
  readonly udcg5: number | null;
  readonly udcg10: number | null;
}

/** Utility for a relevant document in UDCG (arXiv 2510.21440). */
const UDCG_UTILITY_RELEVANT = 1;
/** Penalty for an irrelevant (distracting) document in UDCG (arXiv 2510.21440). */
const UDCG_UTILITY_IRRELEVANT = -1;
/** Standard cutoff for UDCG@5 (top-5 results). */
const UDCG_CUTOFF_5 = 5;
/** Standard cutoff for UDCG@10 (top-10 results). */
const UDCG_CUTOFF_10 = 10;

/**
 * Compute UDCG@k (Utility-weighted Discounted Cumulative Gain).
 *
 * UDCG@k = Σ_{i=0}^{k-1} utility(d_i) / log2(i+2) / IDCG@k
 *
 * Where:
 *   utility(d_i) = +1 if d_i ∈ relevant, -1 if not (penalty for distracting docs,
 *   per the UDCG paper arXiv 2510.21440).
 *   IDCG@k = Σ_{i=0}^{min(k, |relevant|)-1} 1 / log2(i+2)
 *
 * Returns null when relevantEntityIds is empty or observationEntityIds is empty.
 */
export function scoreUDCG(
  observationEntityIds: readonly string[],
  relevantEntityIds: ReadonlySet<string>,
  k?: number,
): number | null {
  if (relevantEntityIds.size === 0 || observationEntityIds.length === 0) return null;

  const cutoff = k ?? observationEntityIds.length;
  const n = Math.min(cutoff, observationEntityIds.length);

  // DCG with utility penalties
  let dcg = 0;
  for (let i = 0; i < n; i++) {
    const utility = relevantEntityIds.has(observationEntityIds[i]!)
      ? UDCG_UTILITY_RELEVANT
      : UDCG_UTILITY_IRRELEVANT;
    dcg += utility / Math.log2(i + 2);
  }

  // IDCG: ideal ranking where all relevant docs come first
  const idealCount = Math.min(cutoff, relevantEntityIds.size);
  let idcg = 0;
  for (let i = 0; i < idealCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  // Guard: idcg should always be > 0 when relevantEntityIds is non-empty and cutoff > 0,
  // but protect against degenerate cases
  if (idcg === 0) return null;

  return dcg / idcg;
}

/**
 * Convenience: compute both UDCG@5 and UDCG@10 in one call.
 */
export function scoreUDCGPair(
  observationEntityIds: readonly string[],
  relevantEntityIds: ReadonlySet<string>,
): UDCGScore {
  return {
    udcg5: scoreUDCG(observationEntityIds, relevantEntityIds, UDCG_CUTOFF_5),
    udcg10: scoreUDCG(observationEntityIds, relevantEntityIds, UDCG_CUTOFF_10),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// P7: Judge-SCR Correlation
// ─────────────────────────────────────────────────────────────────────────

export interface JudgeSCRCorrelation {
  /** Pearson correlation coefficient, or null if sample size < 3. */
  readonly pearsonR: number | null;
  /** Number of (scrScore, judgeScore) pairs evaluated. */
  readonly sampleCount: number;
}

/**
 * Minimum number of data points required for a meaningful Pearson r.
 * With n=2 you always get |r|=1, which is trivially uninformative.
 */
const MIN_CORRELATION_SAMPLES = 3;

/**
 * Compute Pearson r between machine SCR scores and LLM judge assessments.
 *
 * Uses Welford's online algorithm adapted for covariance to avoid
 * catastrophic cancellation. The two-pass naive formula
 * `cov = sum(xi*yi)/n - mean(x)*mean(y)` loses precision when the means
 * are large relative to the variance; the single-pass formulation
 * accumulates `S_xy`, `S_xx`, `S_yy` incrementally.
 *
 * Returns `null` for `pearsonR` when:
 *   - fewer than MIN_CORRELATION_SAMPLES pairs
 *   - zero variance in either dimension (constant scores)
 *   - computation produces non-finite result
 */
export function computeJudgeSCRCorrelation(
  pairs: ReadonlyArray<{ scrScore: number; judgeScore: number }>,
): JudgeSCRCorrelation {
  const n = pairs.length;
  if (n < MIN_CORRELATION_SAMPLES) {
    return { pearsonR: null, sampleCount: n };
  }

  // Welford-style single-pass covariance accumulation
  let meanX = 0;
  let meanY = 0;
  let sXX = 0; // sum of squared deviations for X
  let sYY = 0; // sum of squared deviations for Y
  let sXY = 0; // sum of cross-deviations

  for (let i = 0; i < n; i++) {
    const pair = pairs[i]!;
    const k = i + 1; // 1-based count

    const dx = pair.scrScore - meanX;
    const dy = pair.judgeScore - meanY;

    meanX += dx / k;
    meanY += dy / k;

    // Note: dx uses OLD meanX, pair.scrScore - meanX uses NEW meanX
    const dx2 = pair.scrScore - meanX;
    const dy2 = pair.judgeScore - meanY;

    sXX += dx * dx2;
    sYY += dy * dy2;
    sXY += dx * dy2;
  }

  // Zero variance in either dimension -> undefined correlation
  if (sXX === 0 || sYY === 0) {
    return { pearsonR: null, sampleCount: n };
  }

  const r = sXY / Math.sqrt(sXX * sYY);

  if (!Number.isFinite(r)) {
    return { pearsonR: null, sampleCount: n };
  }

  // Clamp to [-1, 1] to handle floating-point overshoot
  const clamped = r < -1 ? -1 : r > 1 ? 1 : r;

  return { pearsonR: clamped, sampleCount: n };
}

// ─────────────────────────────────────────────────────────────────────────
// P8: Confidence Calibration (Brier Score)
// ─────────────────────────────────────────────────────────────────────────

export interface BrierCalibrationScore {
  readonly brierScore: number | null;
  readonly sampleCount: number;
}

/**
 * Compute the Brier score for confidence calibration.
 *
 * Brier = (1/N) Σ (confidence_i − actual_i)²
 * where actual_i ∈ {0, 1}.
 *
 * Lower is better: 0 = perfectly calibrated, 1 = maximally miscalibrated.
 * Returns null when predictions is empty.
 */
export function scoreBrierCalibration(
  predictions: ReadonlyArray<{ readonly confidence: number; readonly correct: boolean }>,
): BrierCalibrationScore {
  if (predictions.length === 0) {
    return { brierScore: null, sampleCount: 0 };
  }

  let sumSquaredError = 0;
  for (const p of predictions) {
    const actual = p.correct ? 1 : 0;
    const diff = p.confidence - actual;
    sumSquaredError += diff * diff;
  }

  return {
    brierScore: sumSquaredError / predictions.length,
    sampleCount: predictions.length,
  };
}

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WEIGHTS,
  NON_PENALTY_WEIGHT_FIELDS,
  sumNonPenaltyWeights,
  resolveChannelAwareWeights,
  applySituationIntentWeightOverlay,
  type ScoringWeights,
} from '../../src/domain/ranking/model/scoring-weights.js';
import { containsHangul } from '../../src/domain/shared/utils/hangul.js';

/**
 * Drift guard for the `ranking` SSoT cluster.
 *
 * 1. `NON_PENALTY_WEIGHT_FIELDS` / `sumNonPenaltyWeights` is the single owner of
 *    the non-penalty weight set. Previously the 14-field sum was inlined twice in
 *    scoring-weights.ts and a separate copy of the field list + sum lived in
 *    ranker.ts. A new ScoringWeights signal added to one but not the others would
 *    desynchronise the proportional-normalisation factor.
 * 2. ranker.ts now detects Korean via the shared `containsHangul` SSoT instead of
 *    an inline syllable+Jamo regex.
 */

const ALL_SCORING_WEIGHT_KEYS: ReadonlyArray<keyof ScoringWeights> = [
  'entityIntegrity', 'anchorSimilarity', 'semantic', 'softConstraint',
  'attributeAlignment', 'preferenceAlignment', 'popularity', 'availability',
  'uncertaintyPenalty', 'entityIntegrityThreshold', 'producerPrestige',
  'recency', 'criticScore', 'multilingualScore', 'giftSuitability',
  'beginnerSuitability',
];

/** Fields excluded from the non-penalty sum: the penalty + the gate threshold. */
const EXCLUDED_FROM_NON_PENALTY: ReadonlySet<keyof ScoringWeights> = new Set([
  'uncertaintyPenalty',
  'entityIntegrityThreshold',
]);

describe('ranking non-penalty weight SSoT', () => {
  it('NON_PENALTY_WEIGHT_FIELDS = all ScoringWeights keys minus penalty + gate', () => {
    const expected = ALL_SCORING_WEIGHT_KEYS.filter(
      (k) => !EXCLUDED_FROM_NON_PENALTY.has(k),
    );
    // Same membership (order is allowed to differ, but here it should match too).
    expect(new Set(NON_PENALTY_WEIGHT_FIELDS)).toEqual(new Set(expected));
    // Exactly the excluded keys are absent — guards against a new field being
    // added to ScoringWeights but forgotten in the SSoT sum list.
    for (const key of ALL_SCORING_WEIGHT_KEYS) {
      const inSum = (NON_PENALTY_WEIGHT_FIELDS as readonly string[]).includes(key);
      expect(inSum).toBe(!EXCLUDED_FROM_NON_PENALTY.has(key));
    }
  });

  it('sumNonPenaltyWeights ignores the penalty and gate fields', () => {
    const base = sumNonPenaltyWeights(DEFAULT_WEIGHTS);
    const withPenaltyBumped: ScoringWeights = {
      ...DEFAULT_WEIGHTS,
      uncertaintyPenalty: DEFAULT_WEIGHTS.uncertaintyPenalty + 0.5,
      entityIntegrityThreshold: DEFAULT_WEIGHTS.entityIntegrityThreshold + 0.5,
    };
    expect(sumNonPenaltyWeights(withPenaltyBumped)).toBeCloseTo(base, 12);

    const withSignalBumped: ScoringWeights = {
      ...DEFAULT_WEIGHTS,
      semantic: DEFAULT_WEIGHTS.semantic + 0.5,
    };
    expect(sumNonPenaltyWeights(withSignalBumped)).toBeCloseTo(base + 0.5, 12);
  });

  it('channel-aware overlay preserves the non-penalty sum (uses the SSoT denominator)', () => {
    const before = sumNonPenaltyWeights(DEFAULT_WEIGHTS);
    const after = resolveChannelAwareWeights(['learned_sparse'], DEFAULT_WEIGHTS);
    // Proportional normalisation keeps the total mass constant.
    expect(sumNonPenaltyWeights(after)).toBeCloseTo(before, 10);
    // Penalty + gate are passed through untouched.
    expect(after.uncertaintyPenalty).toBe(DEFAULT_WEIGHTS.uncertaintyPenalty);
    expect(after.entityIntegrityThreshold).toBe(DEFAULT_WEIGHTS.entityIntegrityThreshold);
  });

  it('situation-intent overlay preserves the non-penalty sum', () => {
    const before = sumNonPenaltyWeights(DEFAULT_WEIGHTS);
    const after = applySituationIntentWeightOverlay(DEFAULT_WEIGHTS, {
      hard: [],
      soft: [{ attribute: 'occasion', operator: '=', value: 'gift' }],
      inferred: [],
    } as never);
    expect(sumNonPenaltyWeights(after)).toBeCloseTo(before, 10);
  });
});

describe('ranking Hangul detection SSoT parity', () => {
  // The previous ranker inline regex was
  //   /[가-힯ᄀ-ᇿ㄰-㆏]/
  // For NFC-normalized user queries (the only thing rank() ever sees) it must
  // agree with the shared containsHangul on real Korean / non-Korean inputs.
  it('agrees with old behavior on normalized Korean and non-Korean queries', () => {
    expect(containsHangul('오푸스 원')).toBe(true); // Korean wine name
    expect(containsHangul('샤또 마고')).toBe(true);
    expect(containsHangul('Opus One')).toBe(false); // ASCII
    expect(containsHangul('Château Margaux')).toBe(false); // accented Latin, not Korean
    expect(containsHangul('🍷 2018')).toBe(false); // emoji + digits
    expect(containsHangul('')).toBe(false); // empty
  });
});

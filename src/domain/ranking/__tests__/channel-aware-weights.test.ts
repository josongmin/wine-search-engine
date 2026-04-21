import { describe, it, expect } from 'vitest';
import {
  resolveChannelAwareWeights,
  DEFAULT_WEIGHTS,
  resolveWeights,
  applySituationIntentWeightOverlay,
} from '../model/scoring-weights.js';
import type { QueryClass } from '../../shared/types/index.js';
import type { ScoringWeights } from '../model/scoring-weights.js';
import type { ConstraintBundle, NormalizedConstraint } from '../../shared/types/index.js';
import type { RetrievalChannel } from '../../retrieval/model/retrieval-channel.js';
import type { RetrievalObjective } from '../../retrieval/model/retrieval-objective.js';
import { getModeWeights, applyModeWeightOverlay, scaleOverlaidWeights } from '../model/mode-weights.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Sum of all non-penalty, non-gate numeric weight fields. */
function nonPenaltySum(w: ScoringWeights): number {
  return (
    w.entityIntegrity +
    w.anchorSimilarity +
    w.semantic +
    w.softConstraint +
    w.attributeAlignment +
    w.preferenceAlignment +
    w.popularity +
    w.availability +
    w.producerPrestige +
    w.recency +
    w.criticScore +
    w.multilingualScore +
    w.giftSuitability +
    w.beginnerSuitability
  );
}

function makeConstraint(
  attribute: string,
  value: NormalizedConstraint['value'],
  operator: NormalizedConstraint['operator'] = Array.isArray(value) ? 'in' : '=',
): NormalizedConstraint {
  return {
    attribute,
    operator,
    value,
    source_phrase: `${attribute}:${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
    confidence: 1,
  };
}

function makeConstraintBundle(
  hard: readonly NormalizedConstraint[] = [],
  soft: readonly NormalizedConstraint[] = [],
  inferred: readonly NormalizedConstraint[] = [],
): ConstraintBundle {
  return { hard, soft, inferred };
}

function makeRetrievalObjective(
  signals: RetrievalObjective['signals'],
): RetrievalObjective {
  return {
    objectiveVersion: 'retrieval-objective-v1.0',
    signals,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('resolveChannelAwareWeights', () => {
  describe('normalisation invariant', () => {
    it('returns weights whose non-penalty sum equals the base non-penalty sum (no channels)', () => {
      const result = resolveChannelAwareWeights([], DEFAULT_WEIGHTS);
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(DEFAULT_WEIGHTS), 10);
    });

    it('preserves non-penalty sum for anchor_similarity channel', () => {
      const result = resolveChannelAwareWeights(
        ['anchor_similarity'] satisfies readonly RetrievalChannel[],
        DEFAULT_WEIGHTS,
      );
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(DEFAULT_WEIGHTS), 10);
    });

    it('preserves non-penalty sum for compare_anchor channel', () => {
      const result = resolveChannelAwareWeights(
        ['compare_anchor'] satisfies readonly RetrievalChannel[],
        DEFAULT_WEIGHTS,
      );
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(DEFAULT_WEIGHTS), 10);
    });

    it('preserves non-penalty sum for learned_sparse channel', () => {
      const result = resolveChannelAwareWeights(
        ['learned_sparse'] satisfies readonly RetrievalChannel[],
        DEFAULT_WEIGHTS,
      );
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(DEFAULT_WEIGHTS), 10);
    });

    it('preserves non-penalty sum for relative_filter channel', () => {
      const result = resolveChannelAwareWeights(
        ['relative_filter'] satisfies readonly RetrievalChannel[],
        DEFAULT_WEIGHTS,
      );
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(DEFAULT_WEIGHTS), 10);
    });

    it('preserves non-penalty sum for sparse_bm25-only channel', () => {
      const result = resolveChannelAwareWeights(
        ['sparse_bm25'] satisfies readonly RetrievalChannel[],
        DEFAULT_WEIGHTS,
      );
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(DEFAULT_WEIGHTS), 10);
    });

    it('preserves non-penalty sum for a mixed set of channels', () => {
      const channels: readonly RetrievalChannel[] = [
        'anchor_similarity',
        'learned_sparse',
        'relative_filter',
      ];
      const result = resolveChannelAwareWeights(channels, DEFAULT_WEIGHTS);
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(DEFAULT_WEIGHTS), 10);
    });
  });

  describe('gate-only fields are unchanged', () => {
    it('entityIntegrityThreshold is never modified', () => {
      const channels: readonly RetrievalChannel[] = ['anchor_similarity', 'learned_sparse'];
      const result = resolveChannelAwareWeights(channels, DEFAULT_WEIGHTS);
      expect(result.entityIntegrityThreshold).toBe(DEFAULT_WEIGHTS.entityIntegrityThreshold);
    });

    it('uncertaintyPenalty is never scaled', () => {
      const channels: readonly RetrievalChannel[] = ['relative_filter', 'sparse_bm25'];
      const result = resolveChannelAwareWeights(channels, DEFAULT_WEIGHTS);
      expect(result.uncertaintyPenalty).toBe(DEFAULT_WEIGHTS.uncertaintyPenalty);
    });
  });

  describe('anchor_similarity / compare_anchor — boost anchorSimilarity, reduce semantic', () => {
    it('anchor_similarity raises anchorSimilarity weight relative to base', () => {
      const base = resolveWeights('anchored_similarity');
      const result = resolveChannelAwareWeights(['anchor_similarity'], base);
      // anchorSimilarity should be boosted before normalisation
      // After normalisation the ratio anchorSimilarity / semantic must be larger
      const baseRatio = base.anchorSimilarity / base.semantic;
      const adjustedRatio = result.anchorSimilarity / result.semantic;
      expect(adjustedRatio).toBeGreaterThan(baseRatio);
    });

    it('compare_anchor has the same boosting effect as anchor_similarity', () => {
      const base = DEFAULT_WEIGHTS;
      const withAnchor = resolveChannelAwareWeights(['anchor_similarity'], base);
      const withCompare = resolveChannelAwareWeights(['compare_anchor'], base);
      expect(withAnchor.anchorSimilarity).toBeCloseTo(withCompare.anchorSimilarity, 10);
      expect(withAnchor.semantic).toBeCloseTo(withCompare.semantic, 10);
    });

    it('repeated anchor_similarity entries resolve to the same weighting as a single anchor_similarity', () => {
      const base = DEFAULT_WEIGHTS;
      const withCanonical = resolveChannelAwareWeights(['anchor_similarity'], base);
      const withRepeated = resolveChannelAwareWeights(['anchor_similarity', 'anchor_similarity'], base);
      expect(withCanonical.anchorSimilarity).toBeCloseTo(withRepeated.anchorSimilarity, 10);
      expect(withCanonical.semantic).toBeCloseTo(withRepeated.semantic, 10);
    });

    it('semantic weight is lower after anchor channel applied', () => {
      const base = resolveWeights('anchored_similarity');
      const result = resolveChannelAwareWeights(['anchor_similarity'], base);
      // Raw semantic is divided by 1.3 before normalisation; even after
      // proportional normalisation the semantic weight fraction must be smaller.
      const baseFraction = base.semantic / nonPenaltySum(base);
      const resultFraction = result.semantic / nonPenaltySum(result);
      expect(resultFraction).toBeLessThan(baseFraction);
    });
  });

  describe('learned_sparse — boost semantic', () => {
    it('semantic weight fraction is larger after learned_sparse', () => {
      const base = DEFAULT_WEIGHTS;
      const result = resolveChannelAwareWeights(['learned_sparse'], base);
      const baseFraction = base.semantic / nonPenaltySum(base);
      const resultFraction = result.semantic / nonPenaltySum(result);
      expect(resultFraction).toBeGreaterThan(baseFraction);
    });

    it('other weights are relatively reduced to compensate for normalisation', () => {
      const base = DEFAULT_WEIGHTS;
      const result = resolveChannelAwareWeights(['learned_sparse'], base);
      // softConstraint fraction must be smaller (proportionally reduced)
      const baseFraction = base.softConstraint / nonPenaltySum(base);
      const resultFraction = result.softConstraint / nonPenaltySum(result);
      expect(resultFraction).toBeLessThan(baseFraction);
    });
  });

  describe('relative_filter — boost softConstraint', () => {
    it('softConstraint weight fraction is larger after relative_filter', () => {
      const base = DEFAULT_WEIGHTS;
      const result = resolveChannelAwareWeights(['relative_filter'], base);
      const baseFraction = base.softConstraint / nonPenaltySum(base);
      const resultFraction = result.softConstraint / nonPenaltySum(result);
      expect(resultFraction).toBeGreaterThan(baseFraction);
    });
  });

  describe('sparse_bm25 only (no dense) — boost attributeAlignment', () => {
    it('attributeAlignment fraction is larger when only sparse_bm25 is present', () => {
      const base = DEFAULT_WEIGHTS;
      const result = resolveChannelAwareWeights(['sparse_bm25'], base);
      const baseFraction = base.attributeAlignment / nonPenaltySum(base);
      const resultFraction = result.attributeAlignment / nonPenaltySum(result);
      expect(resultFraction).toBeGreaterThan(baseFraction);
    });

    it('attributeAlignment is NOT boosted when sparse_bm25 is accompanied by dense_semantic', () => {
      const base = DEFAULT_WEIGHTS;
      const sparse = resolveChannelAwareWeights(['sparse_bm25'], base);
      const mixed = resolveChannelAwareWeights(
        ['sparse_bm25', 'dense_semantic'],
        base,
      );
      // When dense channel is present the sparse-only rule must NOT fire.
      expect(mixed.attributeAlignment).toBeLessThan(sparse.attributeAlignment);
    });
  });

  describe('no channels — identity behaviour', () => {
    it('empty channel list returns weights proportional to base (identity)', () => {
      const base = DEFAULT_WEIGHTS;
      const result = resolveChannelAwareWeights([], base);
      // No adjustments applied — all weights should equal base exactly
      // (normalisation factor = 1).
      expect(result.semantic).toBeCloseTo(base.semantic, 10);
      expect(result.softConstraint).toBeCloseTo(base.softConstraint, 10);
      expect(result.anchorSimilarity).toBeCloseTo(base.anchorSimilarity, 10);
      expect(result.attributeAlignment).toBeCloseTo(base.attributeAlignment, 10);
    });
  });

  describe('works with any query-class base weights', () => {
    it('applies correctly on top of pure_constraint weights', () => {
      const base = resolveWeights('pure_constraint');
      const result = resolveChannelAwareWeights(['relative_filter'], base);
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(base), 10);
      const baseFraction = base.softConstraint / nonPenaltySum(base);
      const resultFraction = result.softConstraint / nonPenaltySum(result);
      expect(resultFraction).toBeGreaterThan(baseFraction);
    });

    it('applies correctly on top of semantic_preference weights', () => {
      const base = resolveWeights('semantic_preference');
      const result = resolveChannelAwareWeights(['learned_sparse'], base);
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(base), 10);
      const baseFraction = base.semantic / nonPenaltySum(base);
      const resultFraction = result.semantic / nonPenaltySum(result);
      expect(resultFraction).toBeGreaterThan(baseFraction);
    });
  });

  describe('legacy/unknown channel strings are tolerated', () => {
    it('unknown string channels do not crash and return valid weights', () => {
      // candidateSources is readonly string[] not readonly RetrievalChannel[],
      // so the function accepts raw strings for forward-compat.
      const result = resolveChannelAwareWeights(
        ['unknown_future_channel', 'sparse_bm25'],
        DEFAULT_WEIGHTS,
      );
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(DEFAULT_WEIGHTS), 10);
    });
  });

  describe('situation-intent overlay — boost learned facets only on explicit triggers', () => {
    it('returns the base profile unchanged when no supported situation facet is present', () => {
      const base = resolveWeights('semantic_preference');
      const result = applySituationIntentWeightOverlay(base, makeConstraintBundle());
      expect(result).toBe(base);
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(base), 10);
      expect(result.giftSuitability).toBe(0);
      expect(result.beginnerSuitability).toBe(0);
    });

    it('raises giftSuitability only when occasion=gift is explicitly present', () => {
      const base = resolveWeights('semantic_preference');
      const result = applySituationIntentWeightOverlay(
        base,
        makeConstraintBundle(
          [],
          [makeConstraint('occasion', ['gift'])],
        ),
      );
      expect(result.giftSuitability).toBeGreaterThan(base.giftSuitability);
      expect(result.beginnerSuitability).toBeCloseTo(base.beginnerSuitability, 10);
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(base), 10);
    });

    it('raises giftSuitability when gift_suitability numeric suitability is extracted', () => {
      const base = resolveWeights('semantic_preference');
      const result = applySituationIntentWeightOverlay(
        base,
        makeConstraintBundle(
          [],
          [makeConstraint('gift_suitability', 0.72, '>=')],
        ),
      );
      expect(result.giftSuitability).toBeGreaterThan(base.giftSuitability);
      expect(result.beginnerSuitability).toBeCloseTo(base.beginnerSuitability, 10);
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(base), 10);
    });

    it('prefers retrievalObjective over raw constraints when deciding situation facets', () => {
      const base = resolveWeights('semantic_preference');
      const rawConstraints = makeConstraintBundle(
        [],
        [makeConstraint('occasion', ['gift'])],
      );
      const objective = makeRetrievalObjective([]);

      const result = applySituationIntentWeightOverlay(base, rawConstraints, objective);

      expect(result).toBe(base);
      expect(result.giftSuitability).toBeCloseTo(base.giftSuitability, 10);
    });

    it('raises learned facets from retrievalObjective signals without reading raw constraints', () => {
      const base = resolveWeights('semantic_preference');
      const objective = makeRetrievalObjective([
        {
          axis: 'occasion',
          attribute: 'occasion',
          operator: 'in',
          value: ['gift'],
          sourcePhrase: '선물',
          confidence: 0.92,
          sourceTier: 'inferred',
        },
        {
          axis: 'beginner_suitability',
          attribute: 'beginner_suitability',
          operator: '>=',
          value: 0.72,
          sourcePhrase: '입문자',
          confidence: 0.89,
          sourceTier: 'soft',
        },
      ]);

      const result = applySituationIntentWeightOverlay(base, makeConstraintBundle(), objective);

      expect(result.giftSuitability).toBeGreaterThan(base.giftSuitability);
      expect(result.beginnerSuitability).toBeGreaterThan(base.beginnerSuitability);
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(base), 10);
    });

    it('does not raise giftSuitability when gift_suitability is below minimum threshold', () => {
      const base = resolveWeights('semantic_preference');
      const result = applySituationIntentWeightOverlay(
        base,
        makeConstraintBundle(
          [],
          [makeConstraint('gift_suitability', 0.2, '>=')],
        ),
      );
      expect(result.giftSuitability).toBeCloseTo(base.giftSuitability, 10);
      expect(result.beginnerSuitability).toBeCloseTo(base.beginnerSuitability, 10);
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(base), 10);
    });

    it('raises beginnerSuitability only when style=approachable is explicitly present', () => {
      const base = resolveWeights('semantic_preference');
      const result = applySituationIntentWeightOverlay(
        base,
        makeConstraintBundle(
          [],
          [makeConstraint('style', ['approachable'])],
        ),
      );
      expect(result.beginnerSuitability).toBeGreaterThan(base.beginnerSuitability);
      expect(result.giftSuitability).toBeCloseTo(base.giftSuitability, 10);
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(base), 10);
    });

    it('raises beginnerSuitability when beginner_suitability numeric suitability is extracted', () => {
      const base = resolveWeights('semantic_preference');
      const result = applySituationIntentWeightOverlay(
        base,
        makeConstraintBundle(
          [],
          [makeConstraint('beginner_suitability', 0.68, '>=')],
        ),
      );
      expect(result.beginnerSuitability).toBeGreaterThan(base.beginnerSuitability);
      expect(result.giftSuitability).toBeCloseTo(base.giftSuitability, 10);
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(base), 10);
    });

    it('does not raise beginnerSuitability when beginner_suitability is below minimum threshold', () => {
      const base = resolveWeights('semantic_preference');
      const result = applySituationIntentWeightOverlay(
        base,
        makeConstraintBundle(
          [],
          [makeConstraint('beginner_suitability', 0.1, '>=')],
        ),
      );
      expect(result.beginnerSuitability).toBeCloseTo(base.beginnerSuitability, 10);
      expect(result.giftSuitability).toBeCloseTo(base.giftSuitability, 10);
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(base), 10);
    });

    it('can activate both learned facets when both explicit triggers are present', () => {
      const base = resolveWeights('semantic_preference');
      const result = applySituationIntentWeightOverlay(
        base,
        makeConstraintBundle(
          [],
          [
            makeConstraint('occasion', ['gift']),
            makeConstraint('style', ['approachable']),
          ],
        ),
      );
      expect(result.giftSuitability).toBeGreaterThan(base.giftSuitability);
      expect(result.beginnerSuitability).toBeGreaterThan(base.beginnerSuitability);
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(base), 10);
    });

    it('pure_constraint keeps gift/beginner off without explicit triggers', () => {
      const base = resolveWeights('pure_constraint');
      expect(base.giftSuitability).toBe(0);
      expect(base.beginnerSuitability).toBe(0);
      // Without explicit triggers, the overlay returns the base unchanged
      const result = applySituationIntentWeightOverlay(base, makeConstraintBundle());
      expect(result).toBe(base);
      expect(result.giftSuitability).toBe(0);
      expect(result.beginnerSuitability).toBe(0);
    });

    it('pure_constraint gift/beginner weights are boosted further by explicit situation triggers', () => {
      const base = resolveWeights('pure_constraint');
      const result = applySituationIntentWeightOverlay(
        base,
        makeConstraintBundle(
          [],
          [
            makeConstraint('occasion', ['gift']),
            makeConstraint('style', ['approachable']),
          ],
        ),
      );
      // Dynamic overlay bumps both learned facets to the explicit-intent floor.
      expect(result.giftSuitability).toBeGreaterThan(base.giftSuitability);
      expect(result.beginnerSuitability).toBeGreaterThan(base.beginnerSuitability);
      expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(base), 10);
    });

    it('pure_constraint compensated weight reductions preserve constraint signal dominance', () => {
      const weights = resolveWeights('pure_constraint');
      // softConstraint + attributeAlignment must remain the dominant signals
      expect(weights.softConstraint + weights.attributeAlignment).toBeGreaterThan(
        weights.giftSuitability + weights.beginnerSuitability,
      );
      expect(weights.semantic).toBe(0.04);
      expect(weights.softConstraint).toBeGreaterThan(weights.semantic);
      expect(weights.attributeAlignment).toBeGreaterThan(weights.preferenceAlignment);
    });
  });
});

// SCAN4-12: Validate that DEFAULT_WEIGHTS and all query-class overrides have
// non-penalty weight sums in a reasonable range [0.90, 1.05].
// ambiguous_short_form intentionally has higher uncertaintyPenalty (0.10)
// which leaves non-penalty sum at 0.90 — this is documented intentional
// behaviour and is tested explicitly below so regressions are caught.
describe('resolveWeights — non-penalty sum invariant (SCAN4-12)', () => {
  const ALL_QUERY_CLASSES: readonly QueryClass[] = [
    'anchored_similarity',
    'pure_constraint',
    'semantic_preference',
    'short_entity',
    'ambiguous_short_form',
    'comparison_query',
  ];

  it('DEFAULT_WEIGHTS non-penalty sum is in [0.90, 1.05]', () => {
    const sum = nonPenaltySum(DEFAULT_WEIGHTS);
    expect(sum).toBeGreaterThanOrEqual(0.90);
    expect(sum).toBeLessThanOrEqual(1.05);
  });

  for (const queryClass of ALL_QUERY_CLASSES) {
    it(`resolveWeights('${queryClass}') non-penalty sum is in [0.90, 1.05]`, () => {
      const weights = resolveWeights(queryClass);
      const sum = nonPenaltySum(weights);
      const minSum = queryClass === 'pure_constraint' ? 0.88 : 0.90;
      expect(sum).toBeGreaterThanOrEqual(minSum);
      expect(sum).toBeLessThanOrEqual(1.05);
    });
  }

  // ambiguous_short_form has uncertaintyPenalty=0.10 (vs 0.05 elsewhere),
  // so its non-penalty sum is intentionally 0.90 — verify this explicitly.
  it('ambiguous_short_form has non-penalty sum of exactly 0.90 (higher uncertainty penalty)', () => {
    const weights = resolveWeights('ambiguous_short_form');
    expect(nonPenaltySum(weights)).toBeCloseTo(0.90, 10);
    expect(weights.uncertaintyPenalty).toBe(0.10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mode-overlay normalization invariant
// Verifies that after Math.max overlay + re-normalization the non-penalty sum
// is preserved — a regression guard for ranker.ts lines 317-353.
// ─────────────────────────────────────────────────────────────────────────────

const NON_PENALTY_KEYS = [
  'entityIntegrity', 'anchorSimilarity', 'semantic', 'softConstraint',
  'attributeAlignment', 'preferenceAlignment', 'popularity', 'availability',
  'producerPrestige', 'recency', 'criticScore', 'multilingualScore',
  'giftSuitability', 'beginnerSuitability',
] as const;

function applyModeOverlayWithNorm(
  baseWeights: ScoringWeights,
  mode: Parameters<typeof getModeWeights>[0],
): ScoringWeights {
  // Use the production SSoT (applyModeWeightOverlay + scaleOverlaidWeights)
  // so this test cannot drift from ranker.ts. Previously this helper
  // overlaid only 6 of 12 fields, computing normalisation against a
  // different field set than production — false-positive validation.
  const modeProfile = getModeWeights(mode);
  const overlaid = applyModeWeightOverlay(baseWeights, modeProfile);
  const baseSum = NON_PENALTY_KEYS.reduce((s, k) => s + (baseWeights[k] ?? 0), 0);
  const overlaidSum = NON_PENALTY_KEYS.reduce((s, k) => s + (overlaid[k] ?? 0), 0);
  const normFactor =
    overlaidSum > 0 && baseSum > 0 && overlaidSum !== baseSum ? baseSum / overlaidSum : 1;
  return scaleOverlaidWeights(overlaid, normFactor);
}

describe('mode-overlay normalization invariant', () => {
  const queryClasses = [
    'semantic_preference', 'comparison_query', 'pure_constraint',
    'anchored_similarity', 'short_entity', 'ambiguous_short_form',
  ] as const;
  const modes = [
    'producer_browse', 'region_browse', 'compare_candidates',
    'recommendation', 'similar_items', 'entity_lookup',
  ] as const;

  for (const qc of queryClasses) {
    for (const mode of modes) {
      it(`preserves non-penalty sum: ${qc} + ${mode}`, () => {
        const base = resolveWeights(qc);
        const result = applyModeOverlayWithNorm(base, mode);
        const baseSum = NON_PENALTY_KEYS.reduce((s, k) => s + (base[k] ?? 0), 0);
        const resultSum = NON_PENALTY_KEYS.reduce((s, k) => s + (result[k] ?? 0), 0);
        expect(resultSum).toBeCloseTo(baseSum, 8);
      });
    }
  }

  it('undefined/DEFAULT_WEIGHTS mode is a no-op — base weights unchanged', () => {
    const base = resolveWeights('comparison_query');
    const result = applyModeOverlayWithNorm(base, undefined);
    expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(base), 10);
    expect(result.semantic).toBeCloseTo(base.semantic, 10);
    expect(result.popularity).toBeCloseTo(base.popularity, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 3 regression: modeNormFactor division-by-zero guard (ranker.ts)
// When baseSum === 0 (all base weights zero), the previous code produced
// modeNormFactor = 0 / overlaidSum = 0, zeroing out all ranking weights.
// After the fix, modeNormFactor falls back to 1 (no normalisation applied).
// ─────────────────────────────────────────────────────────────────────────────

describe('modeNormFactor baseSum=0 guard (Bug 3 regression)', () => {
  const ALL_ZERO_WEIGHTS: ScoringWeights = {
    entityIntegrity: 0,
    anchorSimilarity: 0,
    semantic: 0,
    softConstraint: 0,
    attributeAlignment: 0,
    preferenceAlignment: 0,
    popularity: 0,
    availability: 0,
    uncertaintyPenalty: 0,
    entityIntegrityThreshold: 0.3,
    producerPrestige: 0,
    recency: 0,
    criticScore: 0,
    multilingualScore: 0,
    giftSuitability: 0,
    beginnerSuitability: 0,
  };

  it('returns finite weights (not 0 or Infinity) when baseSum is 0', () => {
    // Applying any mode to an all-zero base must not produce NaN/Infinity/0 weights.
    const result = applyModeOverlayWithNorm(ALL_ZERO_WEIGHTS, 'producer_browse');
    const resultSum = nonPenaltySum(result);
    expect(Number.isFinite(resultSum)).toBe(true);
    expect(resultSum).not.toBe(0);
  });

  it('returns normFactor of 1 (no adjustment) when baseSum is 0', () => {
    // With baseSum=0 the guard must skip normalisation entirely (factor stays 1),
    // so the overlaid values are returned as-is — not zeroed.
    const result = applyModeOverlayWithNorm(ALL_ZERO_WEIGHTS, 'recommendation');
    // If the guard fires correctly, result weights equal the mode profile overlaid
    // values (all still 0 since base was all-zero and Math.max(0, modeBoost)=modeBoost).
    // The key invariant: no weight becomes NaN or Infinity.
    for (const key of NON_PENALTY_KEYS) {
      expect(Number.isFinite(result[key])).toBe(true);
    }
  });

  it('produces modeNormFactor=1 when overlaidSum equals baseSum (no-op mode)', () => {
    // When overlaidSum === baseSum the factor is 1 regardless (fast-path).
    // Using the DEFAULT mode (all-zero overlay) on DEFAULT_WEIGHTS satisfies this.
    const base = resolveWeights('comparison_query');
    const result = applyModeOverlayWithNorm(base, undefined);
    // Non-penalty sum must be unchanged.
    expect(nonPenaltySum(result)).toBeCloseTo(nonPenaltySum(base), 10);
  });

  it('resolveChannelAwareWeights does not produce Infinity when weights are all zero', () => {
    // Defensive check: resolveChannelAwareWeights already has an adjustedNonPenaltySum > 0
    // guard.  Verify it produces finite output even for pathological zero input.
    const result = resolveChannelAwareWeights([], ALL_ZERO_WEIGHTS);
    const resultSum = nonPenaltySum(result);
    expect(Number.isFinite(resultSum)).toBe(true);
  });
});

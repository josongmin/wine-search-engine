import { describe, it, expect } from 'vitest';
import {
  resolveChannelAwareWeights,
  DEFAULT_WEIGHTS,
  resolveWeights,
} from '../model/scoring-weights.js';
import type { ScoringWeights } from '../model/scoring-weights.js';
import type { RetrievalChannel } from '../../retrieval/model/retrieval-channel.js';
import { getModeWeights } from '../model/mode-weights.js';

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
    w.multilingualScore
  );
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
] as const;

function applyModeOverlayWithNorm(
  baseWeights: ScoringWeights,
  mode: Parameters<typeof getModeWeights>[0],
): ScoringWeights {
  const modeProfile = getModeWeights(mode);
  const overlaid: ScoringWeights = {
    ...baseWeights,
    semantic: Math.max(baseWeights.semantic, modeProfile.semanticWeight),
    popularity: Math.max(baseWeights.popularity, modeProfile.popularityWeight),
    attributeAlignment: Math.max(baseWeights.attributeAlignment, modeProfile.attributeAlignmentWeight),
    preferenceAlignment: Math.max(baseWeights.preferenceAlignment, modeProfile.preferenceAlignmentWeight),
    producerPrestige: Math.max(baseWeights.producerPrestige, modeProfile.producerPrestigeWeight),
    recency: Math.max(baseWeights.recency, modeProfile.recencyWeight),
  };
  const baseSum = NON_PENALTY_KEYS.reduce((s, k) => s + (baseWeights[k] ?? 0), 0);
  const overlaidSum = NON_PENALTY_KEYS.reduce((s, k) => s + (overlaid[k] ?? 0), 0);
  const normFactor = overlaidSum > 0 && overlaidSum !== baseSum ? baseSum / overlaidSum : 1;
  if (normFactor === 1) return overlaid;
  return {
    ...overlaid,
    entityIntegrity: overlaid.entityIntegrity * normFactor,
    anchorSimilarity: overlaid.anchorSimilarity * normFactor,
    semantic: overlaid.semantic * normFactor,
    softConstraint: overlaid.softConstraint * normFactor,
    attributeAlignment: overlaid.attributeAlignment * normFactor,
    preferenceAlignment: overlaid.preferenceAlignment * normFactor,
    popularity: overlaid.popularity * normFactor,
    availability: overlaid.availability * normFactor,
    producerPrestige: overlaid.producerPrestige * normFactor,
    recency: overlaid.recency * normFactor,
    criticScore: overlaid.criticScore * normFactor,
    multilingualScore: overlaid.multilingualScore * normFactor,
  };
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

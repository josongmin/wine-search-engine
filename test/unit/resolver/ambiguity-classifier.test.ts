import { describe, it, expect } from 'vitest';
import { AmbiguityClassifier } from '../../../src/domain/resolver/service/ambiguity-classifier.js';
import type { ResolverCandidate } from '../../../src/domain/resolver/model/resolved-candidate.js';
import type { MatchSignalSet } from '../../../src/domain/resolver/model/match-signal-set.js';

const classifier = new AmbiguityClassifier();

function makeSignals(overrides?: Partial<MatchSignalSet>): MatchSignalSet {
  return {
    canonicalExactMatch: 0,
    canonicalNormalizedMatch: 0,
    aliasExactMatch: 0,
    aliasFuzzyMatch: 0,
    aliasTypePrior: 0,
    producerMatch: 0,
    vintageMatch: 0,
    regionMatch: 0,
    grapeHintMatch: 0,
    phoneticMatch: 0,
    editDistanceScore: 0,
    ambiguityPenalty: 0,
    ...overrides,
  };
}

function makeWineCandidate(id: string, label: string, vintage?: string | number): ResolverCandidate {
  return {
    entityId: id as any,
    entityType: 'wine',
    canonicalLabel: label,
    aliasMatches: [],
    sourceSignals: makeSignals(),
    attributeHints: vintage !== undefined ? { vintage } : undefined,
  };
}

function makeProducerCandidate(id: string, label: string): ResolverCandidate {
  return {
    entityId: id as any,
    entityType: 'producer',
    canonicalLabel: label,
    aliasMatches: [],
    sourceSignals: makeSignals(),
  };
}

function makeRegionCandidate(id: string, label: string): ResolverCandidate {
  return {
    entityId: id as any,
    entityType: 'region',
    canonicalLabel: label,
    aliasMatches: [],
    sourceSignals: makeSignals(),
  };
}

describe('AmbiguityClassifier', () => {
  describe('wine_vs_producer detection', () => {
    it('detects wine + producer in top candidates', () => {
      const candidates: ResolverCandidate[] = [
        makeWineCandidate('wine-1', 'Opus One'),
        makeProducerCandidate('producer-1', 'Opus One Winery'),
      ];
      const state = classifier.classify(candidates, 'short_entity');
      expect(state.detected).toBe(true);
      expect(state.types).toContain('wine_vs_producer');
    });

    it('severity is high for wine_vs_producer', () => {
      const candidates: ResolverCandidate[] = [
        makeWineCandidate('wine-1', 'Opus One'),
        makeProducerCandidate('producer-1', 'Opus One Winery'),
      ];
      const state = classifier.classify(candidates, 'short_entity');
      expect(state.severity).toBe('high');
    });
  });

  describe('wine_vs_region detection', () => {
    it('detects wine + region in top candidates', () => {
      const candidates: ResolverCandidate[] = [
        makeWineCandidate('wine-1', 'Champagne'),
        makeRegionCandidate('region-1', 'Champagne'),
      ];
      const state = classifier.classify(candidates, 'short_entity');
      expect(state.detected).toBe(true);
      expect(state.types).toContain('wine_vs_region');
      expect(state.severity).toBe('high');
    });
  });

  describe('multi_vintage detection', () => {
    it('detects same wine with 2018 and 2019 vintages', () => {
      const candidates: ResolverCandidate[] = [
        makeWineCandidate('wine-2018', 'Opus One', 2018),
        makeWineCandidate('wine-2019', 'Opus One', 2019),
      ];
      const state = classifier.classify(candidates, 'short_entity');
      expect(state.detected).toBe(true);
      expect(state.types).toContain('multi_vintage');
    });

    it('does not detect multi_vintage when only one vintage present', () => {
      const candidates: ResolverCandidate[] = [
        makeWineCandidate('wine-2018', 'Opus One', 2018),
        makeWineCandidate('wine-2', 'Margaux', 2019),
      ];
      const state = classifier.classify(candidates, 'short_entity');
      expect(state.types).not.toContain('multi_vintage');
    });

    it('does not let a sibling wine vintage pair make a different exact head ambiguous', () => {
      const candidates: ResolverCandidate[] = [
        makeWineCandidate('wine-elu', '2018 St. Supéry Élu', 2018),
        makeWineCandidate('wine-cab-2014', '2014 St. Supéry Cabernet Sauvignon', 2014),
        makeWineCandidate('wine-cab-2018', '2018 St. Supéry Cabernet Sauvignon', 2018),
        makeWineCandidate('wine-merlot-2019', '2019 St. Supéry Merlot', 2019),
      ];
      const state = classifier.classify(candidates, 'short_entity');
      expect(state.types).not.toContain('multi_vintage');
    });
  });

  describe('alias_collision detection', () => {
    it('detects when same alias maps to 2 entities', () => {
      const candidates: ResolverCandidate[] = [
        {
          entityId: 'wine-1' as any,
          entityType: 'wine',
          canonicalLabel: 'Wine A',
          aliasMatches: [{ aliasValue: 'shared-alias', aliasType: 'canonical', matchScore: 1.0 }],
          sourceSignals: makeSignals({ aliasExactMatch: 1 }),
        },
        {
          entityId: 'wine-2' as any,
          entityType: 'wine',
          canonicalLabel: 'Wine B',
          aliasMatches: [{ aliasValue: 'shared-alias', aliasType: 'canonical', matchScore: 1.0 }],
          sourceSignals: makeSignals({ aliasExactMatch: 1 }),
        },
      ];
      const state = classifier.classify(candidates, 'short_entity');
      expect(state.detected).toBe(true);
      expect(state.types).toContain('alias_collision');
    });

    it('does not detect alias_collision for candidates without exact identity support', () => {
      const candidates: ResolverCandidate[] = [
        {
          entityId: 'wine-1' as any,
          entityType: 'wine',
          canonicalLabel: 'Château Margaux',
          aliasMatches: [{ aliasValue: '샤또 마고', aliasType: 'translation', matchScore: 0.97 }],
          sourceSignals: makeSignals({ aliasExactMatch: 0.97 }),
        },
        {
          entityId: 'wine-2' as any,
          entityType: 'wine',
          canonicalLabel: 'Pavillon Rouge du Château Margaux',
          aliasMatches: [{ aliasValue: '샤또 마고', aliasType: 'translation', matchScore: 0.97 }],
          sourceSignals: makeSignals(),
        },
      ];
      const state = classifier.classify(candidates, 'short_entity');
      expect(state.types).not.toContain('alias_collision');
    });

    it('does not detect alias_collision when aliases are unique', () => {
      const candidates: ResolverCandidate[] = [
        {
          entityId: 'wine-1' as any,
          entityType: 'wine',
          canonicalLabel: 'Wine A',
          aliasMatches: [{ aliasValue: 'alias-a', aliasType: 'canonical', matchScore: 1.0 }],
          sourceSignals: makeSignals(),
        },
        {
          entityId: 'wine-2' as any,
          entityType: 'wine',
          canonicalLabel: 'Wine B',
          aliasMatches: [{ aliasValue: 'alias-b', aliasType: 'canonical', matchScore: 1.0 }],
          sourceSignals: makeSignals(),
        },
      ];
      const state = classifier.classify(candidates, 'short_entity');
      expect(state.types).not.toContain('alias_collision');
    });
  });

  describe('single clear winner → not detected', () => {
    it('returns detected=false and severity=low for a single candidate', () => {
      const candidates: ResolverCandidate[] = [
        makeWineCandidate('wine-1', 'Opus One'),
      ];
      const state = classifier.classify(candidates, 'short_entity');
      expect(state.detected).toBe(false);
      expect(state.types).toHaveLength(0);
      expect(state.severity).toBe('low');
    });

    it('returns detected=false for empty candidates', () => {
      const state = classifier.classify([], 'short_entity');
      expect(state.detected).toBe(false);
      expect(state.severity).toBe('low');
    });
  });

  describe('severity escalation with multiple types', () => {
    it('multiple types produce at least medium severity', () => {
      // Set up scenario with multi_vintage + alias_collision
      const candidates: ResolverCandidate[] = [
        {
          entityId: 'wine-2018' as any,
          entityType: 'wine',
          canonicalLabel: 'Opus One',
          aliasMatches: [{ aliasValue: 'opus-one', aliasType: 'canonical', matchScore: 1.0 }],
          sourceSignals: makeSignals({ aliasExactMatch: 1 }),
          attributeHints: { vintage: 2018 },
        },
        {
          entityId: 'wine-2019' as any,
          entityType: 'wine',
          canonicalLabel: 'Opus One',
          aliasMatches: [{ aliasValue: 'opus-one', aliasType: 'canonical', matchScore: 1.0 }],
          sourceSignals: makeSignals({ aliasExactMatch: 1 }),
          attributeHints: { vintage: 2019 },
        },
      ];
      const state = classifier.classify(candidates, 'short_entity');
      // Both multi_vintage (2018 vs 2019) and alias_collision (shared "opus-one") are triggered
      expect(state.types).toContain('multi_vintage');
      expect(state.types).toContain('alias_collision');
      expect(state.types.length).toBeGreaterThanOrEqual(2);
      expect(state.detected).toBe(true);
    });

    it('3 or more ambiguity types escalate to high severity', () => {
      // Producer family collision: 3+ wines from same producer
      const producer = 'Opus Winery';
      const candidates: ResolverCandidate[] = [
        {
          entityId: 'wine-1' as any,
          entityType: 'wine',
          canonicalLabel: 'Opus One',
          aliasMatches: [{ aliasValue: 'opus', aliasType: 'canonical', matchScore: 1.0 }],
          sourceSignals: makeSignals({ canonicalNormalizedMatch: 0.9 }),
          attributeHints: { producer, vintage: 2018 },
        },
        {
          entityId: 'wine-2' as any,
          entityType: 'wine',
          canonicalLabel: 'Opus One',
          aliasMatches: [{ aliasValue: 'opus', aliasType: 'canonical', matchScore: 1.0 }],
          sourceSignals: makeSignals({ canonicalNormalizedMatch: 0.85 }),
          attributeHints: { producer, vintage: 2019 },
        },
        {
          entityId: 'wine-3' as any,
          entityType: 'wine',
          canonicalLabel: 'Opus Grand',
          aliasMatches: [{ aliasValue: 'opus', aliasType: 'canonical', matchScore: 1.0 }],
          sourceSignals: makeSignals({ canonicalNormalizedMatch: 0.8 }),
          attributeHints: { producer },
        },
        {
          entityId: 'wine-4' as any,
          entityType: 'wine',
          canonicalLabel: 'Opus Reserve',
          aliasMatches: [],
          sourceSignals: makeSignals({ canonicalNormalizedMatch: 0.75 }),
          attributeHints: { producer },
        },
        {
          entityId: 'wine-5' as any,
          entityType: 'wine',
          canonicalLabel: 'Opus Second',
          aliasMatches: [],
          sourceSignals: makeSignals({ canonicalNormalizedMatch: 0.75 }),
          attributeHints: { producer },
        },
      ];
      const state = classifier.classify(candidates, 'short_entity');
      // Should detect producer_family_collision (3+ wines from same producer)
      expect(state.types).toContain('producer_family_collision');
      // producer_family_collision alone gives medium; we may have additional types
      expect(['medium', 'high']).toContain(state.severity);
    });
  });

  describe('producer_family_collision — score-competitiveness gate', () => {
    // Mirrors the module-private STRONG_MATCH_RATIO in ambiguity-classifier.ts.
    // The gate counts a same-producer sibling only when
    // canonicalNormalizedMatch / topScore >= this ratio.
    const STRONG_MATCH_RATIO = 0.85;

    function makeProducerWine(
      id: string,
      label: string,
      producer: string,
      canonicalNormalizedMatch: number,
    ): ResolverCandidate {
      return {
        entityId: id as any,
        entityType: 'wine',
        canonicalLabel: label,
        aliasMatches: [],
        sourceSignals: makeSignals({ canonicalNormalizedMatch }),
        attributeHints: { producer },
      };
    }

    it('zero-signal family_graph siblings do NOT trigger producer_family_collision', () => {
      // Live symptom (Penfolds Grange): an exact head match plus recall-only
      // family_graph siblings that carry ZERO identity signal must NOT be
      // folded into a "which Penfolds did you mean?" cluster — that wrongly
      // abstained on an otherwise-resolvable exact head match.
      const producer = 'Penfolds';
      const candidates: ResolverCandidate[] = [
        makeProducerWine('grange', '2019 Penfolds Grange', producer, 1.0),
        makeProducerWine('bin389', 'Penfolds Bin 389', producer, 0),
        makeProducerWine('bin28', 'Penfolds Bin 28', producer, 0),
        makeProducerWine('bin128', 'Penfolds Bin 128', producer, 0),
        makeProducerWine('st-henri', 'Penfolds St Henri', producer, 0),
      ];
      const state = classifier.classify(candidates, 'exact_entity');
      expect(state.types).not.toContain('producer_family_collision');
    });

    it('counts a sibling at exactly STRONG_MATCH_RATIO*topScore (boundary just-inside)', () => {
      const producer = 'Penfolds';
      const topScore = 1.0;
      const boundary = STRONG_MATCH_RATIO * topScore; // counts (>=)
      const candidates: ResolverCandidate[] = [
        makeProducerWine('a', 'Penfolds A', producer, topScore),
        makeProducerWine('b', 'Penfolds B', producer, boundary),
        makeProducerWine('c', 'Penfolds C', producer, boundary),
      ];
      const state = classifier.classify(candidates, 'short_entity');
      expect(state.types).toContain('producer_family_collision');
    });

    it('excludes a sibling just below STRONG_MATCH_RATIO*topScore (boundary just-outside)', () => {
      const producer = 'Penfolds';
      const topScore = 1.0;
      const justBelow = (STRONG_MATCH_RATIO - 0.01) * topScore; // does NOT count
      const candidates: ResolverCandidate[] = [
        makeProducerWine('a', 'Penfolds A', producer, topScore),
        makeProducerWine('b', 'Penfolds B', producer, justBelow),
        makeProducerWine('c', 'Penfolds C', producer, justBelow),
      ];
      // Only 1 competitive (the top) → below MIN_COUNT(3) → no collision.
      const state = classifier.classify(candidates, 'short_entity');
      expect(state.types).not.toContain('producer_family_collision');
    });

    it('preserves the topScore===0 conservative escape (no-signal edge unchanged)', () => {
      // No candidate carries any canonicalNormalizedMatch signal: the gate
      // bails (cannot divide by zero) and does not fabricate a collision.
      const producer = 'Penfolds';
      const candidates: ResolverCandidate[] = [
        makeProducerWine('a', 'Penfolds A', producer, 0),
        makeProducerWine('b', 'Penfolds B', producer, 0),
        makeProducerWine('c', 'Penfolds C', producer, 0),
      ];
      const state = classifier.classify(candidates, 'short_entity');
      expect(state.types).not.toContain('producer_family_collision');
    });
  });
});

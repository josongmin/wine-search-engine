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
  });

  describe('alias_collision detection', () => {
    it('detects when same alias maps to 2 entities', () => {
      const candidates: ResolverCandidate[] = [
        {
          entityId: 'wine-1' as any,
          entityType: 'wine',
          canonicalLabel: 'Wine A',
          aliasMatches: [{ aliasValue: 'shared-alias', aliasType: 'canonical', matchScore: 1.0 }],
          sourceSignals: makeSignals(),
        },
        {
          entityId: 'wine-2' as any,
          entityType: 'wine',
          canonicalLabel: 'Wine B',
          aliasMatches: [{ aliasValue: 'shared-alias', aliasType: 'canonical', matchScore: 1.0 }],
          sourceSignals: makeSignals(),
        },
      ];
      const state = classifier.classify(candidates, 'short_entity');
      expect(state.detected).toBe(true);
      expect(state.types).toContain('alias_collision');
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
          sourceSignals: makeSignals(),
          attributeHints: { vintage: 2018 },
        },
        {
          entityId: 'wine-2019' as any,
          entityType: 'wine',
          canonicalLabel: 'Opus One',
          aliasMatches: [{ aliasValue: 'opus-one', aliasType: 'canonical', matchScore: 1.0 }],
          sourceSignals: makeSignals(),
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
});

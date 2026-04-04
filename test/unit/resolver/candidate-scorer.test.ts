import { describe, it, expect } from 'vitest';
import { CandidateScorer } from '../../../src/domain/resolver/service/candidate-scorer.js';
import type { ResolverCandidate } from '../../../src/domain/resolver/model/resolved-candidate.js';
import type { MatchSignalSet } from '../../../src/domain/resolver/model/match-signal-set.js';

const scorer = new CandidateScorer();

/** Creates a zero-filled MatchSignalSet with optional overrides. */
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

/** Creates a minimal ResolverCandidate. */
function makeCandidate(
  signals: MatchSignalSet,
  aliasMatches: ResolverCandidate['aliasMatches'] = [],
): ResolverCandidate {
  return {
    entityId: 'entity-1' as any,
    entityType: 'wine',
    canonicalLabel: 'Test Wine',
    aliasMatches,
    sourceSignals: signals,
  };
}

describe('CandidateScorer', () => {
  it('canonicalExactMatch=1.0 produces highest possible raw score component', () => {
    const signals = makeSignals({ canonicalExactMatch: 1.0 });
    const candidate = makeCandidate(signals);
    const score = scorer.score(candidate);
    // Weight for canonicalExactMatch is 1.0, so contribution = 1.0
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('all signals zero → score=0', () => {
    const signals = makeSignals();
    const candidate = makeCandidate(signals);
    expect(scorer.score(candidate)).toBe(0);
  });

  it('ambiguityPenalty reduces score', () => {
    const withoutPenalty = makeCandidate(makeSignals({ canonicalExactMatch: 1.0 }));
    const withPenalty = makeCandidate(makeSignals({ canonicalExactMatch: 1.0, ambiguityPenalty: 1.0 }));

    const scoreWithout = scorer.score(withoutPenalty);
    const scoreWith = scorer.score(withPenalty);
    // ambiguityPenalty weight = -0.8, so withPenalty score = 1.0 + (-0.8 * 1.0) = 0.2
    expect(scoreWith).toBeLessThan(scoreWithout);
    expect(scoreWith).toBeCloseTo(0.2, 5);
  });

  it('catalog_noise_alias match is capped at CATALOG_NOISE_ALIAS_CAP=0.3', () => {
    // Build a candidate that only has catalog_noise_alias match (no core match)
    const signals = makeSignals({ aliasExactMatch: 1.0 }); // full alias match signal
    const candidate: ResolverCandidate = {
      entityId: 'entity-1' as any,
      entityType: 'wine',
      canonicalLabel: 'Test Wine',
      aliasMatches: [
        { aliasValue: 'test', aliasType: 'catalog_noise_alias', matchScore: 1.0 },
      ],
      sourceSignals: signals,
    };
    const score = scorer.score(candidate);
    // aliasExactMatch should be capped at 0.3, so contribution = 0.8 * 0.3 = 0.24
    expect(score).toBeCloseTo(0.8 * 0.3, 5);
  });

  it('catalog_noise_alias is NOT capped when candidate also has a core alias match', () => {
    // Core alias (canonical type) present → no cap
    const signals = makeSignals({ aliasExactMatch: 1.0 });
    const candidate: ResolverCandidate = {
      entityId: 'entity-1' as any,
      entityType: 'wine',
      canonicalLabel: 'Test Wine',
      aliasMatches: [
        { aliasValue: 'noise', aliasType: 'catalog_noise_alias', matchScore: 1.0 },
        { aliasValue: 'Opus One', aliasType: 'canonical', matchScore: 1.0 },
      ],
      sourceSignals: signals,
    };
    const score = scorer.score(candidate);
    // No cap: aliasExactMatch = 1.0, contribution = 0.8 * 1.0 = 0.8
    expect(score).toBeCloseTo(0.8, 5);
  });

  it('producerMatch + vintageMatch combination scores correctly', () => {
    const signals = makeSignals({ producerMatch: 1.0, vintageMatch: 1.0 });
    const candidate = makeCandidate(signals);
    const score = scorer.score(candidate);
    // producerMatch weight=0.7 + vintageMatch weight=0.6 = 1.3
    expect(score).toBeCloseTo(1.3, 5);
  });

  it('all positive signals accumulate correctly', () => {
    const signals = makeSignals({
      canonicalExactMatch: 1.0,    // 1.0
      canonicalNormalizedMatch: 0, // 0
      aliasExactMatch: 0,
      producerMatch: 1.0,          // 0.7
      vintageMatch: 1.0,           // 0.6
      regionMatch: 1.0,            // 0.5
      ambiguityPenalty: 0,
    });
    const candidate = makeCandidate(signals);
    const score = scorer.score(candidate);
    expect(score).toBeCloseTo(1.0 + 0.7 + 0.6 + 0.5, 5);
  });

  it('negative ambiguityPenalty can push score below canonicalExactMatch contribution', () => {
    const signals = makeSignals({ canonicalExactMatch: 0.5, ambiguityPenalty: 1.0 });
    const candidate = makeCandidate(signals);
    const score = scorer.score(candidate);
    // 0.5 * 1.0 - 0.8 * 1.0 = 0.5 - 0.8 = -0.3
    expect(score).toBeCloseTo(-0.3, 5);
  });

  it('phoneticMatch and editDistanceScore contribute at expected weights', () => {
    const signals = makeSignals({ phoneticMatch: 1.0, editDistanceScore: 1.0 });
    const candidate = makeCandidate(signals);
    const score = scorer.score(candidate);
    // phoneticMatch=0.4 + editDistanceScore=0.3 = 0.7
    expect(score).toBeCloseTo(0.7, 5);
  });
});

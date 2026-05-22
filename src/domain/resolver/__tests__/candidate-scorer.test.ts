import { describe, it, expect } from 'vitest';
import { CandidateScorer } from '../service/candidate-scorer.js';
import type { ResolverCandidate } from '../model/resolved-candidate.js';
import type { MatchSignalSet } from '../model/match-signal-set.js';
import { createEntityId } from '../../shared/types/index.js';

// ── Fixture helpers ────────────────────────────────────────────────────────────

const ZERO_SIGNALS: MatchSignalSet = {
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
};

function makeCandidate(
  overrides: Partial<MatchSignalSet> = {},
  aliasTypes: Array<{ aliasValue: string; aliasType: ResolverCandidate['aliasMatches'][number]['aliasType']; matchScore: number }> = [],
): ResolverCandidate {
  return {
    entityId: createEntityId('entity-test'),
    entityType: 'wine',
    canonicalLabel: 'Test Wine',
    aliasMatches: aliasTypes,
    sourceSignals: { ...ZERO_SIGNALS, ...overrides },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('CandidateScorer', () => {
  const scorer = new CandidateScorer();

  describe('canonical exact match', () => {
    it('canonical exact match = 1.0 → highest possible single-signal score', () => {
      const candidate = makeCandidate({ canonicalExactMatch: 1.0 });
      const score = scorer.score(candidate);
      expect(score).toBe(1.0); // weight=1.0 * signal=1.0
    });

    it('canonical exact match produces higher score than alias exact match', () => {
      const canonicalCandidate = makeCandidate({ canonicalExactMatch: 1.0 });
      const aliasCandidate = makeCandidate({ aliasExactMatch: 1.0 }, [
        { aliasValue: 'opus one', aliasType: 'canonical', matchScore: 1.0 },
      ]);
      expect(scorer.score(canonicalCandidate)).toBeGreaterThan(scorer.score(aliasCandidate));
    });

    it('canonical normalized match produces lower score than exact match', () => {
      const exactCandidate = makeCandidate({ canonicalExactMatch: 1.0 });
      const normalizedCandidate = makeCandidate({ canonicalNormalizedMatch: 1.0 });
      expect(scorer.score(exactCandidate)).toBeGreaterThan(scorer.score(normalizedCandidate));
    });
  });

  describe('alias fuzzy match', () => {
    it('alias fuzzy match produces lower score than alias exact match', () => {
      const exactAlias = makeCandidate({ aliasExactMatch: 1.0 }, [
        { aliasValue: 'opus one', aliasType: 'canonical', matchScore: 1.0 },
      ]);
      const fuzzyAlias = makeCandidate({ aliasFuzzyMatch: 1.0 }, [
        { aliasValue: 'opusone', aliasType: 'canonical', matchScore: 0.9 },
      ]);
      expect(scorer.score(exactAlias)).toBeGreaterThan(scorer.score(fuzzyAlias));
    });
  });

  describe('catalog_noise_alias cap', () => {
    it('catalog_noise_alias aliasExactMatch is capped at 0.3', () => {
      const noisyCandidate = makeCandidate({ aliasExactMatch: 1.0 }, [
        { aliasValue: 'opous one', aliasType: 'catalog_noise_alias', matchScore: 1.0 },
      ]);
      const score = scorer.score(noisyCandidate);
      // With cap at 0.3: aliasExactMatch=0.3, weight=0.8 → contribution=0.24
      // Without cap: aliasExactMatch=1.0, weight=0.8 → contribution=0.8
      // Should be at most 0.3 * 0.8 = 0.24
      expect(score).toBeLessThanOrEqual(0.24 + 1e-10);
    });

    it('catalog_noise_alias cap (0.3) produces lower score than regular canonical match', () => {
      const noisyCandidate = makeCandidate({ aliasExactMatch: 1.0 }, [
        { aliasValue: 'opous one', aliasType: 'catalog_noise_alias', matchScore: 1.0 },
      ]);
      const canonicalCandidate = makeCandidate({ canonicalExactMatch: 1.0 });
      expect(scorer.score(canonicalCandidate)).toBeGreaterThan(scorer.score(noisyCandidate));
    });

    it('catalog_noise_alias cap not applied when core alias match also present', () => {
      // When a canonical alias match is also present, the cap is NOT applied
      const candidateWithCore = makeCandidate({ aliasExactMatch: 1.0 }, [
        { aliasValue: 'opous one', aliasType: 'catalog_noise_alias', matchScore: 1.0 },
        { aliasValue: 'opus one', aliasType: 'canonical', matchScore: 1.0 },
      ]);
      const score = scorer.score(candidateWithCore);
      // Without cap: 0.8 * 1.0 = 0.8
      expect(score).toBeCloseTo(0.8, 10);
    });
  });

  describe('ambiguityPenalty', () => {
    it('ambiguityPenalty subtracts from total score', () => {
      const withoutPenalty = makeCandidate({ canonicalExactMatch: 1.0, ambiguityPenalty: 0 });
      const withPenalty = makeCandidate({ canonicalExactMatch: 1.0, ambiguityPenalty: 0.5 });
      const diff = scorer.score(withoutPenalty) - scorer.score(withPenalty);
      // ambiguityPenalty weight = -0.8, so penalty=0.5 → diff = 0.8 * 0.5 = 0.4
      expect(diff).toBeCloseTo(0.4, 10);
    });

    it('full ambiguityPenalty (1.0) reduces score by 0.8', () => {
      const withPenalty = makeCandidate({ canonicalExactMatch: 1.0, ambiguityPenalty: 1.0 });
      // canonicalExactMatch: 1.0 * 1.0 = 1.0
      // ambiguityPenalty: -0.8 * 1.0 = -0.8
      // total = 0.2
      expect(scorer.score(withPenalty)).toBeCloseTo(0.2, 10);
    });
  });

  describe('all zero signals', () => {
    it('all zero signals → score = 0', () => {
      const candidate = makeCandidate();
      expect(scorer.score(candidate)).toBe(0);
    });
  });

  describe('weighted sum calculation', () => {
    it('multiple signals combine additively', () => {
      const candidate = makeCandidate({
        canonicalNormalizedMatch: 1.0, // 0.9
        producerMatch: 1.0,             // 0.7
        vintageMatch: 1.0,              // 0.6
      });
      // 0.9 + 0.7 + 0.6 = 2.2
      expect(scorer.score(candidate)).toBeCloseTo(2.2, 10);
    });

    it('producer match has correct weight 0.7', () => {
      const candidate = makeCandidate({ producerMatch: 1.0 });
      expect(scorer.score(candidate)).toBeCloseTo(0.7, 10);
    });

    it('region match has correct weight 0.5', () => {
      const candidate = makeCandidate({ regionMatch: 1.0 });
      expect(scorer.score(candidate)).toBeCloseTo(0.5, 10);
    });

    it('phonetic-only candidate is capped at PHONETIC_ONLY_CONTRIBUTION_CEILING (0.34), below the raw 0.4 weight', () => {
      // phoneticMatch weight is 0.4, but a phonetic-ONLY candidate (no
      // corroborating identity / alias / canonical / edit-distance lane) is
      // clamped to 0.34 by applyPhoneticOnlyCap (RFC-006 §5.4) so it can never
      // ALONE clear resolveTau. See candidate-scorer.ts isPhoneticOnlyBySignals.
      const candidate = makeCandidate({ phoneticMatch: 1.0 });
      expect(scorer.score(candidate)).toBeCloseTo(0.34, 10);
    });

    it('phonetic match contributes its full 0.4 weight when an identity lane stands the cap down', () => {
      // The moment a non-phonetic identity signal coexists (here aliasExactMatch),
      // the phonetic-only cap stands down and the phonetic lane contributes its
      // raw 0.4 weight: aliasExactMatch 0.8 + phoneticMatch 0.4 = 1.2.
      const candidate = makeCandidate({ aliasExactMatch: 1.0, phoneticMatch: 1.0 });
      expect(scorer.score(candidate)).toBeCloseTo(1.2, 10);
    });
  });

  describe('observed_query_alias cap', () => {
    it('observed_query_alias is capped at canonicalNormalizedMatch level', () => {
      const candidate = makeCandidate(
        { aliasExactMatch: 1.0, canonicalNormalizedMatch: 0.5 },
        [{ aliasValue: 'opone', aliasType: 'observed_query_alias', matchScore: 1.0 }],
      );
      const score = scorer.score(candidate);
      // aliasExactMatch capped at 0.5 (canonicalNormalizedMatch)
      // contribution: 0.5 * 0.8 = 0.4 (alias exact) + 0.9 * 0.5 = 0.45 (normalized)
      // = 0.85
      expect(score).toBeCloseTo(0.85, 10);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { CandidateScorer } from '../../../src/domain/resolver/service/candidate-scorer.js';
import type { ResolverCandidate, AliasMatchInfo } from '../../../src/domain/resolver/model/resolved-candidate.js';
import type { MatchSignalSet } from '../../../src/domain/resolver/model/match-signal-set.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';

// ---------------------------------------------------------------------------
// Constants mirrored from the implementation (do NOT import private values)
// ---------------------------------------------------------------------------

const WEIGHTS = {
  canonicalExactMatch: 1.0,
  canonicalNormalizedMatch: 0.9,
  aliasExactMatch: 0.8,
  aliasFuzzyMatch: 0.5,
  producerMatch: 0.7,
  vintageMatch: 0.6,
  regionMatch: 0.5,
  grapeHintMatch: 0.3,
  phoneticMatch: 0.4,
  editDistanceScore: 0.3,
  ambiguityPenalty: -0.8,
} as const;

const CATALOG_NOISE_ALIAS_CAP = 0.3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a zero-filled MatchSignalSet with optional overrides. */
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

/**
 * Builds a minimal {@link ResolverCandidate}.
 *
 * @param signals     - MatchSignalSet (will be zero-filled for unspecified fields).
 * @param aliasMatches - Alias matches that influence cap logic.
 */
function makeCandidate(
  signals: Partial<MatchSignalSet>,
  aliasMatches: readonly AliasMatchInfo[] = [],
  overrides?: Partial<ResolverCandidate>,
): ResolverCandidate {
  return {
    entityId: createEntityId('entity-test'),
    entityType: 'wine',
    canonicalLabel: 'Test Wine',
    aliasMatches,
    sourceSignals: makeSignals(signals),
    ...overrides,
  };
}

const scorer = new CandidateScorer();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CandidateScorer (extended)', () => {
  // -------------------------------------------------------------------------
  // Basic signal weight verifications
  // -------------------------------------------------------------------------

  describe('individual signal weights', () => {
    it('case 1 – all signals 0 → score = 0', () => {
      const candidate = makeCandidate({});
      expect(scorer.score(candidate)).toBe(0);
    });

    it('case 2 – only canonicalExactMatch=1 → score = 1.0 * 1.0 = 1.0', () => {
      const candidate = makeCandidate({ canonicalExactMatch: 1 });
      expect(scorer.score(candidate)).toBeCloseTo(WEIGHTS.canonicalExactMatch * 1.0, 10);
    });

    it('case 3 – only canonicalNormalizedMatch=1 → score = 0.9 * 1.0 = 0.9', () => {
      const candidate = makeCandidate({ canonicalNormalizedMatch: 1 });
      expect(scorer.score(candidate)).toBeCloseTo(WEIGHTS.canonicalNormalizedMatch * 1.0, 10);
    });

    it('case 4 – only aliasExactMatch=1 (no alias matches list) → score = 0.8 * 1.0 = 0.8', () => {
      // No aliasMatches array entries → no cap applied
      const candidate = makeCandidate({ aliasExactMatch: 1 });
      expect(scorer.score(candidate)).toBeCloseTo(WEIGHTS.aliasExactMatch * 1.0, 10);
    });

    it('case 5 – only aliasFuzzyMatch=1 (no alias matches list) → score = 0.5 * 1.0 = 0.5', () => {
      const candidate = makeCandidate({ aliasFuzzyMatch: 1 });
      expect(scorer.score(candidate)).toBeCloseTo(WEIGHTS.aliasFuzzyMatch * 1.0, 10);
    });

    it('case 6 – only ambiguityPenalty=1, all others 0 → score = -0.8', () => {
      const candidate = makeCandidate({ ambiguityPenalty: 1 });
      expect(scorer.score(candidate)).toBeCloseTo(WEIGHTS.ambiguityPenalty * 1.0, 10);
    });
  });

  // -------------------------------------------------------------------------
  // Combination: penalty reduces total
  // -------------------------------------------------------------------------

  describe('ambiguity penalty interaction', () => {
    it('case 7 – canonicalExact=1 + ambiguityPenalty=1 → score = 1.0 + (-0.8) = 0.2', () => {
      const candidate = makeCandidate({ canonicalExactMatch: 1, ambiguityPenalty: 1 });
      const expected = WEIGHTS.canonicalExactMatch * 1.0 + WEIGHTS.ambiguityPenalty * 1.0;
      // 1.0 + (-0.8) = 0.2
      expect(expected).toBeCloseTo(0.2, 10);
      expect(scorer.score(candidate)).toBeCloseTo(expected, 10);
    });
  });

  // -------------------------------------------------------------------------
  // catalog_noise_alias cap
  // -------------------------------------------------------------------------

  describe('catalog_noise_alias cap', () => {
    it('case 8 – catalog_noise_alias WITHOUT core match: aliasExactMatch=0.8 → effective signal = 0.3, contribution = 0.8*0.3 = 0.24', () => {
      // No canonical/translation/phonetic alias match → hasCoreAliasMatch=false
      // aliasExactMatch is capped at CATALOG_NOISE_ALIAS_CAP=0.3
      const candidate = makeCandidate(
        { aliasExactMatch: 0.8 },
        [{ aliasValue: 'noisy-alias', aliasType: 'catalog_noise_alias', matchScore: 0.8 }],
      );
      const score = scorer.score(candidate);
      // Effective aliasExactMatch = min(0.8, 0.3) = 0.3
      // Contribution = 0.8 (weight) * 0.3 (capped signal) = 0.24
      expect(score).toBeCloseTo(WEIGHTS.aliasExactMatch * CATALOG_NOISE_ALIAS_CAP, 10);
      expect(score).toBeCloseTo(0.24, 10);
    });

    it('case 9 – catalog_noise_alias WITH canonical alias match: aliasExactMatch=0.8 → NOT capped, contribution = 0.8*0.8 = 0.64', () => {
      // A 'canonical' alias match is present → hasCoreAliasMatch=true → no cap
      const candidate = makeCandidate(
        { aliasExactMatch: 0.8 },
        [
          { aliasValue: 'noisy-alias', aliasType: 'catalog_noise_alias', matchScore: 0.5 },
          { aliasValue: 'Opus One', aliasType: 'canonical', matchScore: 1.0 },
        ],
      );
      const score = scorer.score(candidate);
      // No cap: aliasExactMatch stays 0.8; contribution = 0.8 * 0.8 = 0.64
      expect(score).toBeCloseTo(WEIGHTS.aliasExactMatch * 0.8, 10);
      expect(score).toBeCloseTo(0.64, 10);
    });
  });

  // -------------------------------------------------------------------------
  // observed_query_alias cap
  // -------------------------------------------------------------------------

  describe('observed_query_alias cap', () => {
    it('case 10 – observed_query_alias WITHOUT core match, canonicalNormalizedMatch=0.6: aliasExactMatch=0.8 → capped to 0.6, contribution = 0.8*0.6 = 0.48', () => {
      // No canonical/translation/phonetic → hasCoreAliasMatch=false
      // aliasExactMatch is capped at canonicalNormalizedMatch=0.6 (not at CATALOG_NOISE_ALIAS_CAP)
      const candidate = makeCandidate(
        { aliasExactMatch: 0.8, canonicalNormalizedMatch: 0.6 },
        [{ aliasValue: 'observed-q', aliasType: 'observed_query_alias', matchScore: 0.8 }],
      );
      const score = scorer.score(candidate);
      // Effective aliasExactMatch = min(0.8, 0.6) = 0.6
      // aliasExact contribution = 0.8 * 0.6 = 0.48
      // canonicalNormalized contribution = 0.9 * 0.6 = 0.54
      const expectedAliasExact = WEIGHTS.aliasExactMatch * 0.6;    // 0.48
      const expectedCanonNorm  = WEIGHTS.canonicalNormalizedMatch * 0.6; // 0.54
      expect(score).toBeCloseTo(expectedAliasExact + expectedCanonNorm, 10);
    });

    it('does not cap observed_query_alias when a collision-free exact-safe certificate matched the raw query', () => {
      const candidate = makeCandidate(
        { aliasExactMatch: 0.8, canonicalNormalizedMatch: 0.6 },
        [{ aliasValue: '로마네꽁띠', aliasType: 'observed_query_alias', matchScore: 0.98 }],
        {
          identityCertificates: [{
            kind: 'exact_safe',
            normalizedSurface: '로마네꽁띠',
            sourceTier: 'curated',
            singleton: true,
            collisionFree: true,
          }],
        },
      );

      const score = scorer.score(candidate);
      const expectedAliasExact = WEIGHTS.aliasExactMatch * 0.8;
      const expectedCanonNorm = WEIGHTS.canonicalNormalizedMatch * 0.6;
      expect(score).toBeCloseTo(expectedAliasExact + expectedCanonNorm, 10);
    });
  });

  // -------------------------------------------------------------------------
  // Score ordering guarantee
  // -------------------------------------------------------------------------

  describe('score ordering', () => {
    it('case 11 – canonicalExact > canonicalNormalized > aliasExact (all other signals equal)', () => {
      // Each candidate has exactly ONE signal set to 1.0; everything else 0.
      // No alias matches list → no cap applies.
      const canonicalExact     = scorer.score(makeCandidate({ canonicalExactMatch: 1 }));
      const canonicalNormalized = scorer.score(makeCandidate({ canonicalNormalizedMatch: 1 }));
      const aliasExact          = scorer.score(makeCandidate({ aliasExactMatch: 1 }));

      // Weights: 1.0 > 0.9 > 0.8
      expect(canonicalExact).toBeCloseTo(1.0, 10);
      expect(canonicalNormalized).toBeCloseTo(0.9, 10);
      expect(aliasExact).toBeCloseTo(0.8, 10);

      expect(canonicalExact).toBeGreaterThan(canonicalNormalized);
      expect(canonicalNormalized).toBeGreaterThan(aliasExact);
    });
  });
});

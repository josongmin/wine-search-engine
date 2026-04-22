import { describe, expect, it } from 'vitest';
import { SignalComputer } from '../service/signal-computer.js';
import type { HybridCandidate } from '../../retrieval/model/hybrid-candidate.js';
import type { RetrievalPlan } from '../../retrieval/service/retrieval-plan-builder.js';

function makeCandidate(overrides: Partial<HybridCandidate> = {}): HybridCandidate {
  return {
    entityId: 'entity-1' as never,
    retrievalFusionScore: 0.08,
    matchedConstraints: [],
    retrievalTrace: {
      retrievalProfile: 'test',
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
      candidateSources: [],
    },
    ...overrides,
  };
}

describe('SignalComputer SOTA++ signals', () => {
  const computer = new SignalComputer();

  // ── computeProducerPrestige ──────────────────────────────────────────────────
  describe('computeProducerPrestige', () => {
    it('returns undefined when producerPrestige is absent', () => {
      expect(computer.computeProducerPrestige(makeCandidate())).toBeUndefined();
    });
    it('returns value as-is when in [0, 1]', () => {
      expect(computer.computeProducerPrestige(makeCandidate({ producerPrestige: 0.8 }))).toBeCloseTo(0.8);
    });
    it('clamps above 1 down to 1', () => {
      expect(computer.computeProducerPrestige(makeCandidate({ producerPrestige: 1.5 }))).toBe(1);
    });
    it('clamps below 0 up to 0', () => {
      expect(computer.computeProducerPrestige(makeCandidate({ producerPrestige: -0.2 }))).toBe(0);
    });
  });

  // ── computeRecency ───────────────────────────────────────────────────────────
  describe('computeRecency', () => {
    it('returns undefined when vintageYear is absent', () => {
      expect(computer.computeRecency(makeCandidate(), 2026)).toBeUndefined();
    });
    it('returns 1.0 when vintage equals reference year (age delta = 0)', () => {
      expect(computer.computeRecency(makeCandidate({ vintageYear: 2026 }), 2026)).toBeCloseTo(1.0);
    });
    it('returns ~0.5 after 8 years (half-life)', () => {
      const score = computer.computeRecency(makeCandidate({ vintageYear: 2018 }), 2026);
      expect(score).toBeCloseTo(0.5, 2);
    });
    it('returns near 0 for vintages older than 30 years', () => {
      const score = computer.computeRecency(makeCandidate({ vintageYear: 1990 }), 2026);
      expect(score).toBeLessThan(0.05);
    });
  });

  // ── computeCriticScore ───────────────────────────────────────────────────────
  describe('computeCriticScore', () => {
    it('returns undefined when criticScoreNormalized is absent', () => {
      expect(computer.computeCriticScore(makeCandidate())).toBeUndefined();
    });
    it('returns value as-is when in [0, 1]', () => {
      expect(computer.computeCriticScore(makeCandidate({ criticScoreNormalized: 0.92 }))).toBeCloseTo(0.92);
    });
    it('clamps out-of-range values', () => {
      expect(computer.computeCriticScore(makeCandidate({ criticScoreNormalized: 1.3 }))).toBe(1);
    });
  });

  // ── dual-lane identity substrate ───────────────────────────────────────────
  describe('dual-lane ranking signals', () => {
    it('preserves calibrated entity posterior when present', () => {
      expect(computer.computeEntityPosterior(makeCandidate({ entityPosteriorScore: 0.97 }))).toBeCloseTo(0.97);
    });

    it('returns undefined entity posterior when the candidate has no identity lane', () => {
      expect(computer.computeEntityPosterior(makeCandidate())).toBeUndefined();
    });

    it('returns canonical identity exactness tier with none as the absence sentinel', () => {
      expect(computer.computeIdentityExactnessTier(makeCandidate({ identityExactnessTier: 'alias_fuzzy' }))).toBe('alias_fuzzy');
      expect(computer.computeIdentityExactnessTier(makeCandidate())).toBe('none');
    });

    it('returns the topology-aware lane presence when present', () => {
      expect(computer.computeLanePresence(makeCandidate({ lanePresence: 'corroborated' }))).toBe('corroborated');
      expect(computer.computeLanePresence(makeCandidate())).toBeUndefined();
    });

    it('suppresses identity-lane substrate when topology is general_only', () => {
      const malformedGeneralOnly = makeCandidate({
        lanePresence: 'general_only',
        entityPosteriorScore: 0.99,
        identityExactnessTier: 'exact',
      });

      expect(computer.computeEntityPosterior(malformedGeneralOnly)).toBeUndefined();
      expect(computer.computeIdentityExactnessTier(malformedGeneralOnly)).toBe('none');
    });
  });

  // ── computeMultilingualScore ─────────────────────────────────────────────────
  describe('computeMultilingualScore', () => {
    it('returns 0 when query has no Hangul regardless of candidate searchTextKo', () => {
      expect(computer.computeMultilingualScore(makeCandidate({ searchTextKo: '한국어' }), false)).toBe(0);
    });
    it('returns 0 when query has Hangul but candidate has no searchTextKo', () => {
      expect(computer.computeMultilingualScore(makeCandidate(), true)).toBe(0);
    });
    it('returns 0 when query has Hangul but searchTextKo is empty string', () => {
      expect(computer.computeMultilingualScore(makeCandidate({ searchTextKo: '' }), true)).toBe(0);
    });
    it('returns 1 when query has Hangul AND candidate has non-empty searchTextKo', () => {
      expect(computer.computeMultilingualScore(makeCandidate({ searchTextKo: '오퍼스원' }), true)).toBe(1);
    });
  });
});

// ── SCAN4-01: computePopularity rank inversion fix ──────────────────────────
describe('SignalComputer.computePopularity (SCAN4-01)', () => {
  const computer = new SignalComputer();

  it('prefers explicit popularityScore over sparse-rank proxy when available', () => {
    expect(
      computer.computePopularity(makeCandidate({ popularityScore: 0.82, sparseRank: 50 })),
    ).toBeCloseTo(0.82, 5);
  });

  it('rank=1 (best sparse hit) produces higher popularity score than rank=10', () => {
    const rank1 = computer.computePopularity(makeCandidate({ sparseRank: 1 }));
    const rank10 = computer.computePopularity(makeCandidate({ sparseRank: 10 }));
    expect(rank1).toBeGreaterThan(rank10);
  });

  it('rank=1 produces score close to 1.0', () => {
    expect(computer.computePopularity(makeCandidate({ sparseRank: 1 }))).toBeCloseTo(1.0, 5);
  });

  it('popularity is monotonically decreasing as rank increases', () => {
    const scores = [1, 2, 3, 5, 10, 20].map(
      (r) => computer.computePopularity(makeCandidate({ sparseRank: r })),
    );
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i + 1] as number);
    }
  });

  it('returns baseline when sparseRank is absent', () => {
    const score = computer.computePopularity(makeCandidate());
    expect(score).toBeUndefined();
  });

  it('never produces NaN or out-of-[0,1] values', () => {
    for (const rank of [1, 2, 5, 10, 100]) {
      const score = computer.computePopularity(makeCandidate({ sparseRank: rank }));
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe('SignalComputer unsupported-signal omission', () => {
  const computer = new SignalComputer();

  it('omits semantic score when the candidate never went through fusion', () => {
    expect(computer.computeSemanticScore(makeCandidate({ fusionRrfTotal: undefined }))).toBeUndefined();
  });

  it('omits attribute alignment when the query has no structured expectations', () => {
    const score = computer.computeAttributeAlignment(
      makeCandidate({ matchedConstraints: [] }),
      {
        route: 'hybrid',
        queryClass: 'known_item',
        plannerVersion: 'test',
        policyRuleVersion: 'test',
        thresholdProfileId: 'default',
        queryTargetType: 'wine',
        intent: 'lookup_known_item',
        normalizedQuery: 'opus one',
        constraints: { hard: [], soft: [], inferred: [] },
        anchors: [],
        retrievalMode: 'known_item',
        explanation: '',
        ambiguitySignals: [],
        uncertainty: { overall: 0, ambiguitySignals: [], decisionEffect: 'trace_only' },
        policy: { requireExact: false, allowApproximate: true, clarificationBias: 0, fallbackMode: 'allow' },
      } as never,
    );
    expect(score).toBeUndefined();
  });

  it('omits preference alignment when no preference plane is wired', () => {
    expect(computer.computePreferenceAlignment()).toBeUndefined();
  });

  it('omits availability when the candidate has no availability field', () => {
    expect(computer.computeAvailability(makeCandidate())).toBeUndefined();
  });
});

describe('SignalComputer specialized signals', () => {
  const computer = new SignalComputer();

  it('computes set coverage from observed candidate metadata', () => {
    const coverage = computer.computeSetCoverage(
      [
        makeCandidate({ producer: 'Antinori', region: 'Tuscany' }),
        makeCandidate({ grapePrimary: 'Sangiovese', vintageYear: 2019 }),
      ],
      new Set(['antinori', 'sangiovese', 'bordeaux']),
    );

    expect(coverage).toBeCloseTo(2 / 3, 5);
  });

  it('maps explicit availability boolean to a ranking signal', () => {
    expect(computer.computeAvailability(makeCandidate({ availability: true }))).toBe(1);
    expect(computer.computeAvailability(makeCandidate({ availability: false }))).toBe(0);
  });

  it('computes anchor preservation from shared metadata and attribute similarity', () => {
    const score = computer.computeAnchorPreservation(
      makeCandidate({
        region: 'Napa Valley',
        grapePrimary: 'Cabernet Sauvignon',
        body: 4,
        tannin: 4,
        acidity: 3,
      }),
      makeCandidate({
        region: 'Napa Valley',
        grapePrimary: 'Cabernet Sauvignon',
        body: 4,
        tannin: 3,
        acidity: 3,
        retrievalFusionScore: 0.09,
      }),
    );

    expect(score).toBeGreaterThan(0.8);
  });

  it('uses structured retrieval-plan boosts for soft constraint scoring', () => {
    const retrievalPlan: RetrievalPlan = {
      hardFilterTokens: [],
      softBoosts: [
        {
          attribute: 'region',
          operator: '=',
          value: 'Bordeaux',
          weight: 0.9,
          source: 'test',
        },
      ],
      inferredBoosts: [
        {
          attribute: 'grape_family',
          operator: 'in',
          value: ['Cabernet', 'Merlot'],
          weight: 0.7,
          source: 'test',
        },
      ],
      sensoryPriors: [],
      planVersion: 'test',
    };

    const score = computer.computeSoftConstraint(
      makeCandidate({ matchedConstraints: ['region', 'grape_family'] }),
      { hard: [], soft: [], inferred: [] },
      retrievalPlan,
    );

    expect(score).toBeCloseTo(1, 5);
  });

  it('does not double-count duplicated soft constraints when retrievalPlan mirrors bundle.soft', () => {
    const retrievalPlan: RetrievalPlan = {
      hardFilterTokens: [],
      softBoosts: [
        {
          attribute: 'region',
          operator: '=',
          value: 'Bordeaux',
          weight: 0.9,
          source: 'test',
        },
      ],
      inferredBoosts: [],
      sensoryPriors: [],
      planVersion: 'test',
    };

    const score = computer.computeSoftConstraint(
      makeCandidate({ matchedConstraints: ['region'] }),
      {
        hard: [],
        soft: [
          {
            attribute: 'region',
            operator: '=',
            value: 'Bordeaux',
            source_phrase: '보르도',
            confidence: 0.9,
            mapping_version: 'test',
          },
        ],
        inferred: [],
      },
      retrievalPlan,
    );

    expect(score).toBeCloseTo(1, 5);
  });

  it('treats non-evaluable soft style constraints as neutral during soft scoring', () => {
    const score = computer.computeSoftConstraint(
      makeCandidate({ matchedConstraints: ['style'] }),
      {
        hard: [],
        soft: [
          {
            attribute: 'style',
            operator: 'in',
            value: 'presentation_forward',
            source_phrase: '예쁜 라벨',
            confidence: 0.8,
            mapping_version: 'test',
          },
        ],
        inferred: [],
      },
    );

    expect(score).toBeCloseTo(1.0, 5);
  });
});

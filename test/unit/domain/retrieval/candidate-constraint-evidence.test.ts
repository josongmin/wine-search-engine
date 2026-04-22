import { describe, expect, it } from 'vitest';
import { annotateCandidateConstraintEvidence } from '../../../../src/domain/retrieval/service/candidate-constraint-evidence.js';
import { createEntityId, type ConstraintBundle } from '../../../../src/domain/shared/types/index.js';
import type { HybridCandidate } from '../../../../src/domain/retrieval/model/hybrid-candidate.js';

function makeCandidate(overrides: Partial<HybridCandidate> = {}): HybridCandidate {
  return {
    entityId: createEntityId('wine-1'),
    canonicalLabel: 'Opus One 2018',
    producer: 'Opus One',
    region: 'Napa Valley',
    grapePrimary: 'Cabernet Sauvignon',
    style: 'bold red',
    priceBand: 'premium',
    certifications: ['organic', 'biodynamic'],
    country: 'United States',
    appellation: 'Napa Valley',
    vintageYear: 2018,
    body: 5,
    sweetness: 1,
    wineType: 'red',
    fusionRrfTotal: 0.42,
    sparseRawScore: 0.42,
    matchedConstraints: [],
    retrievalTrace: {
      retrievalProfile: 'fusion',
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
      candidateSources: ['sparse_bm25'],
    },
    ...overrides,
  };
}

describe('candidate constraint evidence', () => {
  it('annotates hard, soft, and inferred matches directly from candidate attributes', () => {
    const constraints: ConstraintBundle = {
      hard: [
        {
          attribute: 'wine_type',
          operator: '=',
          value: 'red',
          source_phrase: 'red',
          confidence: 1,
        },
        {
          attribute: 'price_band',
          operator: '=',
          value: 'premium',
          source_phrase: 'premium',
          confidence: 1,
        },
      ],
      soft: [
        {
          attribute: 'country',
          operator: '=',
          value: 'United States',
          source_phrase: 'us',
          confidence: 0.7,
        },
      ],
      inferred: [
        {
          attribute: 'appellation',
          operator: '=',
          value: 'Napa Valley',
          source_phrase: 'napa',
          confidence: 0.6,
        },
      ],
    };

    const annotated = annotateCandidateConstraintEvidence(makeCandidate(), constraints);

    expect(annotated.matchedConstraints).toEqual(
      expect.arrayContaining(['wine_type', 'price_band', 'country', 'appellation']),
    );
    expect(annotated.unmetHardConstraints).toBeUndefined();
  });

  it('preserves multi-value in semantics without collapsing to the first value', () => {
    const constraints: ConstraintBundle = {
      hard: [
        {
          attribute: 'certification',
          operator: 'in',
          value: ['organic', 'natural'],
          source_phrase: 'organic or natural',
          confidence: 0.8,
        },
      ],
      soft: [],
      inferred: [],
    };

    const annotated = annotateCandidateConstraintEvidence(makeCandidate(), constraints);
    expect(annotated.matchedConstraints).toContain('certification');
    expect(annotated.unmetHardConstraints).toBeUndefined();
  });

  it('records unmet hard constraints when candidate attributes disagree', () => {
    const constraints: ConstraintBundle = {
      hard: [
        {
          attribute: 'wine_type',
          operator: '=',
          value: 'white',
          source_phrase: 'white',
          confidence: 1,
        },
      ],
      soft: [],
      inferred: [],
    };

    const annotated = annotateCandidateConstraintEvidence(makeCandidate(), constraints);
    expect(annotated.matchedConstraints).not.toContain('wine_type');
    expect(annotated.unmetHardConstraints).toEqual(['wine_type']);
  });
});

describe('evaluateOperator NaN safety (CLAUDE.md schema quality bar)', () => {
  // NaN is typeof 'number' but any comparison with NaN returns false.
  // The type guard `typeof attrValue === 'number'` passes NaN, which would
  // silently fail every constraint check — wine is dropped even if it satisfies.
  it('R-NAN-OP-01: NaN attribute value correctly fails <= constraint (not silently wrong)', () => {
    const constraints: ConstraintBundle = {
      hard: [
        {
          attribute: 'price_usd',
          operator: '<=',
          value: 100,
          source_phrase: 'under 100',
          confidence: 1,
        },
      ],
      soft: [],
      inferred: [],
    };
    const candidate = makeCandidate({ priceUsd: NaN });
    const annotated = annotateCandidateConstraintEvidence(candidate, constraints);
    // NaN priceUsd must fail the constraint — not match it
    expect(annotated.matchedConstraints).not.toContain('price_usd');
    expect(annotated.unmetHardConstraints).toContain('price_usd');
  });

  it('R-NAN-OP-02: NaN attribute value correctly fails >= constraint', () => {
    const constraints: ConstraintBundle = {
      hard: [
        {
          attribute: 'critic_score_normalized',
          operator: '>=',
          value: 0.9,
          source_phrase: '90 points',
          confidence: 1,
        },
      ],
      soft: [],
      inferred: [],
    };
    const candidate = makeCandidate({ criticScoreNormalized: NaN });
    const annotated = annotateCandidateConstraintEvidence(candidate, constraints);
    expect(annotated.matchedConstraints).not.toContain('critic_score_normalized');
    expect(annotated.unmetHardConstraints).toContain('critic_score_normalized');
  });

  it('R-NAN-OP-03: NaN attribute value correctly fails range constraint', () => {
    const constraints: ConstraintBundle = {
      hard: [
        {
          attribute: 'alcohol_pct',
          operator: 'range',
          value: { min: 12, max: 15 },
          source_phrase: '12-15%',
          confidence: 1,
        },
      ],
      soft: [],
      inferred: [],
    };
    const candidate = makeCandidate({ alcoholPct: NaN });
    const annotated = annotateCandidateConstraintEvidence(candidate, constraints);
    expect(annotated.matchedConstraints).not.toContain('alcohol_pct');
    expect(annotated.unmetHardConstraints).toContain('alcohol_pct');
  });

  it('R-NAN-OP-04: valid finite value still satisfies range constraint (regression)', () => {
    const constraints: ConstraintBundle = {
      hard: [
        {
          attribute: 'alcohol_pct',
          operator: 'range',
          value: { min: 12, max: 15 },
          source_phrase: '12-15%',
          confidence: 1,
        },
      ],
      soft: [],
      inferred: [],
    };
    const candidate = makeCandidate({ alcoholPct: 13.5 });
    const annotated = annotateCandidateConstraintEvidence(candidate, constraints);
    expect(annotated.matchedConstraints).toContain('alcohol_pct');
  });
});

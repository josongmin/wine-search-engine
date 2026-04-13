import { describe, expect, it } from 'vitest';
import { ConstraintOverlay } from '../../../../src/domain/mixed/service/constraint-overlay.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

function makeRankedResult() {
  return {
    entityId: createEntityId('candidate-1'),
    canonicalLabel: 'Candidate',
    finalScore: 0.7,
    rank: 1,
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
    evidenceItems: [],
    componentScores: {
      entityIntegrity: 1,
      semantic: 0.5,
      hardConstraintPass: true,
      softConstraint: 0.5,
      attributeAlignment: 0.5,
      preferenceAlignment: 0.5,
      popularity: 0.5,
      availability: 1,
      uncertaintyPenalty: 0,
    },
  } as const;
}

describe('ConstraintOverlay', () => {
  it('fails closed when hard constraints cannot be verified because attributes are missing', () => {
    const overlay = new ConstraintOverlay();
    const results = overlay.apply(
      [makeRankedResult()],
      {
        hard: [{
          attribute: 'price_band',
          operator: '=',
          value: 'premium',
          source_phrase: '고급',
          confidence: 0.9,
        }],
        soft: [],
        inferred: [],
      },
      new Map(),
    );

    expect(results).toEqual([]);
  });

  it('fails closed when exclude constraints cannot be verified because attributes are missing', () => {
    const overlay = new ConstraintOverlay();
    const results = overlay.apply(
      [makeRankedResult()],
      {
        hard: [],
        soft: [{
          attribute: 'country',
          operator: 'exclude',
          value: 'france',
          source_phrase: '프랑스 말고',
          confidence: 0.9,
        }],
        inferred: [],
      },
      new Map(),
    );

    expect(results).toEqual([]);
  });
});

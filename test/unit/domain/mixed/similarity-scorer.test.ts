import { describe, expect, it } from 'vitest';
import { SimilarityScorer } from '../../../../src/domain/mixed/service/similarity-scorer.js';
import type { AnchorProfile } from '../../../../src/domain/mixed/model/anchor-profile.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

const scorer = new SimilarityScorer();

const anchor: AnchorProfile = {
  entityId: createEntityId('anchor-1'),
  canonicalLabel: 'Anchor Wine',
  region: 'Napa Valley',
  grapes: ['Cabernet Sauvignon'],
  body: 0.7,
  sweetness: 0.2,
  style: 'bold red',
  embedding: [0.1, 0.2, 0.3],
  anchorConfidence: 0.9,
};

describe('SimilarityScorer', () => {
  it('treats missing body/sweetness/embedding as explicit absence instead of neutral 0.5', () => {
    expect(scorer.computeBodySweetnessProximity(undefined, 0.4, 0.7, 0.2)).toBeUndefined();
    expect(scorer.computeEmbeddingSimilarity(undefined, anchor.embedding)).toBeUndefined();
    expect(scorer.computeEmbeddingSimilarity(anchor.embedding, undefined)).toBeUndefined();
  });

  it('downweights candidates with missing mixed-ranking signals instead of averaging them to midpoint', () => {
    const candidate = {
      region: 'Napa Valley',
      grapes: ['Cabernet Sauvignon'],
      style: 'bold red',
    };

    expect(scorer.score(candidate, anchor)).toBeCloseTo(0.65, 10);
  });
});

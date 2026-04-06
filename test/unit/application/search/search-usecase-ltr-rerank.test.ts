import { describe, expect, it } from 'vitest';
import { applyLtrRerankIfAvailable } from '../../../../src/application/search/search-usecase-ltr-rerank.js';
import type { QueryClassWeights } from '../../../../src/domain/ranking/index.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

function createRankedResult(
  entityId: string,
  rank: number,
  semantic: number,
) {
  return {
    entityId,
    canonicalLabel: `${entityId}-${rank}`,
    finalScore: semantic,
    rank,
    componentScores: {
      entityIntegrity: 1,
      semantic,
      hardConstraintPass: true,
      softConstraint: 0,
      attributeAlignment: 0,
      preferenceAlignment: 0,
      popularity: 0,
      availability: 1,
      uncertaintyPenalty: 0,
    },
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
    evidenceItems: [],
  };
}

describe('applyLtrRerankIfAvailable', () => {
  it('preserves duplicate entity ids instead of overwriting them during rerank', () => {
    const duplicateId = createEntityId('duplicate');
    const rankedResults = [
      createRankedResult(duplicateId, 1, 0.3),
      createRankedResult(duplicateId, 2, 0.8),
      createRankedResult(createEntityId('unique'), 3, 0.2),
    ];
    const ltrModels = new Map<string, QueryClassWeights>([
      [
        'known_item',
        {
          queryClass: 'known_item',
          weights: [1, 0, 0, 0, 0, 0, 0, 0],
          bias: 0,
          trainingExampleCount: 1,
          ndcg5ValidationScore: 1,
          trainedAt: new Date('2026-04-06T00:00:00.000Z'),
        },
      ],
    ]);

    const reranked = applyLtrRerankIfAvailable(
      rankedResults as never,
      'known_item' as never,
      ltrModels,
    );

    expect(reranked).toHaveLength(3);
    expect(reranked.filter((result) => result.entityId === duplicateId)).toHaveLength(2);
  });
});

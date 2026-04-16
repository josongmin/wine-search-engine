import { describe, expect, it } from 'vitest';
import { createEntityId } from '../../../shared/types/index.js';
import type { RankedResult } from '../../model/ranked-result.js';
import { DefaultRankingPolicy } from '../default-ranking-policy.js';

function makeResult(
  id: string,
  rank: number,
  wineType: string,
  producer = `${wineType}-producer-${rank}`,
): RankedResult {
  return {
    entityId: createEntityId(id),
    canonicalLabel: id,
    finalScore: 1 - rank * 0.01,
    rank,
    componentScores: {
      entityIntegrity: 1,
      hardConstraintPass: true,
      softConstraint: 0.8,
      uncertaintyPenalty: 0,
    },
    evidenceItems: [],
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
    producer,
    wineType,
  };
}

describe('DefaultRankingPolicy', () => {
  it('demotes excess same-wine-type results for semantic preference queries without explicit wine_type constraint', () => {
    const policy = new DefaultRankingPolicy();
    const results: RankedResult[] = [
      makeResult('red-1', 1, 'red'),
      makeResult('red-2', 2, 'red'),
      makeResult('red-3', 3, 'red'),
      makeResult('white-1', 4, 'white'),
      makeResult('sparkling-1', 5, 'sparkling'),
    ];

    const output = policy.apply(results, {
      queryClass: 'semantic_preference',
      effectiveRoute: 'hybrid',
      hasExplicitWineTypeConstraint: false,
    });

    expect(output.map((result) => String(result.entityId))).toEqual([
      String(results[0]!.entityId),
      String(results[1]!.entityId),
      String(results[3]!.entityId),
      String(results[4]!.entityId),
      String(results[2]!.entityId),
    ]);
  });

  it('does not demote by wine type when the user explicitly constrained wine_type', () => {
    const policy = new DefaultRankingPolicy();
    const results: RankedResult[] = [
      makeResult('red-1', 1, 'red'),
      makeResult('red-2', 2, 'red'),
      makeResult('red-3', 3, 'red'),
      makeResult('white-1', 4, 'white'),
    ];

    const output = policy.apply(results, {
      queryClass: 'semantic_preference',
      effectiveRoute: 'hybrid',
      hasExplicitWineTypeConstraint: true,
    });

    expect(output.map((result) => String(result.entityId))).toEqual(
      results.map((result) => String(result.entityId)),
    );
  });

  it('promotes a missing wine type from the tail when the top window is concentrated', () => {
    const policy = new DefaultRankingPolicy();
    const results: RankedResult[] = [
      makeResult('red-1', 1, 'red'),
      makeResult('red-2', 2, 'red'),
      makeResult('red-3', 3, 'red'),
      makeResult('red-4', 4, 'red'),
      makeResult('white-1', 5, 'white'),
      makeResult('sparkling-1', 6, 'sparkling'),
      makeResult('rose-1', 7, 'rosé'),
      makeResult('white-2', 8, 'white'),
      makeResult('sparkling-2', 9, 'sparkling'),
      makeResult('red-5', 10, 'red'),
      makeResult('white-tail', 11, 'white'),
    ];

    const output = policy.apply(results, {
      queryClass: 'semantic_preference',
      effectiveRoute: 'hybrid',
      hasExplicitWineTypeConstraint: false,
    });

    expect(output.slice(0, 5).map((result) => String(result.entityId))).toEqual([
      String(results[0]!.entityId),
      String(results[1]!.entityId),
      String(results[4]!.entityId),
      String(results[5]!.entityId),
      String(results[6]!.entityId),
    ]);
  });
});

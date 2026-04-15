/**
 * Regression: T-E6-03 — Provenance-Consistent Result Score Projection
 *
 * Entity-route results must project entity-native scores (from
 * ScoreDecomposition), NOT the synthetic componentScores that the
 * entity route builds as a compatibility shim for the heuristic ranker.
 *
 * Hybrid-route results must project from the ranking pipeline's
 * componentScores as before.
 *
 * Previously, both routes used the same generic projection, causing
 * entity-route results to display the resolver's calibratedScore as
 * "semantic" and all other components as 0.
 *
 * These tests are append-only (regression suite rules). Never delete.
 */

import { describe, it, expect } from 'vitest';
import { mapRankedResultsToResultItems } from '../../src/application/search/search-usecase-map-result-items.js';
import type { RankedResult } from '../../src/domain/ranking/model/ranked-result.js';
import type { ScoreDecomposition } from '../../src/domain/ranking/model/score-decomposition.js';

// ─── Entity-route result fixture ─────────────────────────────────────────────

function makeEntityRouteRankedResult(): RankedResult {
  const scoreDecomposition: ScoreDecomposition = {
    lexicalContribution: 0.9,
    semanticContribution: 0.97,
    anchorContribution: 0,
    attributeSatisfaction: 0,
    popularityContribution: 0,
    preferenceAlignmentContribution: 0,
    heuristicScoreRaw: 0.97,
    heuristicScoreNormalized: 0.97,
    finalScore: 0.97,
  };

  return {
    entityId: 'wine-entity-route-1',
    canonicalLabel: '2014 Kalaris Merlot',
    finalScore: 0.97,
    rank: 1,
    componentScores: {
      entityIntegrity: 1,
      semantic: 0.97, // This is the calibratedScore — NOT embedding similarity
      hardConstraintPass: true,
      softConstraint: 0,
      attributeAlignment: 0,
      preferenceAlignment: 0,
      popularity: 0,
      availability: 0,
      uncertaintyPenalty: 0,
    },
    evidenceItems: [
      {
        type: 'identity',
        source: 'entity_resolver',
        contribution: '+0.97',
        strength: 'high',
        provenance: 'Entity resolved via alias match (wine-entity-route-1)',
        metadata: {
          matchType: 'alias_exact',
          matchedAlias: 'Kalaris Merlot',
          aliasType: 'canonical',
          aliasScore: 0.95,
        },
      },
    ],
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
    scoreDecomposition,
  };
}

// ─── Hybrid-route result fixture ─────────────────────────────────────────────

function makeHybridRouteRankedResult(): RankedResult {
  return {
    entityId: 'wine-hybrid-route-1',
    canonicalLabel: 'Opus One 2018',
    finalScore: 0.85,
    rank: 1,
    componentScores: {
      entityIntegrity: 1,
      semantic: 0.8,
      hardConstraintPass: true,
      softConstraint: 0.3,
      attributeAlignment: 0.7,
      preferenceAlignment: 0.5,
      popularity: 0.4,
      availability: 1,
      uncertaintyPenalty: 0.05,
    },
    evidenceItems: [
      {
        type: 'lexical_match',
        source: 'vespa_retrieval',
        contribution: '+0.42',
        strength: 'high',
        provenance: 'Matched canonical label',
      },
    ],
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
  };
}

// ─── Test 1: Entity route → entity-native projection ─────────────────────────

describe('T-E6-03 Provenance Score Projection: entity route', () => {
  it('projects scoreComponents from entity-native ScoreDecomposition, not synthetic componentScores', async () => {
    const entityResult = makeEntityRouteRankedResult();
    const results = await mapRankedResultsToResultItems(
      [entityResult],
      undefined,
      2025,
    );

    expect(results).toHaveLength(1);
    const item = results[0]!;

    // Entity route: lexical comes from ScoreDecomposition.lexicalContribution (0.9)
    expect(item.match.scoreComponents.lexical).toBeCloseTo(0.9, 2);
    // Entity route: semantic comes from ScoreDecomposition.semanticContribution (0.97)
    expect(item.match.scoreComponents.semantic).toBeCloseTo(0.97, 2);
    // Entity route: attribute/popularity are from decomposition (all 0);
    // preferenceAlignment key is omitted when the decomposition contribution
    // is exactly 0 (exactOptionalPropertyTypes — key absent, not `undefined`).
    expect(item.match.scoreComponents.attribute).toBe(0);
    expect(item.match.scoreComponents.popularity).toBe(0);
    expect(item.match.scoreComponents.preferenceAlignment).toBeUndefined();
  });

  it('matchType derives from identity evidence metadata', async () => {
    const entityResult = makeEntityRouteRankedResult();
    const results = await mapRankedResultsToResultItems(
      [entityResult],
      undefined,
      2025,
    );

    expect(results[0]!.match.matchType).toBe('alias_exact');
  });
});

// ─── Test 2: Hybrid route → ranking pipeline projection ──────────────────────

describe('T-E6-03 Provenance Score Projection: hybrid route', () => {
  it('projects scoreComponents from componentScores for hybrid-route results', async () => {
    const hybridResult = makeHybridRouteRankedResult();
    const results = await mapRankedResultsToResultItems(
      [hybridResult],
      undefined,
      2025,
    );

    expect(results).toHaveLength(1);
    const item = results[0]!;

    // Hybrid route: scores come from componentScores
    expect(item.match.scoreComponents.semantic).toBe(0.8);
    expect(item.match.scoreComponents.attribute).toBe(0.7);
    expect(item.match.scoreComponents.popularity).toBe(0.4);
    expect(item.match.scoreComponents.preferenceAlignment).toBe(0.5);
  });
});

// ─── Test 3: Mixed results — both routes in one batch ────────────────────────

describe('T-E6-03 Provenance Score Projection: mixed batch', () => {
  it('applies correct projection per-result in a mixed entity+hybrid batch', async () => {
    const entityResult = makeEntityRouteRankedResult();
    const hybridResult = makeHybridRouteRankedResult();

    const results = await mapRankedResultsToResultItems(
      [entityResult, hybridResult],
      undefined,
      2025,
    );

    expect(results).toHaveLength(2);

    // Entity route result: decomposition projection
    const entityItem = results[0]!;
    expect(entityItem.match.scoreComponents.lexical).toBeCloseTo(0.9, 2);
    expect(entityItem.match.scoreComponents.attribute).toBe(0);

    // Hybrid route result: componentScores projection
    const hybridItem = results[1]!;
    expect(hybridItem.match.scoreComponents.attribute).toBe(0.7);
    expect(hybridItem.match.scoreComponents.semantic).toBe(0.8);
  });
});

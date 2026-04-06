import { describe, expect, it } from 'vitest';
import { SignalComputer } from '../service/signal-computer.js';
import type { HybridCandidate } from '../../retrieval/model/hybrid-candidate.js';

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
});

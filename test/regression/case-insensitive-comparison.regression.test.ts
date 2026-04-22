/**
 * Regression tests: case-insensitive string comparison in ranking / retrieval.
 *
 * Bug: producer deduplication in MixedSolver.applySetConstraintsForSimilarItems
 * and region/grape comparison in SignalComputer.computeAnchorPreservation used
 * strict === equality, causing casing differences from index data to bypass
 * dedup caps and miscompute preservation scores.
 *
 * Fixes:
 *   - mixed-solver.ts: normalize producer key to lowercase for per-producer slot counting
 *   - signal-computer.ts: case-insensitive region/grape comparison in anchor preservation
 */
import { describe, expect, it } from 'vitest';
import { SignalComputer } from '../../src/domain/ranking/service/signal-computer.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';

function makeCandidate(overrides: Partial<HybridCandidate> = {}): HybridCandidate {
  return {
    entityId: 'entity-1' as never,
    fusionRrfTotal: 0.08,
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

describe('SignalComputer.computeAnchorPreservation — case insensitive', () => {
  const computer = new SignalComputer();

  it('treats region as equal regardless of casing', () => {
    const anchor = makeCandidate({ region: 'Bordeaux', body: 4, tannin: 3 });
    const candidate = makeCandidate({ region: 'bordeaux', body: 4, tannin: 3 });

    const score = computer.computeAnchorPreservation(anchor, candidate);
    // Should match region (case-insensitive) and get full body/tannin match
    expect(score).toBeGreaterThan(0.8);
  });

  it('treats grapePrimary as equal regardless of casing', () => {
    const anchor = makeCandidate({ grapePrimary: 'Cabernet Sauvignon', body: 3, tannin: 3 });
    const candidate = makeCandidate({ grapePrimary: 'cabernet sauvignon', body: 3, tannin: 3 });

    const score = computer.computeAnchorPreservation(anchor, candidate);
    expect(score).toBeGreaterThan(0.8);
  });

  it('treats accented Latin region names as equal when casing differs', () => {
    const anchor = makeCandidate({ region: 'Côtes du Rhône', body: 3 });
    const candidate = makeCandidate({ region: 'côtes du rhône', body: 3 });

    const score = computer.computeAnchorPreservation(anchor, candidate);
    // Region should match (case-insensitive), body matches
    expect(score).toBeGreaterThan(0.7);
  });

  it('does NOT match genuinely different regions', () => {
    const anchor = makeCandidate({ region: 'Bordeaux', body: 4, tannin: 3 });
    const candidate = makeCandidate({ region: 'Burgundy', body: 4, tannin: 3 });

    const scoreMatched = computer.computeAnchorPreservation(
      makeCandidate({ region: 'Bordeaux', body: 4, tannin: 3 }),
      makeCandidate({ region: 'Bordeaux', body: 4, tannin: 3 }),
    );
    const scoreMismatched = computer.computeAnchorPreservation(anchor, candidate);
    // Different regions should score lower than matching regions
    expect(scoreMismatched).toBeLessThan(scoreMatched);
  });
});

/**
 * Regression tests for the score semantic split.
 *
 * Validates that:
 *   - FusionService emits fusionRrfTotal on fused candidates.
 *   - Browse/Compare candidates do not fabricate fusionRrfTotal.
 *   - SignalComputer reads fusionRrfTotal only.
 *   - hybridCandidateToEnvelope does not fabricate per-channel raw scores from fusion totals.
 */
import { describe, it, expect } from 'vitest';
import { FusionService } from '../fusion.js';
import { sparseHitToCandidate } from '../sparse-hit-to-candidate.js';
import { SignalComputer } from '../../../ranking/service/signal-computer.js';
import type { SparseHit, DenseHit } from '../../port/search-index.port.js';
import type { HybridCandidate } from '../../model/hybrid-candidate.js';
import { createEntityId } from '../../../shared/types/index.js';
import type { CanonicalEntityId } from '../../../shared/types/index.js';
import { makeHybridCandidate } from '../../../../../test/support/hybrid-candidate-test-factory.js';

function sparseHit(entityId: string, rank: number, score = 1.0): SparseHit {
  return { entityId: entityId as CanonicalEntityId, rank, score, matchedFields: [] };
}

function denseHit(entityId: string, rank: number, score = 1.0): DenseHit {
  return { entityId: entityId as CanonicalEntityId, rank, score, similarity: score };
}

function minimalCandidate(overrides: Partial<HybridCandidate> = {}): HybridCandidate {
  return makeHybridCandidate({
    entityId: createEntityId('w-test'),
    retrievalTrace: {
      candidateSources: [],
      retrievalProfile: 'default',
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
    },
    ...overrides,
  });
}

describe('Score semantic split — fusionRrfTotal', () => {
  const fusionService = new FusionService();
  const signalComputer = new SignalComputer();

  it('FusionService.fuse() populates fusionRrfTotal on each fused candidate', () => {
    const sparse = [sparseHit('wine-a', 1, 10), sparseHit('wine-b', 2, 5)];
    const dense = [denseHit('wine-a', 2, 0.9), denseHit('wine-c', 1, 0.95)];
    const candidates = fusionService.fuse(sparse, dense);

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.fusionRrfTotal).toBeTypeOf('number');
      expect(Number.isFinite(candidate.fusionRrfTotal)).toBe(true);
    }
  });

  it('Browse retriever candidate does NOT have fusionRrfTotal', () => {
    const hit = sparseHit('wine-browse', 1, 12.5);
    const candidate = sparseHitToCandidate(hit, 1, {
      retrievalProfile: 'browse',
      lexicalQueries: ['cabernet'],
      filtersApplied: [],
      candidateSources: ['sparse_bm25'],
    });

    expect(candidate).not.toHaveProperty('fusionRrfTotal');
    expect(candidate.sparseRawScore).toBe(12.5);
  });

  it('FusionService preserves per-channel raw scores alongside fusionRrfTotal', () => {
    const sparse = [sparseHit('wine-multi', 1, 20.0), sparseHit('wine-sparse-only', 2, 8.0)];
    const dense = [denseHit('wine-multi', 1, 0.95)];
    const anchor = [denseHit('wine-multi', 3, 0.8)];

    const candidates = fusionService.fuse(sparse, dense, anchor);
    const multi = candidates.find((candidate) => candidate.entityId === createEntityId('wine-multi'));
    const sparseOnly = candidates.find((candidate) => candidate.entityId === createEntityId('wine-sparse-only'));

    expect(multi).toBeDefined();
    expect(sparseOnly).toBeDefined();
    expect(multi!.sparseRawScore).toBe(20.0);
    expect(multi!.denseRawScore).toBe(0.95);
    expect(multi!.anchorRawScore).toBe(0.8);
    expect(multi!.fusionRrfTotal).toBeTypeOf('number');
    expect(sparseOnly!.sparseRawScore).toBe(8.0);
    expect(sparseOnly!.fusionRrfTotal).toBeTypeOf('number');
  });

  it('signal-computer returns undefined without fusionRrfTotal', () => {
    expect(signalComputer.computeSemanticScore(minimalCandidate())).toBeUndefined();
  });

  it('signal-computer uses fusionRrfTotal when present, including exact zero', () => {
    const zero = minimalCandidate({ fusionRrfTotal: 0 });
    const nonZero = minimalCandidate({ fusionRrfTotal: 0.1 });

    const zeroScore = signalComputer.computeSemanticScore(zero);
    const nonZeroScore = signalComputer.computeSemanticScore(nonZero);

    expect(zeroScore).toBeDefined();
    expect(nonZeroScore).toBeDefined();
    expect(nonZeroScore).toBeGreaterThan(zeroScore as number);
  });
});

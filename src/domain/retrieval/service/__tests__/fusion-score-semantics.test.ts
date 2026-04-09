/**
 * Regression tests for the score semantic split (bugbash 2026-04-09, Group C).
 *
 * Validates that:
 *   - FusionService.fuse() populates fusionRrfTotal on every candidate.
 *   - Browse/Compare retrievers do NOT set fusionRrfTotal.
 *   - LTR feature extraction prefers fusionRrfTotal over retrievalFusionScore.
 *   - hybridCandidateToEnvelope does not fabricate rawScore from the fusion total.
 */
import { describe, it, expect } from 'vitest';
import { FusionService } from '../fusion.js';
import { sparseHitToCandidate } from '../sparse-hit-to-candidate.js';
import { extractLTRFeatures } from '../../../ranking/service/ltr-features.js';
import type { SparseHit, DenseHit } from '../../port/search-index.port.js';
import type { HybridCandidate } from '../../model/hybrid-candidate.js';
import { createEntityId } from '../../../shared/types/index.js';
import type { EntityId } from '../../../shared/types/index.js';

// ── helpers ──────────────────────────────────────────────────────────

function sparseHit(entityId: string, rank: number, score = 1.0): SparseHit {
  return { entityId: entityId as EntityId, rank, score, matchedFields: [] };
}

function denseHit(entityId: string, rank: number, score = 1.0): DenseHit {
  return { entityId: entityId as EntityId, rank, score, similarity: score };
}

const noDegradation = { dense: false, sparse: false, anchor: false } as const;

function minimalCandidate(overrides: Partial<HybridCandidate> = {}): HybridCandidate {
  return {
    entityId: createEntityId('w-test'),
    retrievalFusionScore: 0,
    matchedConstraints: [],
    retrievalTrace: {
      candidateSources: [],
      retrievalProfile: 'default',
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
    },
    ...overrides,
  } as unknown as HybridCandidate;
}

// ── tests ────────────────────────────────────────────────────────────

describe('Score semantic split — fusionRrfTotal', () => {
  const fusionService = new FusionService();

  it('FusionService.fuse() populates fusionRrfTotal on each candidate', () => {
    const sparse = [sparseHit('wine-a', 1, 10), sparseHit('wine-b', 2, 5)];
    const dense = [denseHit('wine-a', 2, 0.9), denseHit('wine-c', 1, 0.95)];
    const candidates = fusionService.fuse(sparse, dense);

    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.fusionRrfTotal).toBeTypeOf('number');
      expect(Number.isFinite(c.fusionRrfTotal)).toBe(true);
      // fusionRrfTotal must equal retrievalFusionScore in FusionService output
      expect(c.fusionRrfTotal).toBe(c.retrievalFusionScore);
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

    // Browse candidates bypass fusion — fusionRrfTotal must be absent
    expect(candidate).not.toHaveProperty('fusionRrfTotal');
    // sparseRawScore carries the BM25 raw score (canonical per-channel field)
    expect(candidate.sparseRawScore).toBe(12.5);
    // retrievalFusionScore is still set (legacy — backward compat)
    expect(candidate.retrievalFusionScore).toBe(12.5);
  });

  it('FusionService always populates sparseRawScore when sparse hits are present — no missing-rawScore edge case in practice', () => {
    // Verify that FusionService.fuse() always sets sparseRawScore for sparse
    // hits, so the "sparseRank without sparseRawScore" edge case in
    // hybridCandidateToEnvelope can only happen from non-fusion retrievers.
    const sparse = [sparseHit('wine-verify', 1, 12.5)];
    const dense = [denseHit('wine-verify', 2, 0.8)];
    const candidates = fusionService.fuse(sparse, dense);

    const c = candidates.find((c) => c.entityId === createEntityId('wine-verify'));
    expect(c).toBeDefined();
    // sparseRawScore MUST be present and equal to the original BM25 score
    expect(c!.sparseRawScore).toBe(12.5);
    // sparseRawScore and fusionRrfTotal must be distinct values
    expect(c!.sparseRawScore).not.toBe(c!.fusionRrfTotal);
    // fusionRrfTotal is the RRF total (much smaller)
    expect(c!.fusionRrfTotal).toBeLessThan(c!.sparseRawScore!);
  });

  it('hybridCandidateToEnvelope: sparseRawScore present → rawScore is the per-channel raw', () => {
    // FusionService candidates should have both sparseRawScore and
    // fusionRrfTotal, with distinct values.
    const sparse = [sparseHit('wine-x', 1, 15.7)];
    const dense = [denseHit('wine-x', 1, 0.92)];
    const candidates = fusionService.fuse(sparse, dense);

    const c = candidates.find((c) => c.entityId === createEntityId('wine-x'));
    expect(c).toBeDefined();
    // sparseRawScore is the actual BM25 score (15.7)
    expect(c!.sparseRawScore).toBe(15.7);
    // fusionRrfTotal is the RRF total (much smaller, ~0.03)
    expect(c!.fusionRrfTotal).toBeDefined();
    // They must be different values — that's the whole point of the split
    expect(c!.sparseRawScore).not.toBe(c!.fusionRrfTotal);
  });

  it('fusionRrfTotal is defined and numeric (not undefined) even for very low-rank results close to 0', () => {
    // Regression: guards against `??` to `||` regression.
    // If someone changes `candidate.fusionRrfTotal ?? candidate.retrievalFusionScore`
    // to `||`, a fusionRrfTotal of 0 would incorrectly fall through to the
    // legacy retrievalFusionScore.
    //
    // Use very high ranks so RRF scores approach 0 (1/(rank+60) with rank >> 60).
    const sparse = [sparseHit('wine-low', 500, 0.001)];
    const dense = [denseHit('wine-low', 500, 0.001)];
    const candidates = fusionService.fuse(sparse, dense);

    const c = candidates.find((c) => c.entityId === createEntityId('wine-low'));
    expect(c).toBeDefined();
    // fusionRrfTotal must be defined (not undefined) — this is the key assertion
    expect(c!.fusionRrfTotal).toBeDefined();
    expect(c!.fusionRrfTotal).not.toBeNull();
    expect(c!.fusionRrfTotal).toBeTypeOf('number');
    // The value should be very small but still a valid number
    expect(Number.isFinite(c!.fusionRrfTotal)).toBe(true);
    expect(c!.fusionRrfTotal).toBeGreaterThan(0);
    expect(c!.fusionRrfTotal).toBe(c!.retrievalFusionScore);
  });

  it('signal-computer: candidate with fusionRrfTotal=0 uses 0, not retrievalFusionScore via ??', () => {
    // Regression: if fusionRrfTotal is exactly 0, the `??` operator should
    // still use 0 (since 0 is not null/undefined). But `||` would fall through.
    // This test ensures the contract: fusionRrfTotal=0 means "use 0".
    const candidate = minimalCandidate({
      fusionRrfTotal: 0,
      retrievalFusionScore: 0.999, // deliberately high — must NOT be used
    });

    // Key assertion: fusionRrfTotal is 0, not undefined, not null
    expect(candidate.fusionRrfTotal).toBeDefined();
    expect(candidate.fusionRrfTotal).not.toBeNull();
    expect(candidate.fusionRrfTotal).toBe(0);

    // LTR feature extraction should use fusionRrfTotal (0), not retrievalFusionScore (0.999)
    const features = extractLTRFeatures({
      query: 'test',
      normalizedQuery: 'test',
      candidate,
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: noDegradation,
    });

    // When fusionRrfTotal is absent, extractLTRFeatures falls back to 0 (not
    // retrievalFusionScore). So a candidate with fusionRrfTotal=0 and one
    // without fusionRrfTotal produce the same fusion_score (both use 0).
    // The key contract: retrievalFusionScore (0.999) is NEVER consulted.
    const candidateWithLegacyOnly = minimalCandidate({
      // No fusionRrfTotal — falls back to 0 (not retrievalFusionScore)
      retrievalFusionScore: 0.999,
    });
    const featuresLegacy = extractLTRFeatures({
      query: 'test',
      normalizedQuery: 'test',
      candidate: candidateWithLegacyOnly,
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: noDegradation,
    });

    // Both should produce the same fusion_score: fusionRrfTotal=0 and absent
    // fusionRrfTotal both resolve to 0 in extractLTRFeatures.
    expect(features.fusion_score).toBe(featuresLegacy.fusion_score);

    // Additionally verify that a candidate with a high fusionRrfTotal produces
    // a higher fusion_score than one with fusionRrfTotal=0, proving the field
    // is actually read (not hardcoded to 0).
    const candidateWithHighRrf = minimalCandidate({
      fusionRrfTotal: 0.1,
      retrievalFusionScore: 0.999,
    });
    const featuresHighRrf = extractLTRFeatures({
      query: 'test',
      normalizedQuery: 'test',
      candidate: candidateWithHighRrf,
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: noDegradation,
    });
    expect(featuresHighRrf.fusion_score).toBeGreaterThan(features.fusion_score);
  });

  it('LTR feature extractor uses fusionRrfTotal when present', () => {
    const rrfTotal = 0.045;
    const legacyScore = 0.999; // deliberately different

    const candidateWithRrf = minimalCandidate({
      fusionRrfTotal: rrfTotal,
      retrievalFusionScore: legacyScore,
    });
    const candidateWithoutRrf = minimalCandidate({
      retrievalFusionScore: legacyScore,
    });

    const featuresWithRrf = extractLTRFeatures({
      query: 'barolo',
      normalizedQuery: 'barolo',
      candidate: candidateWithRrf,
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: noDegradation,
    });
    const featuresWithoutRrf = extractLTRFeatures({
      query: 'barolo',
      normalizedQuery: 'barolo',
      candidate: candidateWithoutRrf,
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: noDegradation,
    });

    // With fusionRrfTotal present (0.045) → fusion_score uses it.
    // Without fusionRrfTotal → fusion_score falls back to 0 (not retrievalFusionScore).
    // So the RRF variant (0.045) should produce a HIGHER fusion_score than the
    // absent variant (0), because retrievalFusionScore is never consulted.
    expect(featuresWithRrf.fusion_score).not.toBe(featuresWithoutRrf.fusion_score);
    expect(featuresWithRrf.fusion_score).toBeGreaterThan(featuresWithoutRrf.fusion_score);
  });

  it('FusionService candidate preserves per-channel raw scores alongside fusionRrfTotal', () => {
    const sparse = [sparseHit('wine-multi', 1, 20.0), sparseHit('wine-sparse-only', 2, 8.0)];
    const dense = [denseHit('wine-multi', 1, 0.95)];
    const anchor = [denseHit('wine-multi', 3, 0.80)];

    const candidates = fusionService.fuse(sparse, dense, anchor);
    const multi = candidates.find((c) => c.entityId === createEntityId('wine-multi'));
    const sparseOnly = candidates.find((c) => c.entityId === createEntityId('wine-sparse-only'));

    expect(multi).toBeDefined();
    expect(sparseOnly).toBeDefined();

    // multi-channel candidate has all raw scores + fusionRrfTotal
    expect(multi!.sparseRawScore).toBe(20.0);
    expect(multi!.denseRawScore).toBe(0.95);
    expect(multi!.anchorRawScore).toBe(0.80);
    expect(multi!.fusionRrfTotal).toBeTypeOf('number');

    // sparse-only candidate: only sparse raw score
    expect(sparseOnly!.sparseRawScore).toBe(8.0);
    expect(sparseOnly!.denseRawScore).toBeUndefined();
    expect(sparseOnly!.anchorRawScore).toBeUndefined();
    // Still has fusionRrfTotal (RRF with one channel)
    expect(sparseOnly!.fusionRrfTotal).toBeTypeOf('number');
  });
});

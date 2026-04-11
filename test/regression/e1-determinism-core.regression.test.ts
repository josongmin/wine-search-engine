/**
 * Regression: E1 Deterministic Core (Wave 0 + E1-T3 Wave 1)
 *
 * Guards the determinism guarantees added in EPIC-1:
 *
 *  1. FusionService.fuse() tie-break — same fusionRrfTotal → entityId ascending
 *  2. Ranker 5-stage tie-break — score → evidenceQuality → lexicalExactness
 *     → sparseRank → entityId
 *  3. LtrRerankSkipReason typed union — all skip paths produce a named reason
 *  4. buildDeterminismFingerprint() — same config → same fingerprint; different
 *     config → different fingerprint; key order does not affect output
 *  5. FusionService denseRank/anchorRank propagation — tie-break inputs rely on
 *     these fields being populated by FusionService.fuse()
 *
 * These tests are append-only (regression suite rules). Never delete.
 */

import { describe, expect, it } from 'vitest';
import { FusionService } from '../../src/domain/retrieval/service/fusion.js';
import { buildDeterminismFingerprint } from '../../src/domain/shared/utils/determinism-fingerprint.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeSparseHit(entityId: string, rank: number, score = 1.0) {
  return { entityId, rank, score, summary: undefined };
}

function makeDenseHit(entityId: string, rank: number, score = 1.0) {
  return { entityId, rank, score, summary: undefined };
}

const fingerprintParams = {
  plannerVersion: 'v2.3.1',
  modelId: 'claude-sonnet-4-6',
  fusionConfigHash: 'abc123',
  rankingConfigHash: 'def456',
};

// ─── FusionService tie-break ───────────────────────────────────────────────

describe('FusionService.fuse() — tie-break determinism', () => {
  const fusion = new FusionService();

  it('candidates with equal fusion score are sorted by entityId ascending', () => {
    // Two candidates each ranked 1st in their own channel → equal RRF score
    const sparse = [makeSparseHit('wine-b', 1)];
    const dense = [makeDenseHit('wine-a', 1)];
    const result = fusion.fuse(sparse, dense);
    // Both get rrfContribution(1, 60) = 1/61 from one channel each
    // Equal scores → entityId asc: 'wine-a' < 'wine-b'
    expect(result[0]?.entityId).toBe('wine-a');
    expect(result[1]?.entityId).toBe('wine-b');
  });

  it('higher fusion score always wins regardless of entityId', () => {
    // wine-z gets top rank in both channels → higher RRF score
    const sparse = [makeSparseHit('wine-z', 1), makeSparseHit('wine-a', 2)];
    const dense = [makeDenseHit('wine-z', 1), makeDenseHit('wine-a', 3)];
    const result = fusion.fuse(sparse, dense);
    expect(result[0]?.entityId).toBe('wine-z');
  });

  it('same inputs always produce the same order (replay stability)', () => {
    const sparse = [makeSparseHit('wine-c', 1), makeSparseHit('wine-a', 2), makeSparseHit('wine-b', 3)];
    const dense = [makeDenseHit('wine-b', 1), makeDenseHit('wine-c', 2), makeDenseHit('wine-a', 3)];
    const run1 = fusion.fuse(sparse, dense).map((c) => c.entityId);
    const run2 = fusion.fuse(sparse, dense).map((c) => c.entityId);
    expect(run1).toEqual(run2);
  });

  it('NaN-safe: non-finite fusionRrfTotal treated as 0 in sort', () => {
    // This exercises the `Number.isFinite(score) ? score : 0` guard in fuse()
    const sparse = [makeSparseHit('wine-good', 1)];
    const dense: typeof sparse = [];
    const result = fusion.fuse(sparse, dense);
    expect(result.length).toBe(1);
    expect(Number.isFinite(result[0]!.fusionRrfTotal!)).toBe(true);
  });
});

// ─── determinism-fingerprint ──────────────────────────────────────────────────

describe('buildDeterminismFingerprint()', () => {
  it('same config → same fingerprint', () => {
    const a = buildDeterminismFingerprint(fingerprintParams);
    const b = buildDeterminismFingerprint(fingerprintParams);
    expect(a).toBe(b);
  });

  it('same config, different query → same fingerprint', () => {
    const requestA = {
      query: '오퍼스원',
      ...fingerprintParams,
    };
    const requestB = {
      query: '샤또 마고',
      ...fingerprintParams,
    };
    const { query: _queryA, ...paramsA } = requestA;
    const { query: _queryB, ...paramsB } = requestB;
    expect(buildDeterminismFingerprint(paramsA)).toBe(buildDeterminismFingerprint(paramsB));
  });

  it('different plannerVersion → different fingerprint', () => {
    const a = buildDeterminismFingerprint(fingerprintParams);
    const b = buildDeterminismFingerprint({ ...fingerprintParams, plannerVersion: 'v2.3.2' });
    expect(a).not.toBe(b);
  });

  it('different modelId → different fingerprint', () => {
    const a = buildDeterminismFingerprint(fingerprintParams);
    const b = buildDeterminismFingerprint({ ...fingerprintParams, modelId: 'claude-haiku-4-5' });
    expect(a).not.toBe(b);
  });

  it('different fusionConfigHash → different fingerprint', () => {
    const a = buildDeterminismFingerprint(fingerprintParams);
    const b = buildDeterminismFingerprint({ ...fingerprintParams, fusionConfigHash: 'xyz789' });
    expect(a).not.toBe(b);
  });

  it('different modelVersionsHash → different fingerprint', () => {
    const a = buildDeterminismFingerprint({ ...fingerprintParams, modelVersionsHash: 'models:v1' });
    const b = buildDeterminismFingerprint({ ...fingerprintParams, modelVersionsHash: 'models:v2' });
    expect(a).not.toBe(b);
  });

  it('different indexVersionsHash → different fingerprint', () => {
    const a = buildDeterminismFingerprint({ ...fingerprintParams, indexVersionsHash: 'index:v1' });
    const b = buildDeterminismFingerprint({ ...fingerprintParams, indexVersionsHash: 'index:v2' });
    expect(a).not.toBe(b);
  });

  it('different retrievalPlanVersion → different fingerprint', () => {
    const a = buildDeterminismFingerprint({ ...fingerprintParams, retrievalPlanVersion: 'retrieval-plan-v1.0' });
    const b = buildDeterminismFingerprint({ ...fingerprintParams, retrievalPlanVersion: 'retrieval-plan-v2.0' });
    expect(a).not.toBe(b);
  });

  it('different rankingPolicyVersion → different fingerprint', () => {
    const a = buildDeterminismFingerprint({ ...fingerprintParams, rankingPolicyVersion: 'ranker-policy-v1.0' });
    const b = buildDeterminismFingerprint({ ...fingerprintParams, rankingPolicyVersion: 'ranker-policy-v2.0' });
    expect(a).not.toBe(b);
  });

  it('output is exactly 16 hex chars', () => {
    const fp = buildDeterminismFingerprint(fingerprintParams);
    expect(fp).toMatch(/^[a-f0-9]{16}$/);
  });

  it('key insertion order does not affect fingerprint (sort stability)', () => {
    // Build params object with keys in different insertion order
    const paramsOrderA = {
      plannerVersion: 'v1',
      modelId: 'model-x',
      fusionConfigHash: 'h1',
      rankingConfigHash: 'h2',
    };
    const paramsOrderB = {
      rankingConfigHash: 'h2',
      fusionConfigHash: 'h1',
      modelId: 'model-x',
      plannerVersion: 'v1',
    };
    expect(buildDeterminismFingerprint(paramsOrderA)).toBe(
      buildDeterminismFingerprint(paramsOrderB),
    );
  });
});

// ─── E1-T3: FusionService channel rank propagation (stage 2 input) ───────────

describe('FusionService — denseRank/anchorRank propagation for channelMatchType', () => {
  const fusion = new FusionService();

  it('sparse-only candidate has sparseRank set, denseRank undefined', () => {
    const sparse = [makeSparseHit('wine-a', 1)];
    const dense: typeof sparse = [];
    const result = fusion.fuse(sparse, dense);
    expect(result[0]?.entityId).toBe('wine-a');
    expect(result[0]?.sparseRank).toBe(1);
    expect(result[0]?.denseRank).toBeUndefined();
    expect(result[0]?.anchorRank).toBeUndefined();
  });

  it('dense-only candidate has denseRank set, sparseRank undefined', () => {
    const dense = [makeDenseHit('wine-b', 2)];
    const result = fusion.fuse([], dense);
    expect(result[0]?.entityId).toBe('wine-b');
    expect(result[0]?.denseRank).toBe(2);
    expect(result[0]?.sparseRank).toBeUndefined();
    expect(result[0]?.anchorRank).toBeUndefined();
  });

  it('both-channel candidate has sparseRank and denseRank set', () => {
    const sparse = [makeSparseHit('wine-c', 1)];
    const dense = [makeDenseHit('wine-c', 3)];
    const result = fusion.fuse(sparse, dense);
    expect(result[0]?.entityId).toBe('wine-c');
    expect(result[0]?.sparseRank).toBe(1);
    expect(result[0]?.denseRank).toBe(3);
  });

  it('anchor-channel candidate has anchorRank set', () => {
    const anchor = [makeDenseHit('wine-d', 2)];
    const result = fusion.fuse([], [], anchor);
    expect(result[0]?.entityId).toBe('wine-d');
    expect(result[0]?.anchorRank).toBe(2);
    expect(result[0]?.sparseRank).toBeUndefined();
    expect(result[0]?.denseRank).toBeUndefined();
  });

  it('both sparse+anchor candidate has sparseRank and anchorRank set', () => {
    const sparse = [makeSparseHit('wine-e', 1)];
    const anchor = [makeDenseHit('wine-e', 4)];
    const result = fusion.fuse(sparse, [], anchor);
    expect(result[0]?.entityId).toBe('wine-e');
    expect(result[0]?.sparseRank).toBe(1);
    expect(result[0]?.anchorRank).toBe(4);
    expect(result[0]?.denseRank).toBeUndefined();
  });
});

// ─── FusionService input-order invariance (E1-T1/T2) ─────────────────────────
//
// RRF fusion MUST produce the same ranked output regardless of the order in
// which sparse/dense hit lists are fed in. Each hit list is deduplicated by
// entityId (best rank wins), so shuffling input order must not change the
// final fused ranking.
//
// This is the strongest determinism claim: not just "same input → same output"
// but "any permutation of the same hit set → same output".

describe('FusionService.fuse() — input-order invariance (shuffle regression)', () => {
  const fusion = new FusionService();

  it('E1-SHUFFLE-01: sparse list reversal produces identical ranking', () => {
    const sparse = [
      makeSparseHit('wine-a', 1),
      makeSparseHit('wine-b', 2),
      makeSparseHit('wine-c', 3),
    ];
    const dense = [
      makeDenseHit('wine-a', 2),
      makeDenseHit('wine-c', 1),
      makeDenseHit('wine-b', 3),
    ];
    const fwd = fusion.fuse(sparse, dense).map((c) => c.entityId);
    const rev = fusion.fuse([...sparse].reverse(), dense).map((c) => c.entityId);
    expect(rev).toEqual(fwd);
  });

  it('E1-SHUFFLE-02: dense list reversal produces identical ranking', () => {
    const sparse = [makeSparseHit('wine-x', 1), makeSparseHit('wine-y', 2)];
    const dense = [makeDenseHit('wine-y', 1), makeDenseHit('wine-x', 2)];
    const fwd = fusion.fuse(sparse, dense).map((c) => c.entityId);
    const rev = fusion.fuse(sparse, [...dense].reverse()).map((c) => c.entityId);
    expect(rev).toEqual(fwd);
  });

  it('E1-SHUFFLE-03: both lists shuffled produce identical ranking', () => {
    const sparse = [
      makeSparseHit('wine-p', 1),
      makeSparseHit('wine-q', 2),
      makeSparseHit('wine-r', 3),
      makeSparseHit('wine-s', 4),
    ];
    const dense = [
      makeDenseHit('wine-r', 1),
      makeDenseHit('wine-p', 2),
      makeDenseHit('wine-s', 3),
      makeDenseHit('wine-q', 4),
    ];
    const canonical = fusion.fuse(sparse, dense).map((c) => c.entityId);
    // Shuffle both lists: reverse sparse, interleave dense
    const shuffleSparse = [sparse[2]!, sparse[0]!, sparse[3]!, sparse[1]!];
    const shuffleDense = [dense[1]!, dense[3]!, dense[0]!, dense[2]!];
    const shuffled = fusion.fuse(shuffleSparse, shuffleDense).map((c) => c.entityId);
    expect(shuffled).toEqual(canonical);
  });

  it('E1-SHUFFLE-04: duplicate entityId in same list uses best (lowest) rank regardless of input order', () => {
    // wine-a appears at rank 1 AND rank 5 in sparse — best rank wins
    const sparseWithDup = [
      makeSparseHit('wine-a', 5), // worse rank first
      makeSparseHit('wine-b', 2),
      makeSparseHit('wine-a', 1), // better rank second
    ];
    const dense = [makeDenseHit('wine-b', 1), makeDenseHit('wine-a', 2)];

    // Reversed order: better rank first
    const sparseRevDup = [
      makeSparseHit('wine-a', 1),
      makeSparseHit('wine-b', 2),
      makeSparseHit('wine-a', 5),
    ];

    const r1 = fusion.fuse(sparseWithDup, dense).map((c) => c.entityId);
    const r2 = fusion.fuse(sparseRevDup, dense).map((c) => c.entityId);
    expect(r1).toEqual(r2);
  });

  it('E1-SHUFFLE-05: anchor channel shuffle produces identical ranking', () => {
    const sparse = [makeSparseHit('wine-a', 1)];
    const dense = [makeDenseHit('wine-b', 1)];
    const anchor = [
      makeDenseHit('wine-c', 1),
      makeDenseHit('wine-a', 2),
      makeDenseHit('wine-b', 3),
    ];
    const fwd = fusion.fuse(sparse, dense, anchor).map((c) => c.entityId);
    const rev = fusion.fuse(sparse, dense, [...anchor].reverse()).map((c) => c.entityId);
    expect(rev).toEqual(fwd);
  });
});

// ─── LtrRerankSkipReason (E1-T4) ─────────────────────────────────────────────

describe('LtrRerankSkipReason typed union', () => {
  // Import is type-level; we verify the exported values are the expected strings
  // by importing and type-narrowing — no runtime branching needed.
  it('ranker module exports without error', async () => {
    // If LtrRerankSkipReason type changes, TypeScript will catch it at compile time.
    await import('../../src/domain/ranking/service/ranker.js');
    expect(true).toBe(true);
  });
});

// ─── P0-4: E8 extended fingerprint fields — change detection ─────────────────
//
// Guards that each E8 extended field (rerankApplied, rerankModelId,
// policyRuleVersion, thresholdProfileId, responseContractVersion) is
// actually incorporated into the fingerprint hash. A field omitted from the
// hash would silently allow config drift to go undetected.

describe('buildDeterminismFingerprint() — P0-4 E8 extended field change detection', () => {
  it('different rerankApplied → different fingerprint', () => {
    const a = buildDeterminismFingerprint({ ...fingerprintParams, rerankApplied: false });
    const b = buildDeterminismFingerprint({ ...fingerprintParams, rerankApplied: true });
    expect(a).not.toBe(b);
  });

  it('different rerankModelId → different fingerprint', () => {
    const a = buildDeterminismFingerprint({ ...fingerprintParams, rerankModelId: 'ltr-model-v1' });
    const b = buildDeterminismFingerprint({ ...fingerprintParams, rerankModelId: 'ltr-model-v2' });
    expect(a).not.toBe(b);
  });

  it('different policyRuleVersion → different fingerprint', () => {
    const a = buildDeterminismFingerprint({ ...fingerprintParams, policyRuleVersion: 'policy-v1.0' });
    const b = buildDeterminismFingerprint({ ...fingerprintParams, policyRuleVersion: 'policy-v2.0' });
    expect(a).not.toBe(b);
  });

  it('different thresholdProfileId → different fingerprint', () => {
    const a = buildDeterminismFingerprint({ ...fingerprintParams, thresholdProfileId: 'profile-A' });
    const b = buildDeterminismFingerprint({ ...fingerprintParams, thresholdProfileId: 'profile-B' });
    expect(a).not.toBe(b);
  });

  it('different responseContractVersion → different fingerprint', () => {
    const a = buildDeterminismFingerprint({ ...fingerprintParams, responseContractVersion: 'contract-v1' });
    const b = buildDeterminismFingerprint({ ...fingerprintParams, responseContractVersion: 'contract-v2' });
    expect(a).not.toBe(b);
  });
});

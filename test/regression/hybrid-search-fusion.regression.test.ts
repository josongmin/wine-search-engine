/**
 * Regression: hybrid-search fusion edge-case suite.
 *
 * Audit (feature-catalog `retrieval.hybrid-search`) found only a single e2e
 * golden-set test exercised the fused ranking. This suite pins the
 * DETERMINISTIC fusion cores directly so the production-bar (level 4)
 * promotion is backed by unit-level edge coverage:
 *
 *   - `FusionService.fuse`  — the RRF math core (1/(k+rank)), channel dedup,
 *     empty-lane handling, score monotonicity, NaN-safe tie-break.
 *   - `fuseDualLaneArtifacts` — dual-lane merge: entity+general dedup, Korean
 *     canonicalLabel NFC flow-through, rank-based stable ordering.
 *
 * Both cores are pure (no I/O); only the lane INPUTS are constructed here.
 * The real fusion functions are imported and exercised — nothing is mocked.
 *
 * Coverage map (mission edge cases):
 *   1. Fusion determinism (5x identical runs)
 *   2. RRF formula correctness (1/(k+rank) for known inputs)
 *   3. Empty-lane handling (sparse-only / dense-only still ranks)
 *   4. Both lanes empty → empty result, no throw
 *   5. Score monotonicity (better-in-both ranks higher)
 *   6. Tie-break determinism (equal scores → entityId ascending)
 *   7. Korean canonicalLabel flows through dual-lane fusion intact (NFC)
 *   8. Channel dedup (same entity in both lanes → appears once)
 *
 * Append-only — never delete these tests.
 */
import { describe, it, expect } from 'vitest';
import { FusionService } from '../../src/domain/retrieval/service/fusion.js';
import { fuseDualLaneArtifacts } from '../../src/domain/retrieval/service/dual-lane-fusion.js';
import { rrfContribution, RRF_DEFAULT_K } from '../../src/domain/shared/utils/rrf.js';
import { createCanonicalEntityId } from '../../src/domain/shared/types/index.js';
import type { SparseHit, DenseHit } from '../../src/domain/retrieval/port/search-index.port.js';
import type { EntityId } from '../../src/domain/shared/types/index.js';
import type { EntityLaneCandidateArtifact } from '../../src/domain/retrieval/model/dual-lane-artifact.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';

// ─────────────────────────────────────────────────────────────────────────
// Lane-input fixture builders (the only thing this suite constructs).
// ─────────────────────────────────────────────────────────────────────────

function sparseHit(entityId: string, rank: number, score: number): SparseHit {
  return { entityId: entityId as EntityId, rank, score, matchedFields: [] };
}

function denseHit(entityId: string, rank: number, score: number): DenseHit {
  return { entityId: entityId as EntityId, rank, score, similarity: score };
}

function makeGeneralCandidate(
  entityId: string,
  overrides: Partial<HybridCandidate> = {},
): HybridCandidate {
  return {
    entityId: createCanonicalEntityId(entityId),
    canonicalLabel: `${entityId} general`,
    fusionRrfTotal: 0.25,
    sparseRank: 1,
    matchedConstraints: [],
    retrievalTrace: {
      retrievalProfile: 'fusion',
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
      candidateSources: ['sparse_bm25'],
    },
    ...overrides,
  };
}

function makeEntityArtifact(
  entityId: string,
  canonicalLabel: string,
  overrides: Partial<EntityLaneCandidateArtifact> = {},
): EntityLaneCandidateArtifact {
  return {
    entityId: createCanonicalEntityId(entityId),
    candidate: {
      entityId: createCanonicalEntityId(entityId),
      canonicalLabel,
      matchedConstraints: ['producer'],
      retrievalTrace: {
        retrievalProfile: 'entity_route_synthetic',
        lexicalQueriesUsed: [],
        semanticQueriesUsed: [],
        filtersApplied: [],
        candidateSources: ['entity_resolver'],
      },
      entityPosteriorScore: 0.97,
      identityExactnessTier: 'exact',
      lanePresence: 'entity_only',
    },
    resolvedCandidate: {
      entityId: createCanonicalEntityId(entityId),
      canonicalLabel,
      calibratedScore: 0.97,
      rank: 1,
      evidenceRefs: [`resolver:${entityId}`],
    },
    identityProvenance: {
      source: 'entity_resolver',
      entityId: createCanonicalEntityId(entityId),
      exactnessTier: 'exact',
      calibratedScore: 0.97,
      resolverRank: 1,
      canonicalLabel,
      evidenceRefs: [`resolver:${entityId}`],
      sourceSignals: {
        canonicalExactMatch: 1,
        canonicalNormalizedMatch: 1,
        aliasExactMatch: 1,
        aliasFuzzyMatch: 0,
        editDistanceScore: 0,
      },
    },
    evidenceItems: [],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// RRF math core: FusionService.fuse
// ─────────────────────────────────────────────────────────────────────────

describe('Regression: hybrid-search RRF fusion core (FusionService.fuse)', () => {
  const fusion = new FusionService();

  it('produces a byte-identical fused ranking across 5 repeated runs (determinism)', () => {
    const sparse = [sparseHit('w-c', 1, 30), sparseHit('w-a', 2, 20), sparseHit('w-b', 3, 10)];
    const dense = [denseHit('w-a', 1, 0.99), denseHit('w-b', 2, 0.8), denseHit('w-c', 3, 0.5)];

    const baseline = fusion
      .fuse(sparse, dense)
      .map((c) => `${String(c.entityId)}:${c.fusionRrfTotal!.toFixed(12)}`);

    for (let run = 0; run < 5; run += 1) {
      const replay = fusion
        .fuse(sparse, dense)
        .map((c) => `${String(c.entityId)}:${c.fusionRrfTotal!.toFixed(12)}`);
      expect(replay).toEqual(baseline);
    }
  });

  it('computes fusionRrfTotal exactly as the sum of 1/(k+rank) across rankings', () => {
    // w-x: sparse rank 1 + dense rank 2 → 1/(60+1) + 1/(60+2).
    // Sparse and learned-sparse collapse into one lexical family; here only
    // sparse contributes, so the lexical-family rank for w-x is 1.
    const k = RRF_DEFAULT_K;
    const candidates = fusion.fuse(
      [sparseHit('w-x', 1, 12)],
      [denseHit('w-x', 2, 0.7)],
    );
    const c = candidates[0]!;
    const expected = rrfContribution(1, k) + rrfContribution(2, k);
    expect(c.fusionRrfTotal).toBeCloseTo(expected, 12);
    // Sanity: matches the literal closed form 1/61 + 1/62.
    expect(c.fusionRrfTotal).toBeCloseTo(1 / 61 + 1 / 62, 12);
  });

  it('honors an explicit k override in the RRF contribution', () => {
    const k = 10;
    const candidates = fusion.fuse([sparseHit('w-k', 1, 5)], [], undefined, k);
    expect(candidates[0]!.fusionRrfTotal).toBeCloseTo(1 / (10 + 1), 12);
  });

  it('rejects k < 1 (degenerate / rank-inverting smoothing constant)', () => {
    expect(() => fusion.fuse([sparseHit('w-bad', 1, 1)], [], undefined, 0)).toThrow(/k must be/);
    expect(() => fusion.fuse([sparseHit('w-bad', 1, 1)], [], undefined, -5)).toThrow(/k must be/);
  });

  it('produces a ranking from sparse-only input (dense lane empty)', () => {
    const candidates = fusion.fuse(
      [sparseHit('w-1', 1, 30), sparseHit('w-2', 2, 10)],
      [],
    );
    expect(candidates.map((c) => String(c.entityId))).toEqual(['w-1', 'w-2']);
    expect(candidates[0]!.fusionRrfTotal).toBeCloseTo(rrfContribution(1), 12);
    expect(candidates[0]!.denseRank).toBeUndefined();
  });

  it('produces a ranking from dense-only input (sparse lane empty)', () => {
    const candidates = fusion.fuse(
      [],
      [denseHit('w-1', 2, 0.4), denseHit('w-2', 1, 0.9)],
    );
    expect(candidates.map((c) => String(c.entityId))).toEqual(['w-2', 'w-1']);
    expect(candidates[0]!.sparseRank).toBeUndefined();
    expect(candidates[0]!.denseRank).toBe(1);
  });

  it('returns an empty result with no throw when BOTH lanes are empty', () => {
    expect(() => fusion.fuse([], [])).not.toThrow();
    expect(fusion.fuse([], [])).toEqual([]);
  });

  it('ranks an entity that is top in BOTH lanes above an entity strong in only one (monotonicity)', () => {
    // w-top: rank 1 sparse + rank 1 dense. w-one: rank 1 dense only.
    // w-top accumulates two reciprocal contributions → strictly higher total.
    const candidates = fusion.fuse(
      [sparseHit('w-top', 1, 50)],
      [denseHit('w-top', 1, 0.95), denseHit('w-one', 2, 0.9)],
    );
    expect(String(candidates[0]!.entityId)).toBe('w-top');
    const top = candidates.find((c) => String(c.entityId) === 'w-top')!;
    const one = candidates.find((c) => String(c.entityId) === 'w-one')!;
    expect(top.fusionRrfTotal!).toBeGreaterThan(one.fusionRrfTotal!);
  });

  it('breaks equal fusion scores by entityId ascending (tie-break determinism)', () => {
    // Three entities each at sparse rank 1 of their own singleton view is not
    // possible in one list; instead give all three the SAME rank across lanes
    // so their RRF totals are identical, forcing the tie-break path.
    const candidates = fusion.fuse(
      [sparseHit('w-charlie', 1, 10), sparseHit('w-alpha', 1, 10), sparseHit('w-bravo', 1, 10)],
      [],
    );
    // All share rank 1 → identical fusionRrfTotal → ordered by entityId asc.
    const totals = new Set(candidates.map((c) => c.fusionRrfTotal!.toFixed(12)));
    expect(totals.size).toBe(1);
    expect(candidates.map((c) => String(c.entityId))).toEqual([
      'w-alpha',
      'w-bravo',
      'w-charlie',
    ]);
  });

  it('dedups an entity present in sparse AND dense into a single fused candidate carrying both ranks', () => {
    const candidates = fusion.fuse(
      [sparseHit('w-dup', 3, 8)],
      [denseHit('w-dup', 1, 0.9)],
    );
    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.sparseRank).toBe(3);
    expect(c.denseRank).toBe(1);
    expect(c.retrievalTrace.candidateSources).toEqual(['sparse_bm25', 'dense_semantic']);
  });

  it('collapses sparse + learned-sparse into one lexical family (no double-count)', () => {
    // Same entity at sparse rank 5 and learned-sparse rank 1 → lexical family
    // takes the BEST rank (1), contributing 1/(k+1) ONCE, not twice.
    const candidates = fusion.fuse(
      [sparseHit('w-lex', 5, 4)],
      [],
      undefined,
      undefined,
      [denseHit('w-lex', 1, 7)],
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.fusionRrfTotal).toBeCloseTo(rrfContribution(1), 12);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Dual-lane merge core: fuseDualLaneArtifacts
// ─────────────────────────────────────────────────────────────────────────

describe('Regression: dual-lane fusion edge cases (fuseDualLaneArtifacts)', () => {
  it('produces an identical fused ordering across 5 repeated runs (determinism)', () => {
    const entityLaneArtifacts = [
      makeEntityArtifact('w-b', 'Wine B'),
      makeEntityArtifact('w-c', 'Wine C'),
    ];
    const generalLaneCandidates = [
      makeGeneralCandidate('w-a'),
      makeGeneralCandidate('w-b'),
    ];

    const baseline = fuseDualLaneArtifacts({ entityLaneArtifacts, generalLaneCandidates })
      .fusedCandidates.map((c) => String(c.entityId));

    for (let run = 0; run < 5; run += 1) {
      const replay = fuseDualLaneArtifacts({ entityLaneArtifacts, generalLaneCandidates })
        .fusedCandidates.map((c) => String(c.entityId));
      expect(replay).toEqual(baseline);
    }
  });

  it('returns an empty result with no throw when both lanes are empty', () => {
    expect(() =>
      fuseDualLaneArtifacts({ entityLaneArtifacts: [], generalLaneCandidates: [] }),
    ).not.toThrow();
    const result = fuseDualLaneArtifacts({ entityLaneArtifacts: [], generalLaneCandidates: [] });
    expect(result.fusedCandidates).toEqual([]);
    expect(result.laneArtifacts).toEqual([]);
  });

  it('dedups an entity present in BOTH lanes into one corroborated candidate', () => {
    const result = fuseDualLaneArtifacts({
      entityLaneArtifacts: [makeEntityArtifact('w-dup', 'Dup Wine')],
      generalLaneCandidates: [makeGeneralCandidate('w-dup')],
    });
    expect(result.fusedCandidates).toHaveLength(1);
    expect(result.laneArtifacts).toHaveLength(1);
    expect(result.fusedCandidates[0]!.lanePresence).toBe('corroborated');
  });

  it('preserves a Korean canonicalLabel through fusion intact and NFC-normalized', () => {
    // Composed (NFC) Korean label. Must survive merge byte-for-byte and stay NFC.
    const koLabel = '오퍼스 원';
    const result = fuseDualLaneArtifacts({
      entityLaneArtifacts: [makeEntityArtifact('w-ko', koLabel)],
      generalLaneCandidates: [],
    });
    const fused = result.fusedCandidates[0]!;
    expect(fused.canonicalLabel).toBe(koLabel);
    // NFC idempotence: the surfaced label is already in composed form.
    expect(fused.canonicalLabel!.normalize('NFC')).toBe(fused.canonicalLabel);
    // Lane-artifact label (separate field) also carries the Korean label.
    expect(result.laneArtifacts[0]!.canonicalLabel).toBe(koLabel);
  });

  it('keeps a Korean general-lane label even when the entity lane carries a different one', () => {
    const koGeneral = '샤또 마고';
    const result = fuseDualLaneArtifacts({
      entityLaneArtifacts: [makeEntityArtifact('w-mix', 'Chateau Margaux')],
      generalLaneCandidates: [makeGeneralCandidate('w-mix', { canonicalLabel: koGeneral })],
    });
    // mergeCandidates picks the general-lane value first when present.
    expect(result.fusedCandidates[0]!.canonicalLabel).toBe(koGeneral);
    expect(result.fusedCandidates[0]!.canonicalLabel!.normalize('NFC')).toBe(koGeneral);
  });

  it('orders general-lane candidates by rank, then appends entity-only by resolver rank, tie-broken by entityId', () => {
    const result = fuseDualLaneArtifacts({
      entityLaneArtifacts: [makeEntityArtifact('w-z', 'Wine Z')],
      generalLaneCandidates: [
        makeGeneralCandidate('w-a'),
        makeGeneralCandidate('w-b'),
      ],
    });
    // General lane (ranks 1,2) sorts before the entity-only artifact (general
    // rank = +Inf). w-a (general rank 1) < w-b (general rank 2) < w-z (entity-only).
    expect(result.fusedCandidates.map((c) => String(c.entityId))).toEqual([
      'w-a',
      'w-b',
      'w-z',
    ]);
  });
});

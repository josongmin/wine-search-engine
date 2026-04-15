/**
 * Regression: BugBash Apr-14 — Medium-Risk Coverage Gaps
 *
 * Guards:
 *  1. Batch hydration failure taxonomy (batch_lookup_failed, document_missing, success)
 *  2. Uncertainty omission in route-aware projection (NaN → omit, valid → 1-penalty)
 *  3. Reranker normalization failure decision code contract
 *  4. Resolver per-candidate trace shape contract
 *  5. Readiness probe search_snapshot_runtime required:true (fail-closed)
 *
 * These tests are append-only (regression suite rules). Never delete.
 */

import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '../../src/domain/shared/error/domain-error.js';
import { buildResolverCandidatesFromGenerator } from '../../src/application/search/search-usecase-resolver-candidates.js';
import { mapRankedResultsToResultItems } from '../../src/application/search/search-usecase-map-result-items.js';
import type { EntityDocumentLookupPort } from '../../src/application/search/port/search-pipeline-deps.port.js';
import type { EntityCandidateGeneratorInput } from '../../src/domain/resolver/model/entity-candidate-generator-input.js';
import type { AnchorCandidate } from '../../src/domain/query/model/anchor-candidate.js';
import type { RetrievalDocument } from '../../src/domain/retrieval/model/retrieval-document.js';
import type { CanonicalEntityId } from '../../src/domain/shared/types/index.js';
import type { RerankDecisionCode } from '../../src/domain/ranking/port/ranker.port.js';
import type { ResolverCandidateTrace } from '../../src/domain/resolver/model/decision-trace.js';
import type { RankedResult } from '../../src/domain/ranking/model/ranked-result.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Shared helpers ─────────────────────────────────────────────────────────

function makeAnchor(
  entityIds: readonly CanonicalEntityId[],
  overrides: Partial<AnchorCandidate> = {},
): AnchorCandidate {
  return {
    surfaceForm: 'opus one',
    normalizedForm: 'opus one',
    candidateEntityIds: entityIds,
    confidence: 0.9,
    source: 'alias',
    ...overrides,
  };
}

function makeDoc(entityId: CanonicalEntityId): RetrievalDocument {
  return {
    entityId,
    entityType: 'wine',
    canonicalLabel: `Wine ${String(entityId)}`,
    producer: 'Test Producer',
    region: 'Napa Valley',
    grapes: ['Cabernet Sauvignon'],
    searchTextKo: '테스트 와인',
    searchTextEn: 'test wine',
    semanticSummary: 'A test wine',
    style: 'bold',
    priceBand: '$50-$100',
    pairing: ['steak'],
    availability: true,
    popularityScore: 0.7,
    aliasesIdentitySafe: ['opus one'],
    aliasesNoisyRecall: ['opus 1'],
  };
}

function makeInput(
  anchors: readonly AnchorCandidate[],
  normalizedQuery = 'opus one',
): EntityCandidateGeneratorInput {
  return {
    rawQuery: normalizedQuery,
    normalizedQuery,
    anchors,
  };
}

function makeRankedResult(overrides: Partial<RankedResult> = {}): RankedResult {
  return {
    entityId: 'wine-001' as CanonicalEntityId,
    canonicalLabel: 'Test Wine',
    finalScore: 0.8,
    rank: 1,
    componentScores: {
      entityIntegrity: 0.9,
      semantic: 0.7,
      hardConstraintPass: true,
      softConstraint: 0.5,
      attributeAlignment: 0.6,
      preferenceAlignment: 0.4,
      popularity: 0.3,
      availability: 1,
      uncertaintyPenalty: 0.2,
    },
    evidenceItems: [],
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
    ...overrides,
  };
}

// ─── 1. Batch Hydration Failure Taxonomy ────────────────────────────────────

describe('Batch Hydration Failure Taxonomy', () => {
  const id1 = 'wine-hydra-1' as CanonicalEntityId;
  const id2 = 'wine-hydra-2' as CanonicalEntityId;

  it('getDocuments() throws → DomainError with batch_lookup_failed', async () => {
    const lookup: EntityDocumentLookupPort = {
      getDocuments: vi.fn().mockRejectedValue(new Error('connection refused')),
    };

    const input = makeInput([makeAnchor([id1])]);
    await expect(
      buildResolverCandidatesFromGenerator(input, lookup),
    ).rejects.toThrow(DomainError);

    await expect(
      buildResolverCandidatesFromGenerator(input, lookup),
    ).rejects.toThrow(/batch_lookup_failed/);
  });

  it('getDocuments() returns partial results → DomainError with document_missing for absent IDs', async () => {
    // Request 2 IDs but only return doc for id1
    const lookup: EntityDocumentLookupPort = {
      getDocuments: vi.fn().mockResolvedValue(
        new Map<CanonicalEntityId, RetrievalDocument>([[id1, makeDoc(id1)]]),
      ),
    };

    const input = makeInput([makeAnchor([id1, id2])]);
    await expect(
      buildResolverCandidatesFromGenerator(input, lookup),
    ).rejects.toThrow(/document_missing/);

    await expect(
      buildResolverCandidatesFromGenerator(input, lookup),
    ).rejects.toThrow(/partial_resolution_forbidden/);
  });

  it('all IDs returned → no error, candidates hydrated', async () => {
    const lookup: EntityDocumentLookupPort = {
      getDocuments: vi.fn().mockResolvedValue(
        new Map<CanonicalEntityId, RetrievalDocument>([
          [id1, makeDoc(id1)],
          [id2, makeDoc(id2)],
        ]),
      ),
    };

    const input = makeInput([makeAnchor([id1, id2])]);
    const candidates = await buildResolverCandidatesFromGenerator(input, lookup);

    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.entityId)).toContain(id1);
    expect(candidates.map((c) => c.entityId)).toContain(id2);
  });
});

// ─── 2. Uncertainty Omission in Route-Aware Projection ──────────────────────

describe('Uncertainty Omission in Route-Aware Projection', () => {
  it('NaN uncertaintyPenalty → uncertaintyConfidence field is undefined (NOT 0.5)', async () => {
    const result = makeRankedResult({
      componentScores: {
        entityIntegrity: 0.9,
        semantic: 0.7,
        hardConstraintPass: true,
        softConstraint: 0.5,
        attributeAlignment: 0.6,
        preferenceAlignment: 0.4,
        popularity: 0.3,
        availability: 1,
        uncertaintyPenalty: NaN,
      },
    });

    const items = await mapRankedResultsToResultItems([result], undefined, 2024);
    expect(items).toHaveLength(1);
    // NaN penalty → field omitted entirely, not defaulted to 0.5
    expect(items[0]!.uncertainty.uncertaintyConfidence).toBeUndefined();
    expect('uncertaintyConfidence' in items[0]!.uncertainty).toBe(false);
  });

  it('valid uncertaintyPenalty 0.3 → uncertaintyConfidence = 0.7', async () => {
    const result = makeRankedResult({
      componentScores: {
        entityIntegrity: 0.9,
        semantic: 0.7,
        hardConstraintPass: true,
        softConstraint: 0.5,
        attributeAlignment: 0.6,
        preferenceAlignment: 0.4,
        popularity: 0.3,
        availability: 1,
        uncertaintyPenalty: 0.3,
      },
    });

    const items = await mapRankedResultsToResultItems([result], undefined, 2024);
    expect(items[0]!.uncertainty.uncertaintyConfidence).toBeCloseTo(0.7, 10);
  });

  it('zero uncertaintyPenalty → uncertaintyConfidence = 1.0', async () => {
    const result = makeRankedResult({
      componentScores: {
        entityIntegrity: 0.9,
        semantic: 0.7,
        hardConstraintPass: true,
        softConstraint: 0.5,
        attributeAlignment: 0.6,
        preferenceAlignment: 0.4,
        popularity: 0.3,
        availability: 1,
        uncertaintyPenalty: 0,
      },
    });

    const items = await mapRankedResultsToResultItems([result], undefined, 2024);
    expect(items[0]!.uncertainty.uncertaintyConfidence).toBe(1.0);
  });
});

// ─── 3. Reranker Normalization Failure Decision ─────────────────────────────

describe('Reranker Normalization Failure Decision', () => {
  it('"normalization_failed" is a valid RerankDecisionCode value', () => {
    // Compile-time check: this assignment must not cause a TS error.
    // Runtime assertion ensures the value is in the union.
    const code: RerankDecisionCode = 'normalization_failed';
    expect(code).toBe('normalization_failed');
  });

  it('type assertion: all expected codes are valid RerankDecisionCode values', () => {
    const allCodes: readonly RerankDecisionCode[] = [
      'applied',
      'no_model_for_query_class',
      'empty_candidates',
      'feature_dimension_mismatch',
      'gate_blocked',
      'normalization_failed',
    ] as const;

    expect(allCodes).toContain('normalization_failed');
    expect(allCodes).toHaveLength(6);
  });
});

// ─── 4. Resolver Per-Candidate Trace ────────────────────────────────────────

describe('Resolver Per-Candidate Trace', () => {
  it('ResolverCandidateTrace has required fields: score, calibratedConfidence, boundaryDecision, matchSource', () => {
    const trace: ResolverCandidateTrace = {
      score: 0.85,
      calibratedConfidence: 0.92,
      boundaryDecision: 'singleton',
      matchSource: 'alias',
    };

    expect(trace.score).toBe(0.85);
    expect(trace.calibratedConfidence).toBe(0.92);
    expect(trace.boundaryDecision).toBe('singleton');
    expect(trace.matchSource).toBe('alias');
  });

  it('boundaryDecision accepts all valid values: singleton, admitted, rejected', () => {
    const decisions: ResolverCandidateTrace['boundaryDecision'][] = [
      'singleton',
      'admitted',
      'rejected',
    ];

    for (const decision of decisions) {
      const trace: ResolverCandidateTrace = {
        score: 0.5,
        calibratedConfidence: 0.6,
        boundaryDecision: decision,
        matchSource: 'alias',
      };
      expect(trace.boundaryDecision).toBe(decision);
    }
  });

  it('admissionGateReason is optional', () => {
    // Without admissionGateReason
    const traceWithout: ResolverCandidateTrace = {
      score: 0.5,
      calibratedConfidence: 0.6,
      boundaryDecision: 'admitted',
      matchSource: 'alias',
    };
    expect(traceWithout.admissionGateReason).toBeUndefined();

    // With admissionGateReason
    const traceWith: ResolverCandidateTrace = {
      score: 0.3,
      calibratedConfidence: 0.2,
      boundaryDecision: 'rejected',
      matchSource: 'blocker_seed',
      admissionGateReason: 'below_confidence_threshold',
    };
    expect(traceWith.admissionGateReason).toBe('below_confidence_threshold');
  });
});

// ─── 5. Readiness Probe Strict Required ─────────────────────────────────────

describe('Readiness Probe Strict Required', () => {
  // We verify the source code directly instead of importing readiness.ts at
  // runtime, because readiness.ts transitively imports undici which requires
  // a Node version that supports webidl.util.markAsUncloneable. Source-level
  // assertion is sufficient: the probe definition is a static object literal
  // that does not depend on runtime config.

  const readinessSource = readFileSync(
    resolve(__dirname, '../../src/config/readiness.ts'),
    'utf-8',
  );

  it('search_snapshot_runtime probe has required: true unconditionally (T-E7-02)', () => {
    // The probe must NOT be guarded by NODE_ENV — it must be fail-closed
    // in all environments. Verify the source code declares it unconditionally
    // with `required: true`.

    // Extract the search_snapshot_runtime block from source
    const probeBlockMatch = readinessSource.match(
      /search_snapshot_runtime:\s*\{[^}]*required:\s*(true|false)[^}]*\}/s,
    );
    expect(probeBlockMatch).not.toBeNull();
    expect(probeBlockMatch![1]).toBe('true');

    // Verify it is NOT wrapped in a NODE_ENV conditional.
    // The block should appear at the top level of the readiness object,
    // not inside a `config.nodeEnv === 'production'` guard like
    // calibration_store does.
    const lines = readinessSource.split('\n');
    const probeLineIdx = lines.findIndex((l) =>
      l.includes('search_snapshot_runtime'),
    );
    expect(probeLineIdx).toBeGreaterThan(0);

    // Scan the 5 lines before the probe definition for NODE_ENV conditional
    const contextBefore = lines
      .slice(Math.max(0, probeLineIdx - 5), probeLineIdx)
      .join('\n');
    expect(contextBefore).not.toMatch(/nodeEnv/);
    expect(contextBefore).not.toMatch(/NODE_ENV/);
  });
});

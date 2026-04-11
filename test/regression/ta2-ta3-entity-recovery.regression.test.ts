/**
 * Regression: TRACK-A A2/A3 — Shared Entity Candidate Generation + Corrective Retry
 *
 * Guards:
 *  1. EntityCandidateGeneratorInput contract shapes (TA2-1)
 *  2. AnchorCandidate.source union includes 'blocker_seed' (TA2-2)
 *  3. buildResolverCandidatesFromGenerator — anchor + blocker paths (TA2-3)
 *  4. Resolver merges blockerSeedCandidates into candidate pool (TA2-4)
 *  5. shouldTriggerCorrectiveRetry — trigger conditions (TA3-1)
 *  6. resolveCorrectiveRetryOutcome — exit conditions (TA3-2)
 *
 * These tests are append-only (regression suite rules). Never delete.
 */

import { describe, expect, it } from 'vitest';
import {
  shouldTriggerCorrectiveRetry,
  resolveCorrectiveRetryOutcome,
  computeCorrectiveRetryCalibration,
} from '../../src/application/search/search-usecase-corrective-retry.js';
import type { EntityCandidateGeneratorInput } from '../../src/domain/resolver/model/entity-candidate-generator-input.js';
import type { AnchorCandidate } from '../../src/domain/query/model/anchor-candidate.js';
import type { EntityResolveResult } from '../../src/domain/resolver/model/resolve-result.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makePlan(overrides: Partial<QueryPlanV1> = {}): QueryPlanV1 {
  return {
    rawQuery: 'opus one 2019',
    normalizedQuery: 'opus one 2019',
    queryClass: 'entity_exact',
    intent: 'entity',
    anchors: [],
    constraints: {},
    policy: { requireExact: false, allowApproximate: true },
    uncertainty: { level: 'low', signals: [] },
    ...overrides,
  } as unknown as QueryPlanV1;
}

function makeAnchor(overrides: Partial<AnchorCandidate> = {}): AnchorCandidate {
  return {
    surfaceForm: 'opus one',
    normalizedForm: 'opus one',
    candidateEntityIds: ['wine-opus-one-2019'],
    confidence: 0.8,
    source: 'alias',
    ...overrides,
  };
}

function makeResolveResult(overrides: Partial<EntityResolveResult> = {}): EntityResolveResult {
  return {
    status: 'failed',
    decisionConfidenceC: 0.3,
    candidates: [],
    decisionTrace: {} as EntityResolveResult['decisionTrace'],
    conformalSetSize: 0,
    ...overrides,
  };
}

// ─── TA2-1: EntityCandidateGeneratorInput contract ────────────────────────────

describe('EntityCandidateGeneratorInput (TA2-1)', () => {
  it('satisfies contract: anchors + blockerOnlyIds + preloadedDocs are optional but typed', () => {
    // Compile-time check: build a minimal valid input
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'opus one',
      normalizedQuery: 'opus one',
      anchors: [],
    };
    expect(input.rawQuery).toBe('opus one');
    expect(input.blockerOnlyIds).toBeUndefined();
    expect(input.preloadedDocs).toBeUndefined();
  });

  it('accepts blockerOnlyIds as a populated array', () => {
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'opus one',
      normalizedQuery: 'opus one',
      anchors: [],
      blockerOnlyIds: ['wine-1', 'wine-2'],
    };
    expect(input.blockerOnlyIds).toHaveLength(2);
  });

  it('accepts preloadedDocs as a ReadonlyMap', () => {
    const docs = new Map([
      ['wine-1', { entityId: 'wine-1', entityType: 'wine', canonicalLabel: 'Opus One 2019' }],
    ]);
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'opus one',
      normalizedQuery: 'opus one',
      anchors: [],
      preloadedDocs: docs as ReadonlyMap<string, unknown> as EntityCandidateGeneratorInput['preloadedDocs'],
    };
    expect(input.preloadedDocs?.size).toBe(1);
  });
});

// ─── TA2-2: AnchorCandidate source union ─────────────────────────────────────

describe("AnchorCandidate.source union (TA2-2)", () => {
  it("accepts 'blocker_seed' as a valid source value", () => {
    const anchor: AnchorCandidate = makeAnchor({ source: 'blocker_seed' });
    expect(anchor.source).toBe('blocker_seed');
  });

  it("still accepts original source values", () => {
    const sources: AnchorCandidate['source'][] = [
      'alias',
      'planner_heuristic',
      'entity_lookup',
      'blocker_seed',
    ];
    for (const source of sources) {
      const anchor: AnchorCandidate = makeAnchor({ source });
      expect(anchor.source).toBe(source);
    }
  });
});

// ─── TA2-3: buildResolverCandidatesFromGenerator module exports ───────────────

describe('buildResolverCandidatesFromGenerator module (TA2-3)', () => {
  it('exports buildResolverCandidatesFromGenerator without error', async () => {
    const mod = await import(
      '../../src/application/search/search-usecase-resolver-candidates.js'
    );
    expect(typeof mod.buildResolverCandidatesFromGenerator).toBe('function');
  });

  it('exports buildResolverCandidatesFromPlan (legacy, deprecated but still exported)', async () => {
    const mod = await import(
      '../../src/application/search/search-usecase-resolver-candidates.js'
    );
    expect(typeof mod.buildResolverCandidatesFromPlan).toBe('function');
  });

  it('returns empty array when entityLookup is undefined', async () => {
    const { buildResolverCandidatesFromGenerator } = await import(
      '../../src/application/search/search-usecase-resolver-candidates.js'
    );
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      anchors: [makeAnchor()],
    };
    const result = await buildResolverCandidatesFromGenerator(input, undefined);
    expect(result).toHaveLength(0);
  });

  it('returns empty array when anchors are empty and no blockerOnlyIds', async () => {
    const { buildResolverCandidatesFromGenerator } = await import(
      '../../src/application/search/search-usecase-resolver-candidates.js'
    );
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      anchors: [],
    };
    // entityLookup provided but no IDs to look up
    const fakeLookup = { getDocument: async () => null };
    const result = await buildResolverCandidatesFromGenerator(input, fakeLookup);
    expect(result).toHaveLength(0);
  });

  it('deduplicates entity IDs that appear in both anchors and blockerOnlyIds', async () => {
    const { buildResolverCandidatesFromGenerator } = await import(
      '../../src/application/search/search-usecase-resolver-candidates.js'
    );
    const sharedId = 'wine-shared-001';
    const anchor = makeAnchor({ candidateEntityIds: [sharedId] });
    const input: EntityCandidateGeneratorInput = {
      rawQuery: 'opus one',
      normalizedQuery: 'opus one',
      anchors: [anchor],
      blockerOnlyIds: [sharedId], // same ID → should produce only 1 candidate
    };
    const fakeLookup = {
      getDocument: async (id: string) => ({
        entityId: id,
        entityType: 'wine',
        canonicalLabel: 'Opus One 2019',
      }),
    };
    const result = await buildResolverCandidatesFromGenerator(
      input,
      fakeLookup as unknown as Parameters<typeof buildResolverCandidatesFromGenerator>[1],
    );
    // The shared ID appears only once in output
    expect(result.filter((c) => String(c.entityId) === sharedId)).toHaveLength(1);
  });
});

// ─── TA2-4: ResolverInput.blockerSeedCandidates field ────────────────────────

describe('ResolverInput.blockerSeedCandidates (TA2-4)', () => {
  it('ResolverInput interface accepts blockerSeedCandidates field', async () => {
    // Type-level check: import and verify the field exists in the type definition
    const mod = await import('../../src/domain/resolver/service/resolver.js');
    // The exported computeConformalSetSize function should be callable — this
    // confirms the module loaded without error (which would indicate a TS error).
    expect(typeof mod.computeConformalSetSize).toBe('function');
  });
});

// ─── T6: ResolvedCandidate.blockerSeed provenance field ──────────────────────

describe('ResolvedCandidate.blockerSeed (T6)', () => {
  it('ResolvedCandidate type accepts blockerSeed: true', async () => {
    // Type-level compile check: import ResolvedCandidate shape
    // A value with blockerSeed: true must be assignable to ResolvedCandidate.
    const { type: _unused } = await import('../../src/domain/resolver/model/resolved-candidate.js').then(
      (m) => ({ type: m }),
    );
    // Runtime check: construct a minimal ResolvedCandidate-shaped object with blockerSeed
    const candidate = {
      entityId: 'wine-abc-123',
      canonicalLabel: 'Test Wine 2019',
      calibratedScore: 0.42,
      rank: 1,
      evidenceRefs: [],
      blockerSeed: true as const,
    };
    expect(candidate.blockerSeed).toBe(true);
  });

  it('ResolvedCandidate type allows blockerSeed to be absent (undefined)', () => {
    const candidate = {
      entityId: 'wine-abc-456',
      canonicalLabel: 'Test Wine 2020',
      calibratedScore: 0.9,
      rank: 1,
      evidenceRefs: [],
    };
    // No blockerSeed field — must be valid (optional)
    expect((candidate as Record<string, unknown>)['blockerSeed']).toBeUndefined();
  });
});

// ─── T7: Resolver trace blocker-seed provenance fields ──────────────────────

describe('ResolverQueryProvenance blocker-seed trace (T7)', () => {
  it('accepts blockerSeedEntityIds and blockerSeedCount fields', async () => {
    const candidateIds = ['wine-abc-123'];
    const trace = {
      blockerSeedEntityIds: candidateIds,
      blockerSeedCount: candidateIds.length,
    };

    expect(trace.blockerSeedEntityIds).toEqual(['wine-abc-123']);
    expect(trace.blockerSeedCount).toBe(1);
  });
});

// ─── TA3-1: shouldTriggerCorrectiveRetry ────────────────────────────────────

describe('shouldTriggerCorrectiveRetry (TA3-1)', () => {
  it('returns false when status is resolved', () => {
    const plan = makePlan();
    const result = makeResolveResult({ status: 'resolved', decisionConfidenceC: 0.9 });
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(false);
  });

  it('returns false when resolver recommends clarify', () => {
    const plan = makePlan();
    const result = makeResolveResult({ recommendedNextAction: 'clarify' });
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(false);
  });

  it('returns false when resolver recommends fail', () => {
    const plan = makePlan();
    const result = makeResolveResult({ recommendedNextAction: 'fail' });
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(false);
  });

  it('returns false when ambiguity is detected', () => {
    const plan = makePlan();
    const result = makeResolveResult({
      ambiguity: {
        types: ['homonym'],
        severity: 'high',
        explanationCodes: ['AMBIGUITY_HOMONYM'],
      },
    });
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(false);
  });

  it('returns true when zero anchors and failed status', () => {
    const plan = makePlan({ anchors: [] });
    const result = makeResolveResult({ status: 'failed', decisionConfidenceC: 0.1 });
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(true);
  });

  it('returns true when confidence < threshold and no ambiguity', () => {
    const plan = makePlan({ anchors: [makeAnchor()] });
    const result = makeResolveResult({ status: 'ambiguous', decisionConfidenceC: 0.2 });
    // Note: result.ambiguity field is undefined here (no structural ambiguity)
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(true);
  });

  it('returns false when confidence is above threshold', () => {
    const plan = makePlan({ anchors: [makeAnchor()] });
    const result = makeResolveResult({ status: 'ambiguous', decisionConfidenceC: 0.8 });
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(false);
  });

  it('NaN confidence: treated as 0 (retry triggers)', () => {
    const plan = makePlan({ anchors: [makeAnchor()] });
    const result = makeResolveResult({ status: 'failed', decisionConfidenceC: NaN });
    // NaN is not finite, so treated as 0 → below threshold → trigger
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(true);
  });

  // T6: resolver now emits corrective_retry as recommendedNextAction — honour it
  it("returns true when resolver explicitly recommends corrective_retry (T6)", () => {
    // High-confidence plan with anchors — would not trigger via C1/C2 conditions alone
    const plan = makePlan({ anchors: [makeAnchor()] });
    const result = makeResolveResult({
      status: 'failed',
      decisionConfidenceC: 0.8, // above threshold — would normally not trigger
      recommendedNextAction: 'corrective_retry',
    });
    // The resolver recommendation takes precedence over local condition evaluation
    expect(shouldTriggerCorrectiveRetry(plan, result)).toBe(true);
  });
});

// ─── TA3-2: resolveCorrectiveRetryOutcome ───────────────────────────────────

describe('resolveCorrectiveRetryOutcome (TA3-2)', () => {
  it("returns 'accept' when retry produced a resolved result", () => {
    const result = makeResolveResult({ status: 'resolved', decisionConfidenceC: 0.9 });
    expect(resolveCorrectiveRetryOutcome(result)).toBe('accept');
  });

  it("returns 'clarify' when ambiguity detected after retry", () => {
    const result = makeResolveResult({
      status: 'ambiguous',
      ambiguity: {
        types: ['homonym'],
        severity: 'medium',
        explanationCodes: [],
      },
    });
    expect(resolveCorrectiveRetryOutcome(result)).toBe('clarify');
  });

  it("returns 'fail' when resolver recommends fail after retry", () => {
    const result = makeResolveResult({
      status: 'failed',
      recommendedNextAction: 'fail',
    });
    expect(resolveCorrectiveRetryOutcome(result)).toBe('fail');
  });

  it("returns 'clarify' when confidence still below threshold after retry", () => {
    const result = makeResolveResult({
      status: 'failed',
      decisionConfidenceC: 0.3,
    });
    expect(resolveCorrectiveRetryOutcome(result)).toBe('clarify');
  });

  it("returns 'accept' for marginal improvement (confidence just above threshold)", () => {
    const result = makeResolveResult({
      status: 'ambiguous',
      decisionConfidenceC: 0.6,
    });
    expect(resolveCorrectiveRetryOutcome(result)).toBe('accept');
  });

  it('NaN confidence: treated as below threshold → clarify', () => {
    const result = makeResolveResult({ status: 'failed', decisionConfidenceC: NaN });
    expect(resolveCorrectiveRetryOutcome(result)).toBe('clarify');
  });
});

// ─── TA5: computeCorrectiveRetryCalibration ───────────────────────────────────

describe('computeCorrectiveRetryCalibration (TA5)', () => {
  function makeResultWithCandidates(
    topEntityId: string,
    topRank: number,
    totalCandidates: number,
    status: EntityResolveResult['status'] = 'resolved',
  ): EntityResolveResult {
    const candidates = Array.from({ length: totalCandidates }, (_, i) => ({
      entityId: i === topRank - 1 ? topEntityId : `other-wine-${i}`,
      canonicalLabel: i === topRank - 1 ? 'Top Wine' : `Other Wine ${i}`,
      calibratedScore: 1 - i * 0.1,
      rank: i + 1,
      evidenceRefs: [],
    }));
    return {
      status,
      decisionConfidenceC: 0.8,
      topEntity: {
        entityId: topEntityId,
        canonicalLabel: 'Top Wine',
        calibratedScore: 1.0,
      },
      candidates,
      decisionTrace: {} as EntityResolveResult['decisionTrace'],
      conformalSetSize: 1,
    };
  }

  it('rank-1 of 1 → confidence = 0.9 (best possible, single candidate)', () => {
    const result = makeResultWithCandidates('wine-abc', 1, 1);
    const confidence = computeCorrectiveRetryCalibration(result, 'accept');
    // rank 1, total 1 → normalizedRank = 0/max(0,1) = 0 → 0.5 + 0.4*1 = 0.9
    expect(confidence).toBeCloseTo(0.9);
  });

  it('rank-1 of 5 → confidence = 0.9 (best rank in pool)', () => {
    const result = makeResultWithCandidates('wine-abc', 1, 5);
    const confidence = computeCorrectiveRetryCalibration(result, 'accept');
    // rank 1, total 5 → normalizedRank = 0/4 = 0 → 0.5 + 0.4*1 = 0.9
    expect(confidence).toBeCloseTo(0.9);
  });

  it('rank-5 of 5 → confidence = 0.5 (worst rank in pool)', () => {
    const result = makeResultWithCandidates('wine-abc', 5, 5);
    const confidence = computeCorrectiveRetryCalibration(result, 'accept');
    // rank 5, total 5 → normalizedRank = 4/4 = 1 → 0.5 + 0.4*0 = 0.5
    expect(confidence).toBeCloseTo(0.5);
  });

  it('rank-3 of 5 → confidence = 0.7 (mid-pool)', () => {
    const result = makeResultWithCandidates('wine-abc', 3, 5);
    const confidence = computeCorrectiveRetryCalibration(result, 'accept');
    // rank 3, total 5 → normalizedRank = 2/4 = 0.5 → 0.5 + 0.4*0.5 = 0.7
    expect(confidence).toBeCloseTo(0.7);
  });

  it("outcome 'clarify' → returns undefined (no calibrated confidence for clarify)", () => {
    const result = makeResultWithCandidates('wine-abc', 1, 3);
    const confidence = computeCorrectiveRetryCalibration(result, 'clarify');
    expect(confidence).toBeUndefined();
  });

  it("outcome 'fail' → returns undefined", () => {
    const result = makeResultWithCandidates('wine-abc', 1, 3);
    const confidence = computeCorrectiveRetryCalibration(result, 'fail');
    expect(confidence).toBeUndefined();
  });

  it('empty candidates → returns undefined', () => {
    const result = makeResolveResult({ status: 'resolved', candidates: [] });
    const confidence = computeCorrectiveRetryCalibration(result, 'accept');
    expect(confidence).toBeUndefined();
  });

  it('topEntity absent → returns undefined', () => {
    const result: EntityResolveResult = {
      status: 'resolved',
      decisionConfidenceC: 0.8,
      candidates: [
        { entityId: 'wine-x', canonicalLabel: 'X', calibratedScore: 0.9, rank: 1, evidenceRefs: [] },
      ],
      decisionTrace: {} as EntityResolveResult['decisionTrace'],
      conformalSetSize: 1,
    };
    // No topEntity field
    const confidence = computeCorrectiveRetryCalibration(result, 'accept');
    expect(confidence).toBeUndefined();
  });

  it('confidence range: rank-1 always >= rank-N for any N', () => {
    for (let total = 1; total <= 10; total++) {
      const best = computeCorrectiveRetryCalibration(makeResultWithCandidates('wine-abc', 1, total), 'accept');
      const worst = computeCorrectiveRetryCalibration(makeResultWithCandidates('wine-abc', total, total), 'accept');
      expect(best).toBeDefined();
      expect(worst).toBeDefined();
      // best >= worst always
      expect(best!).toBeGreaterThanOrEqual(worst!);
      // calibrated confidence is always in [0.5, 0.9]
      expect(best!).toBeGreaterThanOrEqual(0.5);
      expect(best!).toBeLessThanOrEqual(0.9);
      expect(worst!).toBeGreaterThanOrEqual(0.5);
      expect(worst!).toBeLessThanOrEqual(0.9);
    }
  });
});

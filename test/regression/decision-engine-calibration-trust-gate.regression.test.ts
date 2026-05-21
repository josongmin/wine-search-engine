/**
 * Regression: DecisionEngine Step 2.5 (`applyCalibrationTrustGate`) must
 * downgrade `resolved` to `ambiguous + clarify` when the upstream
 * `decisionTrace.calibrationTrusted === false` AND the evidence summary
 * does NOT carry an exact identity artifact (`exactnessTier ∈ {exact,
 * alias_exact}`).
 *
 * Root cause being prevented:
 *   The hybrid/mixed ranked-route lifts the fused ranker's `finalScore`
 *   directly into `decisionConfidenceC` (see
 *   `search-usecase-ranked-route-resolve.ts`) and flags the trace
 *   `calibrationTrusted: false`. The numeric gate (Step 2) compares
 *   C against `T_resolve` regardless of trust — and BM25 + dense fusion
 *   produces non-trivial finalScores even for queries that match nothing
 *   semantic (`zzz_extremely_unknown_wine_xyz_no_match_9999`). Without
 *   this gate, gibberish reaches `resolved + return_result` via the lift
 *   path, conflating a raw ranker signal with a calibrated probability.
 *
 *   The fix mirrors AdmissionGate §e's existing `calibrationTrusted=false`
 *   skip on the confidence-refusal floor (admission-gate.ts:237) at the
 *   resolve seam: untrusted C is not a probability, so the
 *   probability-space threshold comparison is undefined. The substitute
 *   trust signal is a resolver-side exact identity match (the lexical
 *   binding from query surface to entity canonical/alias surface, which
 *   needs no probability calibration to be trustworthy).
 *
 * Contract under test:
 *   1. `calibrationTrusted: false` + no exact identity → downgrade with
 *      `CALIBRATION_TRUST_GATE_DOWNGRADE` in `rulesApplied`.
 *   2. `calibrationTrusted: false` + exact identity artifact → preserved
 *      with `CALIBRATION_TRUST_GATE_EXACT_IDENTITY` in `rulesApplied`.
 *   3. `calibrationTrusted: true` + no exact identity → preserved (gate
 *      no-ops; downstream evidence/policy steps may still downgrade).
 *   4. The gate only applies to `state.status === 'resolved'` — already
 *      `ambiguous`/`failed` states are passed through unchanged.
 */

import { describe, expect, it } from 'vitest';
import { DecisionEngine } from '../../src/domain/decision/service/decision-engine.js';
import type { DecisionInput } from '../../src/domain/decision/model/decision-input.js';
import type { EntityResolveResult } from '../../src/domain/resolver/model/resolve-result.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';
import type { ThresholdStore } from '../../src/domain/query/port/threshold-store.port.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../../src/domain/query/model/threshold-profile.js';
import { DEFAULT_ALPHA, computeConformalSetSize } from '../../src/domain/resolver/service/resolver.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';

const TEST_SNAPSHOT = {
  snapshot_id: 'test-snapshot',
  model_versions: { embedding: 'test-v1' },
  index_versions: { wine_content: 'wine_content_v1' },
  policy_rule_version: '1.0.0',
  threshold_profile_id: 'heuristic-v1.0',
  planner_version: '1.0.0',
  feature_flags: {},
} as const;

const TEST_THRESHOLD_STORE: ThresholdStore = {
  getProfile: async () => DEFAULT_THRESHOLD_PROFILE,
};

function makeQueryPlan(): QueryPlanV1 {
  return {
    rawQuery: 'unit-test',
    normalizedQuery: 'unit-test',
    intent: 'entity_exact',
    route: 'entity',
    retrievalMode: 'entity_lookup',
    queryClass: 'short_entity',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {
      requireExact: false,
      allowApproximate: true,
      requireClarification: false,
      clarificationBias: 0,
      fallbackMode: 'clarify',
      policyReasonCodes: [],
    },
    uncertainty: {
      overall: 0.1,
      ambiguityDetected: false,
      ambiguityTypes: [],
      ambiguitySeverity: 'low',
      decisionEffect: 'trace_only',
      parserConfidence: 0.95,
      anchorConfidence: 0.9,
      constraintConfidence: 0.8,
    },
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'heuristic-v1.0',
  } as unknown as QueryPlanV1;
}

function makeResolveResult(
  C: number,
  calibrationTrusted: boolean,
): EntityResolveResult {
  const entityId = createEntityId('entity-x');
  return {
    status: 'resolved',
    topEntity: {
      entityId,
      canonicalLabel: 'Entity X',
      calibratedScore: C,
    },
    candidates: [
      {
        entityId,
        canonicalLabel: 'Entity X',
        calibratedScore: C,
        rank: 1,
        evidenceRefs: ['alias:x'],
      },
    ],
    decisionTrace: {
      queryClass: 'short_entity',
      top1CalibratedScore: C,
      top2CalibratedScore: undefined,
      calibratedGap: undefined,
      decisionConfidenceC: C,
      calibrationTrusted,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0.45, gapThreshold: 0.03 },
      outcomeReasonCodes: ['HYBRID_ROUTE'],
    },
    conformalSetSize: computeConformalSetSize(C, DEFAULT_ALPHA, 1),
  };
}

function makeInput(opts: {
  C: number;
  calibrationTrusted: boolean;
  exactnessTier: 'exact' | 'alias_exact' | 'alias_fuzzy' | 'none';
}): DecisionInput {
  const queryPlan = makeQueryPlan();
  const resolveResult = makeResolveResult(opts.C, opts.calibrationTrusted);
  const evidenceSummary: DecisionInput['evidenceSummary'] = {
    identityEvidencePresent: opts.exactnessTier !== 'none',
    identityEvidence: {
      source: 'identity_artifact',
      resolveTopEntityPresent: true,
      winnerIdentityArtifactPresent: opts.exactnessTier !== 'none',
      winnerIdentityArtifactMatchesResolveResult: opts.exactnessTier !== 'none',
      exactnessTier: opts.exactnessTier,
      identityEvidenceRefCount: opts.exactnessTier === 'none' ? 0 : 1,
    },
  };
  return {
    queryPlan,
    resolveResult,
    identityResolveResult: resolveResult,
    effectiveRoute: queryPlan.route,
    effectiveRetrievalMode: queryPlan.retrievalMode,
    policy: {
      requireExact: false,
      allowApproximate: true,
      requireClarification: false,
      clarificationBias: 0,
      fallbackMode: 'clarify',
      policyReasonCodes: [],
    },
    uncertainty: {
      overall: 0.1,
      ambiguityDetected: false,
      ambiguityTypes: [],
      ambiguitySeverity: 'low',
      decisionEffect: 'trace_only',
      parserConfidence: 0.95,
      anchorConfidence: 0.9,
      constraintConfidence: 0.8,
    },
    evidenceSummary,
    provenanceContract: {
      policy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: false,
        requireAnchorEvidence: false,
      },
      observed: {
        identityEvidenceSatisfied: true,
        constraintEvidenceSatisfied: true,
        anchorEvidenceSatisfied: true,
        topEntityPresent: true,
        rankedTopResultPresent: true,
        matchedConstraintAttributes: [],
        unmetConstraintAttributes: [],
        anchorSignalTypes: [],
      },
      missing: [],
    },
    conformalSetSize: 1,
  } as unknown as DecisionInput;
}

describe('DecisionEngine.applyCalibrationTrustGate', () => {
  const engine = new DecisionEngine(TEST_THRESHOLD_STORE);

  it('downgrades to ambiguous + clarify when calibrationTrusted=false AND no exact identity', async () => {
    const input = makeInput({ C: 0.89, calibrationTrusted: false, exactnessTier: 'none' });
    const output = await engine.decide(input, TEST_SNAPSHOT);

    expect(output.decisionStatus).toBe('ambiguous');
    expect(output.nextAction).toBe('clarify');
    expect(output.decisionTrace.rulesApplied).toContain('CALIBRATION_TRUST_GATE_DOWNGRADE');
  });

  it.each([
    ['exact', 'exact' as const],
    ['alias_exact', 'alias_exact' as const],
  ])(
    'preserves resolved when calibrationTrusted=false AND exactnessTier=%s (substitute trust signal)',
    async (_label, exactnessTier) => {
      const input = makeInput({ C: 0.89, calibrationTrusted: false, exactnessTier });
      const output = await engine.decide(input, TEST_SNAPSHOT);

      expect(output.decisionStatus).toBe('resolved');
      expect(output.decisionTrace.rulesApplied).toContain('CALIBRATION_TRUST_GATE_EXACT_IDENTITY');
    },
  );

  it('no-ops when calibrationTrusted=true (downstream gates carry the resolved verdict)', async () => {
    const input = makeInput({ C: 0.89, calibrationTrusted: true, exactnessTier: 'none' });
    const output = await engine.decide(input, TEST_SNAPSHOT);

    expect(output.decisionTrace.rulesApplied).not.toContain('CALIBRATION_TRUST_GATE_DOWNGRADE');
    expect(output.decisionTrace.rulesApplied).not.toContain('CALIBRATION_TRUST_GATE_EXACT_IDENTITY');
  });

  it('does not fire for non-resolved states (ambiguous from numeric gate is passed through)', async () => {
    // C below T_resolve=0.45 → numeric gate emits ambiguous → gate skips.
    const input = makeInput({ C: 0.2, calibrationTrusted: false, exactnessTier: 'none' });
    const output = await engine.decide(input, TEST_SNAPSHOT);

    expect(output.decisionStatus).toBe('ambiguous');
    expect(output.decisionTrace.rulesApplied).not.toContain('CALIBRATION_TRUST_GATE_DOWNGRADE');
    expect(output.decisionTrace.rulesApplied).not.toContain('CALIBRATION_TRUST_GATE_EXACT_IDENTITY');
  });

  it('treats alias_fuzzy identity as insufficient (downgrades like none)', async () => {
    // alias_fuzzy is not in {exact, alias_exact}, so it does NOT substitute
    // for calibration trust — the resolve still downgrades. This keeps
    // phonetic-collision and fuzzy-only matches from masquerading as
    // probability-calibrated decisions.
    const input = makeInput({ C: 0.89, calibrationTrusted: false, exactnessTier: 'alias_fuzzy' });
    const output = await engine.decide(input, TEST_SNAPSHOT);

    expect(output.decisionStatus).toBe('ambiguous');
    expect(output.decisionTrace.rulesApplied).toContain('CALIBRATION_TRUST_GATE_DOWNGRADE');
  });
});

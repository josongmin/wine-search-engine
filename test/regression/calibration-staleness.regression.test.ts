/**
 * Regression test (P0.1): when the calibrator's params are stale or
 * never-fitted, AdmissionGate MUST NOT apply the ConfidenceRefusalPolicy.
 *
 * The original P0.1 bug was the opposite: with `calibrationTrusted` absent
 * or computed from a row that had never been fitted by the nightly
 * auto-pipeline, AdmissionGate silently refused legitimate low-C answers
 * AND failed to refuse hallucinated low-C answers (because the C value
 * was derived from identity-fallback calibration that doesn't actually
 * track correctness).
 *
 * Invariant: this test exists forever (regression lane is append-only).
 */
import { describe, expect, it } from 'vitest';
import { AdmissionGate } from '../../src/domain/decision/service/admission-gate.js';
import { ConfidenceRefusalPolicy } from '../../src/domain/decision/service/confidence-refusal.js';
import {
  hasAnchorEvidence,
  hasConstraintEvidence,
  hasIdentityEvidence,
  type DecisionInput,
} from '../../src/domain/decision/model/decision-input.js';
import type { DecisionSnapshot } from '../../src/domain/shared/types/index.js';
import type { EntityResolveResult } from '../../src/domain/resolver/model/resolve-result.js';
import { computeConformalSetSize, DEFAULT_ALPHA } from '../../src/domain/resolver/service/resolver.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';

const TEST_SNAPSHOT: DecisionSnapshot = {
  model_versions: { embedding: 'bge-m3-v1' },
  index_versions: { wine_content: '2026-04-01' },
  policy_rule_version: '1.0.0',
  threshold_profile_id: 'default-v1',
  planner_version: '1.0.0',
  feature_flags: {},
};

function makeResolverResult(
  C: number,
  calibrationTrusted: boolean | undefined,
): EntityResolveResult {
  const topEntityId = createEntityId('entity-test-wine');
  return {
    status: 'resolved',
    decisionConfidenceC: C,
    topEntity: {
      entityId: topEntityId,
      canonicalLabel: 'Test Wine',
      calibratedScore: C,
    },
    candidates: [
      {
        entityId: topEntityId,
        canonicalLabel: 'Test Wine',
        calibratedScore: C,
        rank: 1,
        evidenceRefs: ['alias:test'],
      },
    ],
    decisionTrace: {
      queryClass: 'short_entity',
      top1CalibratedScore: C,
      top2CalibratedScore: C - 0.3,
      calibratedGap: 0.3,
      decisionConfidenceC: C,
      ...(calibrationTrusted !== undefined ? { calibrationTrusted } : {}),
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0.75, gapThreshold: 0.15 },
      outcomeReasonCodes: [],
    },
    conformalSetSize: computeConformalSetSize(C, DEFAULT_ALPHA, 1),
  };
}

function makeQueryPlan(): QueryPlanV1 {
  return {
    rawQuery: 'test wine',
    normalizedQuery: 'test wine',
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
    thresholdProfileId: 'default-v1',
  };
}

function makeStrongIdentityEvidence() {
  return {
    identityEvidencePresent: true,
    identityEvidence: {
      source: 'identity_artifact' as const,
      resolveTopEntityPresent: true,
      winnerIdentityArtifactPresent: true,
      winnerIdentityArtifactMatchesResolveResult: true,
      lanePresence: 'corroborated' as const,
      exactnessTier: 'exact' as const,
      identityEvidenceRefCount: 1,
    },
  };
}

function makeInput(opts: {
  readonly C: number;
  readonly calibrationTrusted: boolean | undefined;
}): DecisionInput {
  const queryPlan = makeQueryPlan();
  const resolveResult = makeResolverResult(opts.C, opts.calibrationTrusted);
  const evidenceSummary = makeStrongIdentityEvidence();
  const policy = {
    requireIdentitySeal: queryPlan.intent === 'entity_exact',
    requireConstraintEvidence: queryPlan.constraints.hard.length > 0,
    requireAnchorEvidence: queryPlan.route === 'mixed' && queryPlan.anchors.length > 0,
  };
  return {
    queryPlan,
    effectiveRoute: queryPlan.route,
    effectiveRetrievalMode: queryPlan.retrievalMode as DecisionInput['effectiveRetrievalMode'],
    resolveResult,
    identityResolveResult: resolveResult,
    policy: {
      requireExact: false,
      allowApproximate: true,
      requireClarification: false,
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
      policy,
      observed: {
        identityEvidenceSatisfied: hasIdentityEvidence(evidenceSummary),
        constraintEvidenceSatisfied: hasConstraintEvidence(evidenceSummary),
        anchorEvidenceSatisfied: hasAnchorEvidence(evidenceSummary),
        topEntityPresent: true,
        rankedTopResultPresent: false,
        matchedConstraintAttributes: [],
        unmetConstraintAttributes: [],
        anchorSignalTypes: [],
      },
      missing: [],
    },
  };
}

describe('regression: AdmissionGate trust gate on calibrationTrusted (P0.1)', () => {
  const LOW_C = 0.2; // below the 0.45 default refusal threshold
  const HIGH_C = 0.9;

  it('with policy + calibrationTrusted=true → refuses low-C decisions', () => {
    const gate = new AdmissionGate(new ConfidenceRefusalPolicy(0.45));
    const input = makeInput({ C: LOW_C, calibrationTrusted: true });
    const result = gate.check(input, TEST_SNAPSHOT);
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      expect(result.reason).toBe('CONFIDENCE_BELOW_THRESHOLD');
    }
  });

  it('with policy + calibrationTrusted=false → does NOT refuse (trust withheld)', () => {
    // This is the P0.1 invariant: stale/never-fitted calibration must not
    // drive the hallucination guard. The decision flows through the
    // standard admission policy instead.
    const gate = new AdmissionGate(new ConfidenceRefusalPolicy(0.45));
    const input = makeInput({ C: LOW_C, calibrationTrusted: false });
    const result = gate.check(input, TEST_SNAPSHOT);
    // The standard admission policy may still reject for other reasons
    // (low C also fails policy thresholds), but the REASON must not be
    // CONFIDENCE_BELOW_THRESHOLD when the trust flag is false.
    if (!result.admitted) {
      expect(result.reason).not.toBe('CONFIDENCE_BELOW_THRESHOLD');
    }
  });

  it('with policy + calibrationTrusted absent → treated as untrusted (does NOT refuse)', () => {
    // `decisionTrace.calibrationTrusted` is a REQUIRED boolean in production —
    // the Calibrator always emits a verdict, so typecheck forbids omission and
    // this `undefined` is only reachable via a legacy test cast. When the trust
    // verdict is unknown the calibrated C is not a reliable probability, so the
    // confidence-refusal gate must be skipped (RFC-006 §6: raw scores must never
    // influence decisions). Mirrors the calibrationTrusted=false invariant.
    const gate = new AdmissionGate(new ConfidenceRefusalPolicy(0.45));
    const input = makeInput({ C: LOW_C, calibrationTrusted: undefined });
    const result = gate.check(input, TEST_SNAPSHOT);
    if (!result.admitted) {
      expect(result.reason).not.toBe('CONFIDENCE_BELOW_THRESHOLD');
    }
  });

  it('adjacent case — high-C + calibrationTrusted=false → still admits (no false refusal)', () => {
    const gate = new AdmissionGate(new ConfidenceRefusalPolicy(0.45));
    const input = makeInput({ C: HIGH_C, calibrationTrusted: false });
    const result = gate.check(input, TEST_SNAPSHOT);
    expect(result.admitted).toBe(true);
  });

  it('adjacent case — high-C + calibrationTrusted=true → admits', () => {
    const gate = new AdmissionGate(new ConfidenceRefusalPolicy(0.45));
    const input = makeInput({ C: HIGH_C, calibrationTrusted: true });
    const result = gate.check(input, TEST_SNAPSHOT);
    expect(result.admitted).toBe(true);
  });
});

/**
 * Unit tests for {@link AdmissionGate} (RFC-016) — the final closure before a
 * resolved decision is emitted to downstream consumers.
 *
 * The gate has eight rejection paths plus the admitted happy path. Prior to
 * this file, only CONFIDENCE_BELOW_THRESHOLD and POLICY_BLOCKED had any
 * regression coverage (via confidence-refusal.test.ts and authority-trace.test.ts
 * respectively) — every other FailureReason emitted by the gate was untested.
 *
 * Reasons covered here (one describe each):
 *  - IDENTITY_REFERENCE_MISSING  (a) topEntity absent / empty entityId
 *  - SNAPSHOT_MISMATCH           (a) threshold_profile_id or planner_version drift
 *  - IDENTITY_SEAL_VIOLATION     (a) policy_rule_version drift
 *  - EVIDENCE_INSUFFICIENT       (b) identity seal unsatisfied;
 *                                (d) anchor evidence required but missing;
 *                                policy 'clarify' without high ambiguity
 *  - HARD_CONSTRAINT_VIOLATION   (c) required hard-constraint evidence missing
 *  - AMBIGUITY_BLOCKED           policy 'clarify' + high-severity ambiguity
 *  - POLICY_BLOCKED              decideAdmission → 'reject'
 *  - CONFIDENCE_BELOW_THRESHOLD  (e) Epic 17.3 policy rejects low-C decisions
 *  - admitted                    happy path
 */
import { describe, expect, it } from 'vitest';
import { AdmissionGate } from '../../../src/domain/decision/service/admission-gate.js';
import { ConfidenceRefusalPolicy } from '../../../src/domain/decision/service/confidence-refusal.js';
import {
  hasAnchorEvidence,
  hasConstraintEvidence,
  hasIdentityEvidence,
  type DecisionInput,
  type EvidenceSummary,
} from '../../../src/domain/decision/model/decision-input.js';
import type { DecisionSnapshot } from '../../../src/domain/shared/types/index.js';
import type { QueryPlanV1 } from '../../../src/domain/query/model/query-plan.js';
import type { EntityResolveResult } from '../../../src/domain/resolver/model/resolve-result.js';
import type { QueryPolicy } from '../../../src/domain/query/model/query-policy.js';
import type { QueryUncertainty } from '../../../src/domain/query/model/query-uncertainty.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<DecisionSnapshot> = {}): DecisionSnapshot {
  return {
    model_versions: { embedding: 'bge-m3-v1' },
    index_versions: { wine_content: '2026-04-01' },
    policy_rule_version: '1.0.0',
    threshold_profile_id: 'default-v1',
    planner_version: '1.0.0',
    feature_flags: {},
    ...overrides,
  };
}

function makePolicy(overrides: Partial<QueryPolicy> = {}): QueryPolicy {
  return {
    requireExact: false,
    allowApproximate: false,
    requireClarification: false,
    clarificationBias: 0,
    fallbackMode: 'hybrid',
    policyReasonCodes: ['default_policy'],
    ...overrides,
  };
}

function makeUncertainty(overrides: Partial<QueryUncertainty> = {}): QueryUncertainty {
  return {
    overall: 0.1,
    ambiguityDetected: false,
    ambiguitySeverity: 'low',
    ...overrides,
  };
}

function makeQueryPlan(overrides: Partial<QueryPlanV1> = {}): QueryPlanV1 {
  return {
    rawQuery: 'opus one',
    normalizedQuery: 'opus one',
    intent: 'entity_exact',
    route: 'entity',
    retrievalMode: 'entity_lookup',
    queryClass: 'short_entity',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: makePolicy(),
    uncertainty: makeUncertainty(),
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default-v1',
    ...overrides,
  } as QueryPlanV1;
}

function makeResolveResult(overrides: {
  readonly C?: number;
  readonly topEntityPresent?: boolean;
  readonly topEntityId?: string;
} = {}): EntityResolveResult {
  const C = overrides.C ?? 0.85;
  const topEntityPresent = overrides.topEntityPresent ?? true;
  const topEntityId = overrides.topEntityId ?? 'entity-opus-one';
  return {
    status: 'resolved',
    candidates: topEntityPresent
      ? [{
          entityId: topEntityId as never,
          canonicalLabel: 'Opus One',
          calibratedScore: C,
          rank: 1,
          evidenceRefs: ['alias-match-1'],
        }]
      : [],
    ...(topEntityPresent
      ? {
          topEntity: {
            entityId: topEntityId as never,
            canonicalLabel: 'Opus One',
            calibratedScore: C,
          },
        }
      : {}),
    decisionTrace: {
      queryClass: 'short_entity',
      top1CalibratedScore: C,
      top2CalibratedScore: C - 0.2,
      calibratedGap: 0.2,
      decisionConfidenceC: C,
      // Default fixture treats C as a trained-calibration output so §e fires.
      // The untrusted-calibration regression tests below explicitly flip this
      // to false to verify the bypass branch.
      calibrationTrusted: true,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0.45, gapThreshold: 0.02 },
      outcomeReasonCodes: [],
    } as never,
    conformalSetSize: 1,
  };
}

function makeEvidenceSummary(overrides: Partial<EvidenceSummary> = {}): EvidenceSummary {
  return {
    identityEvidencePresent: true,
    identityEvidence: {
      source: 'identity_artifact',
      resolveTopEntityPresent: true,
      winnerIdentityArtifactPresent: true,
      winnerIdentityArtifactMatchesResolveResult: true,
      exactnessTier: 'exact',
      identityEvidenceRefCount: 1,
    },
    constraintEvidencePresent: true,
    anchorEvidencePresent: false,
    ...overrides,
  };
}

function makeDecisionInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  const queryPlan = overrides.queryPlan ?? makeQueryPlan();
  const resolveResult = overrides.resolveResult ?? makeResolveResult();
  const evidenceSummary = overrides.evidenceSummary ?? makeEvidenceSummary();
  const policy = overrides.provenanceContract?.policy ?? {
    requireIdentitySeal: queryPlan.intent === 'entity_exact',
    requireConstraintEvidence: queryPlan.constraints.hard.length > 0,
    requireAnchorEvidence: queryPlan.route === 'mixed' && queryPlan.anchors.length > 0,
  };
  return {
    queryPlan,
    effectiveRoute: 'entity',
    effectiveRetrievalMode: 'entity_lookup',
    resolveResult,
    policy: makePolicy(),
    uncertainty: makeUncertainty(),
    evidenceSummary,
    provenanceContract: overrides.provenanceContract ?? {
      policy,
      observed: {
        identityEvidenceSatisfied: hasIdentityEvidence(evidenceSummary),
        constraintEvidenceSatisfied: hasConstraintEvidence(evidenceSummary),
        anchorEvidenceSatisfied: hasAnchorEvidence(evidenceSummary),
        topEntityPresent: resolveResult.topEntity !== undefined,
        rankedTopResultPresent: false,
        matchedConstraintAttributes: [],
        unmetConstraintAttributes: [],
        anchorSignalTypes: [],
      },
      missing: [],
    },
    conformalSetSize: resolveResult.conformalSetSize,
    ...overrides,
  };
}

function expectRejectedWith(
  result: ReturnType<AdmissionGate['check']>,
  reason: string,
): void {
  expect(result.admitted).toBe(false);
  if (!result.admitted) {
    expect(result.reason).toBe(reason);
    expect(result.traceRef).toEqual(expect.any(String));
    expect(result.traceRef.length).toBeGreaterThan(0);
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('AdmissionGate.check — RFC-016 closure invariants', () => {
  const gate = new AdmissionGate();
  const snapshot = makeSnapshot();

  describe('IDENTITY_REFERENCE_MISSING (a) — identity reference required for any resolved emission', () => {
    it('rejects when resolveResult.topEntity is absent (singleton bypass cannot fabricate identity)', async () => {
      const input = makeDecisionInput({
        resolveResult: makeResolveResult({ topEntityPresent: false }),
      });
      const result = await gate.check(input, snapshot);
      expectRejectedWith(result, 'IDENTITY_REFERENCE_MISSING');
    });

    it('rejects when topEntity.entityId is the empty string (vacuous identity ≠ valid identity)', async () => {
      const input = makeDecisionInput({
        resolveResult: makeResolveResult({ topEntityId: '   ' }),
      });
      const result = await gate.check(input, snapshot);
      expectRejectedWith(result, 'IDENTITY_REFERENCE_MISSING');
    });
  });

  describe('SNAPSHOT_MISMATCH (a) — query plan was compiled against a different snapshot', () => {
    it('rejects when snapshot.threshold_profile_id diverges from plan.thresholdProfileId', async () => {
      const result = await gate.check(
        makeDecisionInput(),
        makeSnapshot({ threshold_profile_id: 'stale-v0' }),
      );
      expectRejectedWith(result, 'SNAPSHOT_MISMATCH');
    });

    it('rejects when snapshot.planner_version diverges from plan.plannerVersion', async () => {
      const result = await gate.check(
        makeDecisionInput(),
        makeSnapshot({ planner_version: '0.9.9' }),
      );
      expectRejectedWith(result, 'SNAPSHOT_MISMATCH');
    });
  });

  describe('IDENTITY_SEAL_VIOLATION (a) — policy seal mismatch is reported distinctly from snapshot drift', () => {
    it('rejects when snapshot.policy_rule_version diverges from plan.policyRuleVersion', async () => {
      const result = await gate.check(
        makeDecisionInput(),
        makeSnapshot({ policy_rule_version: '0.0.0' }),
      );
      expectRejectedWith(result, 'IDENTITY_SEAL_VIOLATION');
    });
  });

  describe('EVIDENCE_INSUFFICIENT (b/d/policy) — identity / anchor evidence missing', () => {
    it('rejects when identity-evidence trail is unsatisfied (no identityEvidence detail + no flag)', async () => {
      const evidenceSummary = makeEvidenceSummary({
        identityEvidencePresent: false,
        ...({ identityEvidence: undefined } as never),
      });
      const input = makeDecisionInput({
        evidenceSummary,
        provenanceContract: {
          policy: {
            requireIdentitySeal: true,
            requireConstraintEvidence: false,
            requireAnchorEvidence: false,
          },
          observed: {
            identityEvidenceSatisfied: false,
            constraintEvidenceSatisfied: true,
            anchorEvidenceSatisfied: true,
            topEntityPresent: true,
            rankedTopResultPresent: false,
            matchedConstraintAttributes: [],
            unmetConstraintAttributes: [],
            anchorSignalTypes: [],
          },
          missing: ['identity_evidence'],
        },
      });
      const result = await gate.check(input, snapshot);
      expectRejectedWith(result, 'EVIDENCE_INSUFFICIENT');
    });

    it('rejects when anchor evidence is required but the trail is unsatisfied (mixed-route §5)', async () => {
      const input = makeDecisionInput({
        queryPlan: makeQueryPlan({ route: 'mixed', anchors: [{} as never] }),
        provenanceContract: {
          policy: {
            requireIdentitySeal: true,
            requireConstraintEvidence: false,
            requireAnchorEvidence: true,
          },
          observed: {
            identityEvidenceSatisfied: true,
            constraintEvidenceSatisfied: true,
            anchorEvidenceSatisfied: false,
            topEntityPresent: true,
            rankedTopResultPresent: false,
            matchedConstraintAttributes: [],
            unmetConstraintAttributes: [],
            anchorSignalTypes: [],
          },
          missing: ['anchor_evidence'],
        },
      });
      const result = await gate.check(input, snapshot);
      expectRejectedWith(result, 'EVIDENCE_INSUFFICIENT');
    });

    it('admits a preference-mode decision (requires_identity_seal=false) despite missing identity evidence', async () => {
      // RFC-016 identity-seal honoring: when admission_context emits
      // requires_identity_seal=false (list-shaped queries — recommendation /
      // similar_items / pairing), the strict identity-evidence presence is
      // irrelevant; the resolved verdict isn't claiming an identity. Both the
      // closure's identitySeal row (`!required || satisfied`) and
      // `evidenceSufficientForAdmission` honor that, so decideAdmission returns
      // 'allow' rather than auto-rejecting every recommendation query with
      // EVIDENCE_INSUFFICIENT. (The only surviving clarify path is high-severity
      // ambiguity → AMBIGUITY_BLOCKED, covered by the severity=high test.)
      const input = makeDecisionInput({
        resolveResult: makeResolveResult({ C: 0.85 }),
        evidenceSummary: makeEvidenceSummary({
          identityEvidencePresent: false,
          ...({ identityEvidence: undefined } as never),
        }),
        provenanceContract: {
          policy: {
            requireIdentitySeal: false,
            requireConstraintEvidence: false,
            requireAnchorEvidence: false,
          },
          observed: {
            identityEvidenceSatisfied: false,
            constraintEvidenceSatisfied: true,
            anchorEvidenceSatisfied: true,
            topEntityPresent: true,
            rankedTopResultPresent: false,
            matchedConstraintAttributes: [],
            unmetConstraintAttributes: [],
            anchorSignalTypes: [],
          },
          missing: [],
        },
      });
      const result = await gate.check(input, snapshot);
      expect(result.admitted).toBe(true);
    });
  });

  describe('HARD_CONSTRAINT_VIOLATION (c) — required hard-constraint evidence absent on resolved decision', () => {
    it('rejects when the policy requires constraint evidence but the trail is unmet (KIL vintage-mismatch case)', async () => {
      // KIL: "샤또마고 2016" requested, only 2015 exists. Plan has hard
      // constraint vintage=2016, but the top entity matches no required
      // attributes → constraintEvidenceSatisfied=false → reject.
      const input = makeDecisionInput({
        queryPlan: makeQueryPlan({
          constraints: {
            hard: [{ attribute: 'vintage', operator: '=', value: 2016 } as never],
            soft: [],
            inferred: [],
          },
        }),
        provenanceContract: {
          policy: {
            requireIdentitySeal: true,
            requireConstraintEvidence: true,
            requireAnchorEvidence: false,
          },
          observed: {
            identityEvidenceSatisfied: true,
            constraintEvidenceSatisfied: false,
            anchorEvidenceSatisfied: true,
            topEntityPresent: true,
            rankedTopResultPresent: false,
            matchedConstraintAttributes: [],
            unmetConstraintAttributes: ['vintage'],
            anchorSignalTypes: [],
          },
          missing: ['constraint_evidence'],
        },
      });
      const result = await gate.check(input, snapshot);
      expectRejectedWith(result, 'HARD_CONSTRAINT_VIOLATION');
    });

    it('admits when no hard constraints are required (policy.requireConstraintEvidence=false bypasses §c)', async () => {
      const input = makeDecisionInput({
        // Default policy — no hard constraints → policy.requireConstraintEvidence=false.
      });
      const result = await gate.check(input, snapshot);
      expect(result.admitted).toBe(true);
    });
  });

  describe('AMBIGUITY_BLOCKED — policy clarify outcome at high ambiguity severity', () => {
    /**
     * Severity-discrimination invariant: high severity must route the clarify
     * outcome to AMBIGUITY_BLOCKED, while medium/low severity (when paired
     * with sufficient identity evidence) must admit instead of falling into
     * EVIDENCE_INSUFFICIENT. The two sibling tests below cover both halves so
     * a regression that collapses the clarify-severity split is caught.
     */
    it('admits when ambiguity severity is medium and all other invariants are satisfied (no clarify branch taken)', async () => {
      const input = makeDecisionInput({
        ambiguitySummary: {
          types: ['homonym'],
          severity: 'medium',
          sources: ['resolver'],
        },
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
            rankedTopResultPresent: false,
            matchedConstraintAttributes: [],
            unmetConstraintAttributes: [],
            anchorSignalTypes: [],
          },
          missing: [],
        },
      });
      const result = await gate.check(input, snapshot);
      expect(result.admitted).toBe(true);
    });

    it('rejects with AMBIGUITY_BLOCKED when severity=high (clarify branch differentiates by severity over EVIDENCE_INSUFFICIENT)', async () => {
      // Trigger sequence:
      //   1. identitySeal satisfied (identityEvidenceSatisfied=true, snapshot match)
      //   2. constraintEvidence not required, anchor not required
      //   3. no confidenceRefusal policy → §e skipped
      //   4. decideAdmission sees ambiguityHigh=true → returns 'clarify'
      //   5. ambiguity.severity === 'high' → AMBIGUITY_BLOCKED (not EVIDENCE_INSUFFICIENT)
      const input = makeDecisionInput({
        ambiguitySummary: {
          types: ['homonym'],
          severity: 'high',
          sources: ['resolver'],
        },
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
            rankedTopResultPresent: false,
            matchedConstraintAttributes: [],
            unmetConstraintAttributes: [],
            anchorSignalTypes: [],
          },
          missing: [],
        },
      });
      const result = await gate.check(input, snapshot);
      expectRejectedWith(result, 'AMBIGUITY_BLOCKED');
    });
  });

  describe('POLICY_BLOCKED — admission policy rejects upfront (route unhealthy / blocking on heuristic mode)', () => {
    it('rejects when routeHealthy is explicitly false (degraded retrieval path cannot emit binding answers)', async () => {
      const input = makeDecisionInput({
        routeHealthy: false,
      });
      const result = await gate.check(input, snapshot);
      expectRejectedWith(result, 'POLICY_BLOCKED');
    });

    it('rejects when blocking is requested under heuristic execution mode (no fallback to advisory)', async () => {
      const input = makeDecisionInput({
        blockingRequested: true,
        executionMode: 'heuristic',
      });
      const result = await gate.check(input, snapshot);
      expectRejectedWith(result, 'POLICY_BLOCKED');
    });
  });

  describe('CONFIDENCE_BELOW_THRESHOLD (e) — Epic 17.3 ConfidenceRefusalPolicy hard floor', () => {
    it('rejects when calibrated C is below the injected refusal threshold', async () => {
      const gateWithRefusal = new AdmissionGate(new ConfidenceRefusalPolicy(0.45));
      const input = makeDecisionInput({
        resolveResult: makeResolveResult({ C: 0.30 }),
      });
      const result = await gateWithRefusal.check(input, snapshot);
      expectRejectedWith(result, 'CONFIDENCE_BELOW_THRESHOLD');
    });

    it('refuses when C is non-finite (NaN treated as zero-confidence — hallucination guard)', async () => {
      const gateWithRefusal = new AdmissionGate(new ConfidenceRefusalPolicy(0.45));
      const resolveResult = makeResolveResult({ C: 0.85 });
      const drifted: EntityResolveResult = {
        ...resolveResult,
        decisionTrace: {
          ...resolveResult.decisionTrace,
          decisionConfidenceC: Number.NaN,
        } as never,
      };
      const input = makeDecisionInput({ resolveResult: drifted });
      const result = await gateWithRefusal.check(input, snapshot);
      expectRejectedWith(result, 'CONFIDENCE_BELOW_THRESHOLD');
    });

    it('admits when ConfidenceRefusalPolicy is absent (Epic 17.3 opt-in: undefined policy bypasses §e)', async () => {
      const gateNoRefusal = new AdmissionGate();  // no policy injected
      const input = makeDecisionInput({
        resolveResult: makeResolveResult({ C: 0.30 }),
      });
      const result = await gateNoRefusal.check(input, snapshot);
      expect(result.admitted).toBe(true);
    });

    it('bypasses §e when calibrationTrusted=false (raw-score refusal-floor would be noise on identity-calibration fallback)', async () => {
      // CRITICAL invariant: when no trained calibration_params exist for the
      // query class, the Calibrator returns identity (raw score → C). Applying
      // a probability threshold to a raw score is RFC-006 §6 violation, so
      // §e must skip enforcement and emit a silent-skip counter instead.
      const gateWithRefusal = new AdmissionGate(new ConfidenceRefusalPolicy(0.45));
      const resolveResult = makeResolveResult({ C: 0.20 });  // would normally refuse
      const untrusted: EntityResolveResult = {
        ...resolveResult,
        decisionTrace: {
          ...resolveResult.decisionTrace,
          calibrationTrusted: false,
        } as never,
      };
      const result = await gateWithRefusal.check(makeDecisionInput({ resolveResult: untrusted }), snapshot);
      expect(result.admitted).toBe(true);
    });

    it('enforces §e when calibrationTrusted=true even at C marginally below threshold', async () => {
      const gateWithRefusal = new AdmissionGate(new ConfidenceRefusalPolicy(0.45));
      const resolveResult = makeResolveResult({ C: 0.449 });
      const trusted: EntityResolveResult = {
        ...resolveResult,
        decisionTrace: {
          ...resolveResult.decisionTrace,
          calibrationTrusted: true,
        } as never,
      };
      const result = await gateWithRefusal.check(makeDecisionInput({ resolveResult: trusted }), snapshot);
      expectRejectedWith(result, 'CONFIDENCE_BELOW_THRESHOLD');
    });
  });

  describe('admitted — happy path', () => {
    it('admits a well-formed resolved decision (all invariants satisfied)', async () => {
      const result = await gate.check(makeDecisionInput(), snapshot);
      expect(result.admitted).toBe(true);
    });

    it('admits even with empty admission_context (no hard constraints, no anchors, no identity seal)', async () => {
      const input = makeDecisionInput({
        queryPlan: makeQueryPlan({ intent: 'discovery' }),
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
            rankedTopResultPresent: false,
            matchedConstraintAttributes: [],
            unmetConstraintAttributes: [],
            anchorSignalTypes: [],
          },
          missing: [],
        },
      });
      const result = await gate.check(input, snapshot);
      expect(result.admitted).toBe(true);
    });
  });

  describe('rejection trace ref invariants', () => {
    it('every rejection carries a non-empty traceRef for audit correlation', async () => {
      const result = await gate.check(
        makeDecisionInput(),
        makeSnapshot({ threshold_profile_id: 'stale' }),
      );
      expect(result.admitted).toBe(false);
      if (!result.admitted) {
        expect(typeof result.traceRef).toBe('string');
        expect(result.traceRef.length).toBeGreaterThan(0);
      }
    });

    it('throws when effectiveRoute is undefined (compiled-only execution invariant)', async () => {
      const input = makeDecisionInput({
        ...({ effectiveRoute: undefined } as never),
      });
      await expect(
        gate.check(input, makeSnapshot({ threshold_profile_id: 'stale' })),
      ).rejects.toThrow(/effectiveRoute is required/);
    });
  });
});

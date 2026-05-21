/**
 * Regression: full DecisionEngine pipeline must reject KIL queries that
 * resolve to a top entity violating a plan-level hard constraint.
 *
 * KIL scenario: caller asks `/v1/search/lookup` for "Château Margaux 2016",
 * but the index only has Château Margaux 2015. The resolver picks 2015 as
 * the top entity (best alias match). Without proper hard-constraint
 * enforcement the engine returns `decision_status: 'resolved'` with the
 * wrong-vintage wine — a silent wrong-answer. The AdmissionGate (RFC-016
 * §c) is the closure that prevents this.
 *
 * Coverage gap this guards:
 *  - AdmissionGate unit tests prove §c rejects the configured violation
 *    case in isolation.
 *  - DecisionEngine unit tests do not invoke the admission gate path with
 *    a real hard-constraint violation.
 *  - No `test/e2e/` covers the lookup contract end-to-end with HTTP +
 *    Vespa, so a regression here would otherwise only surface in production.
 *
 * This test composes DecisionEngine + AdmissionGate with a minimal threshold
 * store stub and asserts the final decision shape on the violation case.
 */
import { describe, expect, it } from 'vitest';
import { DecisionEngine } from '../../src/domain/decision/service/decision-engine.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../../src/domain/query/model/threshold-profile.js';
import type { ThresholdStore } from '../../src/domain/query/port/threshold-store.port.js';
import type { ThresholdProfileV1 } from '../../src/domain/query/model/threshold-profile.js';
import {
  hasAnchorEvidence,
  hasConstraintEvidence,
  hasIdentityEvidence,
  type DecisionInput,
  type EvidenceSummary,
} from '../../src/domain/decision/model/decision-input.js';
import type { DecisionSnapshot } from '../../src/domain/shared/types/index.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';
import type { EntityResolveResult } from '../../src/domain/resolver/model/resolve-result.js';

class StubThresholdStore implements ThresholdStore {
  async getProfile(_id: string): Promise<ThresholdProfileV1 | null> {
    return DEFAULT_THRESHOLD_PROFILE;
  }
  async getDefault(): Promise<ThresholdProfileV1> {
    return DEFAULT_THRESHOLD_PROFILE;
  }
  async save(_profile: ThresholdProfileV1): Promise<void> {}
}

function makeSnapshot(): DecisionSnapshot {
  return {
    model_versions: { embedding: 'bge-m3-v1' },
    index_versions: { wine_content: '2026-04-01' },
    policy_rule_version: '1.0.0',
    threshold_profile_id: 'default-v1',
    planner_version: '1.0.0',
    feature_flags: {},
  };
}

function makeVintageHardConstraintPlan(): QueryPlanV1 {
  return {
    rawQuery: 'château margaux 2016',
    normalizedQuery: 'chateau margaux 2016',
    intent: 'entity_exact',
    route: 'entity',
    retrievalMode: 'entity_lookup',
    queryClass: 'short_entity',
    anchors: [],
    constraints: {
      hard: [
        {
          attribute: 'vintage',
          operator: '=',
          value: 2016,
        } as never,
      ],
      soft: [],
      inferred: [],
    },
    expansions: { lexical: [], semantic: [] },
    policy: {
      requireExact: false,
      allowApproximate: false,
      requireClarification: false,
      clarificationBias: 0,
      fallbackMode: 'hybrid',
      policyReasonCodes: [],
    },
    uncertainty: {
      overall: 0.1,
      ambiguityDetected: false,
      ambiguitySeverity: 'low',
    } as never,
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default-v1',
  } as QueryPlanV1;
}

function makeResolveResultForChateauMargaux2015(): EntityResolveResult {
  // Resolver picks Château Margaux 2015 as the top entity — the closest
  // alias match for "château margaux 2016". The vintage attribute does
  // NOT satisfy the plan's hard constraint (vintage = 2016).
  return {
    status: 'resolved',
    candidates: [{
      entityId: 'entity-chateau-margaux-2015' as never,
      canonicalLabel: 'Château Margaux 2015',
      calibratedScore: 0.85,
      rank: 1,
      evidenceRefs: ['alias-chateau-margaux'],
    }],
    topEntity: {
      entityId: 'entity-chateau-margaux-2015' as never,
      canonicalLabel: 'Château Margaux 2015',
      calibratedScore: 0.85,
    },
    decisionTrace: {
      queryClass: 'short_entity',
      top1CalibratedScore: 0.85,
      top2CalibratedScore: 0.05,
      calibratedGap: 0.8,
      decisionConfidenceC: 0.85,
      calibrationTrusted: true,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0.45, gapThreshold: 0.02 },
      outcomeReasonCodes: [],
    } as never,
    conformalSetSize: 1,
  };
}

function makeEvidenceSummary(): EvidenceSummary {
  // Identity evidence present (alias match), but constraint evidence is
  // unmet — the top candidate matches no required attributes (vintage=2015
  // ≠ 2016) and the unmet list flags it.
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
    constraintEvidencePresent: false,
    constraintEvidence: {
      requiredAttributes: ['vintage'],
      matchedRequiredAttributes: [],
      unmetRequiredAttributes: ['vintage'],
      inferredAttributes: [],
    } as never,
    anchorEvidencePresent: false,
  };
}

function makeDecisionInput(): DecisionInput {
  const queryPlan = makeVintageHardConstraintPlan();
  const resolveResult = makeResolveResultForChateauMargaux2015();
  const evidenceSummary = makeEvidenceSummary();
  return {
    queryPlan,
    effectiveRoute: 'entity',
    effectiveRetrievalMode: 'entity_lookup',
    retrievalKind: 'entity_lookup',
    resolveResult,
    policy: queryPlan.policy,
    uncertainty: queryPlan.uncertainty,
    evidenceSummary,
    provenanceContract: {
      policy: {
        requireIdentitySeal: true,
        requireConstraintEvidence: true, // plan has hard constraints
        requireAnchorEvidence: false,
      },
      observed: {
        identityEvidenceSatisfied: hasIdentityEvidence(evidenceSummary),
        constraintEvidenceSatisfied: hasConstraintEvidence(evidenceSummary),
        anchorEvidenceSatisfied: hasAnchorEvidence(evidenceSummary),
        topEntityPresent: true,
        rankedTopResultPresent: true,
        matchedConstraintAttributes: [],
        unmetConstraintAttributes: ['vintage'],
        anchorSignalTypes: [],
      },
      missing: ['constraint_evidence'],
    },
    conformalSetSize: 1,
  };
}

describe('KIL — DecisionEngine never emits resolved on vintage-mismatch', () => {
  /**
   * Defence-in-depth: the engine has two layers that catch hard-constraint
   * violations:
   *   1. Evidence gate (RFC-007 §4.1) — downgrades resolved → ambiguous
   *      when policy requires constraint evidence and the observed trail
   *      is incomplete. Fires first.
   *   2. AdmissionGate (RFC-016 §c) — final closure that emits
   *      HARD_CONSTRAINT_VIOLATION on resolved decisions whose closure
   *      is still unsatisfied (rare path; covers cases the evidence gate
   *      missed due to provenance drift).
   *
   * This regression asserts the OUTER invariant: vintage-mismatch never
   * leaves the engine as decisionStatus='resolved'. Whichever layer fires
   * first, the silent wrong-answer ("we returned 2015 for your 2016
   * request") path stays closed.
   */
  it('emits decisionStatus != resolved on vintage-mismatch (the silent wrong-answer path stays closed)', async () => {
    const engine = new DecisionEngine(new StubThresholdStore());
    const result = await engine.decide(makeDecisionInput(), makeSnapshot());
    expect(result.decisionStatus).not.toBe('resolved');
  });

  it('records a constraint-related rule in decisionTrace.rulesApplied (operators can trace why the lookup failed)', async () => {
    const engine = new DecisionEngine(new StubThresholdStore());
    const result = await engine.decide(makeDecisionInput(), makeSnapshot());
    const trace = result.decisionTrace;
    expect(trace).toBeDefined();
    const rules = trace.rulesApplied;
    const traceText = JSON.stringify({
      rules,
      finalReason: trace.finalReason,
      failureReason: result.failureReason,
    });
    // At least one constraint-related code must appear so postmortem can
    // diagnose vintage-mismatch rejections without re-running the engine.
    expect(traceText).toMatch(/CONSTRAINT|EVIDENCE_GATE_NO_CONSTRAINT|HARD_CONSTRAINT/i);
  });

  it('next_action steers the response toward clarification or failure (never return_result for an unmet hard constraint)', async () => {
    const engine = new DecisionEngine(new StubThresholdStore());
    const result = await engine.decide(makeDecisionInput(), makeSnapshot());
    expect(result.nextAction).not.toBe('return_result');
  });
});

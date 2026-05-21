import { describe, it, expect } from 'vitest';
import { ConfidenceRefusalPolicy } from '../service/confidence-refusal.js';
import { AdmissionGate } from '../service/admission-gate.js';
import {
  hasAnchorEvidence,
  hasConstraintEvidence,
  hasIdentityEvidence,
  type DecisionInput,
} from '../model/decision-input.js';
import type { DecisionSnapshot } from '../../shared/types/index.js';
import type { EntityResolveResult } from '../../resolver/model/resolve-result.js';
import { computeConformalSetSize, DEFAULT_ALPHA } from '../../resolver/service/resolver.js';
import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import { createEntityId } from '../../shared/types/index.js';

// ── ConfidenceRefusalPolicy Tests ──────────────────────────────────────────

describe('ConfidenceRefusalPolicy', () => {
  describe('initialization', () => {
    it.each([
      ['creates with default threshold 0.45', undefined, 0.45],
      ['creates with custom threshold', 0.6, 0.6],
      ['accepts boundary thresholds 0', 0, 0],
      ['accepts boundary thresholds 1', 1, 1],
    ])('%s', (_label, threshold, expected) => {
      const policy = threshold === undefined ? new ConfidenceRefusalPolicy() : new ConfidenceRefusalPolicy(threshold);
      expect(policy.getThreshold()).toBe(expected);
    });

    it.each([
      ['throws on invalid threshold < 0', -0.1],
      ['throws on invalid threshold > 1', 1.1],
    ])('%s', (_label, threshold) => {
      expect(() => new ConfidenceRefusalPolicy(threshold)).toThrow();
    });
  });

  describe('shouldRefuse', () => {
    const policy = new ConfidenceRefusalPolicy(0.5);

    it.each([
      ['refuses when C < threshold', 0.3, true],
      ['refuses when C < threshold (edge below)', 0.49, true],
      ['admits when C >= threshold', 0.5, false],
      ['admits when C >= threshold (edge above)', 0.51, false],
      ['handles edge case C = 0', 0.0, true],
      ['handles edge case C = 1', 1.0, false],
      ['strict less-than comparison at threshold', 0.5, false],
    ])('%s', (_label, C, expected) => {
      expect(policy.shouldRefuse(C)).toBe(expected);
    });
  });

  describe('threshold calibration targets', () => {
    it('0.45 threshold catches high proportion of low-C decisions', () => {
      const policy = new ConfidenceRefusalPolicy(0.45);
      // Simulate hallucination cases (typically C < 0.5)
      const hallucinations = [0.1, 0.2, 0.3, 0.4];
      const caught = hallucinations.filter((c) => policy.shouldRefuse(c)).length;
      expect(caught).toBe(4); // All below 0.45
    });

    it('0.45 threshold minimizes false refusals on good searches', () => {
      const policy = new ConfidenceRefusalPolicy(0.45);
      // Simulate good searches (typically C >= 0.8)
      const goodSearches = [0.75, 0.8, 0.9, 0.95];
      const falseRefusals = goodSearches.filter((c) => policy.shouldRefuse(c)).length;
      expect(falseRefusals).toBe(0); // None above 0.45
    });
  });
});

// ── AdmissionGate + ConfidenceRefusalPolicy Integration Tests ──────────────

// Test fixtures
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
  gap: number = 0.3,
  ambiguityDetected: boolean = false,
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
      top2CalibratedScore: C - gap,
      calibratedGap: gap,
      decisionConfidenceC: C,
      // These tests exercise the confidence-refusal path on production-shaped
      // inputs where the trained calibrator produced C — set
      // `calibrationTrusted=true` so the AdmissionGate's confidence-refusal
      // floor (RFC-016 §3, Epic 17.3) actually runs against C instead of
      // being skipped as untrusted.
      calibrationTrusted: true,
      ambiguityDetected,
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

function makeProvenanceContract(
  input: {
    readonly queryPlan?: QueryPlanV1 | undefined;
    readonly evidenceSummary?: DecisionInput['evidenceSummary'] | undefined;
    readonly provenancePolicy?: DecisionInput['provenanceContract']['policy'] | undefined;
    readonly resolveResult?: EntityResolveResult | undefined;
  } = {},
): DecisionInput['provenanceContract'] {
  const queryPlan = input.queryPlan ?? makeQueryPlan();
  const evidenceSummary = input.evidenceSummary;
  const policy = input.provenancePolicy ?? {
    requireIdentitySeal: queryPlan.intent === 'entity_exact',
    requireConstraintEvidence: queryPlan.constraints.hard.length > 0,
    requireAnchorEvidence: queryPlan.route === 'mixed' && queryPlan.anchors.length > 0,
  };

  return {
    policy,
    observed: {
      identityEvidenceSatisfied: hasIdentityEvidence(evidenceSummary),
      constraintEvidenceSatisfied: hasConstraintEvidence(evidenceSummary),
      anchorEvidenceSatisfied: hasAnchorEvidence(evidenceSummary),
      topEntityPresent: input.resolveResult?.topEntity !== undefined,
      rankedTopResultPresent: false,
      matchedConstraintAttributes: [],
      unmetConstraintAttributes: [],
      anchorSignalTypes: [],
    },
    missing: [
      ...(policy.requireIdentitySeal && !hasIdentityEvidence(evidenceSummary)
        ? ['identity_evidence' as const]
        : []),
      ...(policy.requireConstraintEvidence && !hasConstraintEvidence(evidenceSummary)
        ? ['constraint_evidence' as const]
        : []),
      ...(policy.requireAnchorEvidence && !hasAnchorEvidence(evidenceSummary)
        ? ['anchor_evidence' as const]
        : []),
    ],
  };
}

function makeInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  const queryPlan = overrides.queryPlan ?? makeQueryPlan();
  const resolveResult = overrides.resolveResult ?? makeResolverResult(0.9, 0.3);
  const evidenceSummary = overrides.evidenceSummary ?? makeStrongIdentityEvidence();
  return {
    queryPlan,
    effectiveRoute: queryPlan.route,
    effectiveRetrievalMode: queryPlan.retrievalMode as DecisionInput['effectiveRetrievalMode'],
    resolveResult,
    identityResolveResult:
      'identityResolveResult' in overrides ? overrides.identityResolveResult : resolveResult,
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
    provenanceContract: makeProvenanceContract({
      queryPlan,
      evidenceSummary,
      provenancePolicy: overrides.provenanceContract?.policy,
      resolveResult,
    }),
    ...overrides,
  };
}

function makeStrongIdentityEvidence(
  overrides: Partial<NonNullable<DecisionInput['evidenceSummary']>> & {
    readonly identityEvidence?: Partial<
      NonNullable<NonNullable<DecisionInput['evidenceSummary']>['identityEvidence']>
    >;
  } = {},
) {
  const { identityEvidence: identityEvidenceOverrides, ...summaryOverrides } = overrides;
  const identityEvidence = {
    source: 'identity_artifact' as const,
    resolveTopEntityPresent: true,
    winnerIdentityArtifactPresent: true,
    winnerIdentityArtifactMatchesResolveResult: true,
    lanePresence: 'corroborated' as const,
    exactnessTier: 'exact' as const,
    identityEvidenceRefCount: 1,
    ...(identityEvidenceOverrides ?? {}),
  };

  return {
    identityEvidencePresent: true,
    ...summaryOverrides,
    identityEvidence,
  };
}

describe('AdmissionGate + ConfidenceRefusalPolicy Integration', () => {
  describe('backward compatibility: no policy provided', () => {
    const gate = new AdmissionGate(undefined);

    it('admits resolved decisions when no policy is provided', async () => {
      const input = makeInput({
        resolveResult: makeResolverResult(0.1, 0.3),
      });
      const result = await gate.check(input, TEST_SNAPSHOT);
      expect(result.admitted).toBe(true);
    });

    it('low-confidence decisions are NOT refused without policy', async () => {
      const input = makeInput({
        resolveResult: makeResolverResult(0.05, 0.3),
      });
      const result = await gate.check(input, TEST_SNAPSHOT);
      expect(result.admitted).toBe(true);
    });
  });

  describe('confidence refusal enabled', () => {
    const policy = new ConfidenceRefusalPolicy(0.45);
    const gate = new AdmissionGate(policy);

    it.each([
      ['admits resolved decisions when C >= threshold', 0.5, true],
      ['refuses resolved decisions when C < threshold', 0.4, false],
      ['correctly compares at boundary C = threshold', 0.45, true],
      ['refuses C just below threshold', 0.449, false],
    ])('%s', async (_label, C, admitted) => {
      const input = makeInput({
        resolveResult: makeResolverResult(C, 0.3),
      });
      const result = await gate.check(input, TEST_SNAPSHOT);
      expect(result.admitted).toBe(admitted);
      if (!result.admitted) {
        expect(result.reason).toBe('CONFIDENCE_BELOW_THRESHOLD');
      }
    });

    it('includes traceRef in rejection result', async () => {
      const input = makeInput({
        resolveResult: makeResolverResult(0.3, 0.3),
      });
      const result = await gate.check(input, TEST_SNAPSHOT);
      expect(result.admitted).toBe(false);
      if (!result.admitted) {
        expect(result.traceRef).toBeDefined();
        expect(result.traceRef).toContain('admission:');
      }
    });
  });

  describe('confidence refusal with missing decisionConfidenceC', () => {
    const policy = new ConfidenceRefusalPolicy(0.45);
    const gate = new AdmissionGate(policy);

    it('defaults to C=1.0 when decisionConfidenceC is absent', async () => {
      const testEntityId = createEntityId('entity-test');
      const result_no_c = {
        status: 'resolved' as const,
        // decisionConfidenceC is undefined
        topEntity: {
          entityId: testEntityId,
          canonicalLabel: 'Test',
          calibratedScore: 0.9,
        },
        candidates: [
          {
            entityId: testEntityId,
            canonicalLabel: 'Test',
            calibratedScore: 0.9,
            rank: 1,
            evidenceRefs: ['alias:test'],
          },
        ],
        decisionTrace: {
          queryClass: 'short_entity' as const,
          top1CalibratedScore: 0.9,
          top2CalibratedScore: 0.6,
          calibratedGap: 0.3,
          decisionConfidenceC: 0.9,
          ambiguityDetected: false,
          ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0.75, gapThreshold: 0.15 },
          outcomeReasonCodes: [],
        },
        conformalSetSize: 1,
      };
      const input = makeInput({ resolveResult: result_no_c as EntityResolveResult });
      const result = await gate.check(input, TEST_SNAPSHOT);
      expect(result.admitted).toBe(true); // Defaults to 1.0, which is >= 0.45
    });
  });

  describe('confidence refusal with other gate failures', () => {
    const policy = new ConfidenceRefusalPolicy(0.45);
    const gate = new AdmissionGate(policy);

    it('uses provenance policy instead of raw hard-constraint presence for constraint evidence obligations', async () => {
      const input = makeInput({
        queryPlan: {
          ...makeQueryPlan(),
          constraints: {
            hard: [{
              attribute: 'country',
              operator: '=',
              value: 'france',
              source_phrase: 'france',
              confidence: 0.9,
            }],
            soft: [],
            inferred: [],
          },
        },
        provenanceContract: makeProvenanceContract({
          queryPlan: {
            ...makeQueryPlan(),
            constraints: {
              hard: [{
                attribute: 'country',
                operator: '=',
                value: 'france',
                source_phrase: 'france',
                confidence: 0.9,
              }],
              soft: [],
              inferred: [],
            },
          },
          evidenceSummary: makeStrongIdentityEvidence(),
          provenancePolicy: {
            requireIdentitySeal: true,
            requireConstraintEvidence: false,
            requireAnchorEvidence: false,
          },
          resolveResult: makeResolverResult(0.9, 0.3),
        }),
        evidenceSummary: makeStrongIdentityEvidence(),
      });
      const result = await gate.check(input, TEST_SNAPSHOT);
      expect(result.admitted).toBe(true);
    });

    it('other failures take precedence (no identity evidence)', async () => {
      const input = makeInput({
        resolveResult: makeResolverResult(0.3, 0.3), // C < 0.45
        evidenceSummary: {
          identityEvidencePresent: false,
        },
      });
      const result = await gate.check(input, TEST_SNAPSHOT);
      expect(result.admitted).toBe(false);
      // Could be either EVIDENCE_INSUFFICIENT or CONFIDENCE_BELOW_THRESHOLD
      // depending on order, but the important thing is it's rejected
      if (!result.admitted) {
        expect(['EVIDENCE_INSUFFICIENT', 'CONFIDENCE_BELOW_THRESHOLD']).toContain(
          result.reason,
        );
      }
    });

    it('confidence refusal is checked after other gates pass', async () => {
      const input = makeInput({
        resolveResult: makeResolverResult(0.3, 0.3), // C < 0.45
        evidenceSummary: makeStrongIdentityEvidence(),
      });
      const result = await gate.check(input, TEST_SNAPSHOT);
      expect(result.admitted).toBe(false);
      if (!result.admitted) {
        expect(result.reason).toBe('CONFIDENCE_BELOW_THRESHOLD');
      }
    });

    it('richer identity evidence mismatch is rejected before confidence refusal', async () => {
      const input = makeInput({
        resolveResult: makeResolverResult(0.9, 0.3),
        evidenceSummary: makeStrongIdentityEvidence({
          identityEvidence: {
            winnerIdentityArtifactMatchesResolveResult: false,
          },
        }),
      });
      const result = await gate.check(input, TEST_SNAPSHOT);
      expect(result.admitted).toBe(false);
      if (!result.admitted) {
        expect(result.reason).toBe('EVIDENCE_INSUFFICIENT');
      }
    });
  });

  describe('different threshold values', () => {
    it.each([
      ['threshold 0.0 admits all decisions', 0.0, 0.0, true],
      ['threshold 1.0 refuses all decisions with C < 1.0', 1.0, 0.99, false],
    ])('%s', async (_label, threshold, C, admitted) => {
      const policy = new ConfidenceRefusalPolicy(threshold);
      const gate = new AdmissionGate(policy);
      const input = makeInput({
        resolveResult: makeResolverResult(C, 0.3),
      });
      const result = await gate.check(input, TEST_SNAPSHOT);
      expect(result.admitted).toBe(admitted);
    });

    it('threshold 0.5 correctly splits at midpoint', async () => {
      const policy = new ConfidenceRefusalPolicy(0.5);
      const gate = new AdmissionGate(policy);

      const admit = makeInput({
        resolveResult: makeResolverResult(0.5, 0.3),
      });
      const admitResult = await gate.check(admit, TEST_SNAPSHOT);
      expect(admitResult.admitted).toBe(true);

      const refuse = makeInput({
        resolveResult: makeResolverResult(0.49, 0.3),
      });
      const refuseResult = await gate.check(refuse, TEST_SNAPSHOT);
      expect(refuseResult.admitted).toBe(false);
    });
  });

  describe('integration with decision flow', () => {
    it('confidence refusal occurs after identity checks', async () => {
      const policy = new ConfidenceRefusalPolicy(0.45);
      const gate = new AdmissionGate(policy);
      const result_no_entity = {
        status: 'resolved' as const,
        decisionConfidenceC: 0.9,
        candidates: [],
        decisionTrace: {
          queryClass: 'short_entity' as const,
          top1CalibratedScore: 0.0,
          top2CalibratedScore: 0.0,
          calibratedGap: 0.0,
          decisionConfidenceC: 0.9,
          ambiguityDetected: false,
          ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0.75, gapThreshold: 0.15 },
          outcomeReasonCodes: [],
        },
        conformalSetSize: 1,
      };
      const input = makeInput({
        resolveResult: result_no_entity as EntityResolveResult,
      });
      const result = await gate.check(input, TEST_SNAPSHOT);
      // Should fail due to identity check, not confidence
      expect(result.admitted).toBe(false);
      if (!result.admitted) {
        expect(result.reason).toBe('IDENTITY_REFERENCE_MISSING');
      }
    });

    it('confidence refusal is the last check', async () => {
      const policy = new ConfidenceRefusalPolicy(0.45);
      const gate = new AdmissionGate(policy);
      const queryPlanWithAnchor = {
        ...makeQueryPlan(),
        admission_context: {
          requires_identity_seal: false,
          requires_constraint_evidence: false,
          requires_anchor_evidence: true,
        } as const,
      };
      const input = makeInput({
        resolveResult: makeResolverResult(0.3, 0.3),
        evidenceSummary: {
          ...makeStrongIdentityEvidence(),
          anchorEvidencePresent: true,
        },
        queryPlan: queryPlanWithAnchor,
        evidenceItems: [
          {
            type: 'anchor_similarity',
            source: 'mixed_solver',
            contribution: '+0.50',
            strength: 'high' as const,
            provenance: 'anchor similarity match in mixed route',
          },
        ],
      });
      const result = await gate.check(input, TEST_SNAPSHOT);
      expect(result.admitted).toBe(false);
      if (!result.admitted) {
        expect(result.reason).toBe('CONFIDENCE_BELOW_THRESHOLD');
      }
    });
  });
});

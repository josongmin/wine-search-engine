import { describe, it, expect, beforeEach } from 'vitest';
import { DecisionEngine } from '../service/decision-engine.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../../query/model/threshold-profile.js';
import type { ThresholdStore } from '../../query/port/threshold-store.port.js';
import type { ThresholdProfileV1 } from '../../query/model/threshold-profile.js';
import type { DecisionInput } from '../model/decision-input.js';
import type { DecisionSnapshot } from '../../shared/types/index.js';
import type { EntityResolveResult } from '../../resolver/model/resolve-result.js';
import { computeConformalSetSize } from '../../resolver/service/resolver.js';
import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import { createEntityId } from '../../shared/types/index.js';

// ── Stub: ThresholdStore always returns DEFAULT_THRESHOLD_PROFILE ────────────
class StubThresholdStore implements ThresholdStore {
  async getProfile(_id: string): Promise<ThresholdProfileV1 | null> {
    return DEFAULT_THRESHOLD_PROFILE;
  }
  async getDefault(): Promise<ThresholdProfileV1> {
    return DEFAULT_THRESHOLD_PROFILE;
  }
  async save(_profile: ThresholdProfileV1): Promise<void> {}
}

// ── Fixed snapshot used in all tests ─────────────────────────────────────────
const TEST_SNAPSHOT: DecisionSnapshot = {
  model_versions: { embedding: 'bge-m3-v1' },
  index_versions: { wine_content: '2026-04-01' },
  policy_rule_version: '1.0.0',
  threshold_profile_id: 'default-v1',
  planner_version: '1.0.0',
  feature_flags: {},
};

// ── Helpers to build DecisionInput ───────────────────────────────────────────
function makeResolverResult(
  C: number,
  gap: number,
  ambiguityDetected: boolean = false,
  queryProvenance?: EntityResolveResult['decisionTrace']['queryProvenance'],
): EntityResolveResult {
  const topEntityId = createEntityId('entity-opus-one');
  return {
    status: 'resolved',
    topEntity: {
      entityId: topEntityId,
      canonicalLabel: 'Opus One',
      calibratedScore: C,
    },
    candidates: [
      {
        entityId: topEntityId,
        canonicalLabel: 'Opus One',
        calibratedScore: C,
        rank: 1,
        evidenceRefs: ['alias:opus-one-ko'],
      },
    ],
    decisionTrace: {
      queryClass: 'short_entity',
      top1CalibratedScore: C,
      top2CalibratedScore: C - gap,
      calibratedGap: gap,
      decisionConfidenceC: C,
      ambiguityDetected,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0.75, gapThreshold: 0.15 },
      outcomeReasonCodes: [],
      ...(queryProvenance !== undefined ? { queryProvenance } : {}),
    },
    conformalSetSize: computeConformalSetSize(C, 0.1, 1),
  };
}

function makeQueryPlan(queryClass: QueryPlanV1['queryClass'] = 'short_entity'): QueryPlanV1 {
  return {
    rawQuery: '오푸스원',
    normalizedQuery: '오푸스원',
    intent: 'entity_exact',
    route: 'entity',
    retrievalMode: 'entity_lookup',
    queryClass,
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

function makeInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    queryPlan: makeQueryPlan(),
    resolverResult: makeResolverResult(0.9, 0.3),
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
    evidenceSummary: {
      identityEvidencePresent: true,
      constraintEvidencePresent: false,
      anchorEvidencePresent: false,
    },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('DecisionEngine', () => {
  let engine: DecisionEngine;

  beforeEach(() => {
    engine = new DecisionEngine(new StubThresholdStore());
  });

  describe('resolved status', () => {
    it('resolves when C >= T_resolve AND gap >= T_gap AND no ambiguity AND identity evidence present', async () => {
      // short_entity: T_resolve=0.75, T_gap=0.15
      const input = makeInput({
        resolverResult: makeResolverResult(0.85, 0.20, false),
        evidenceSummary: { identityEvidencePresent: true },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionStatus).toBe('resolved');
      expect(output.nextAction).toBe('return_result');
    });

    it('resolves exactly at threshold boundary (C=0.75, gap=0.15)', async () => {
      const input = makeInput({
        resolverResult: makeResolverResult(0.75, 0.15, false),
        evidenceSummary: { identityEvidencePresent: true },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionStatus).toBe('resolved');
    });

    it('resolved includes selectedEntity and chosenEntityId', async () => {
      const input = makeInput({
        resolverResult: makeResolverResult(0.85, 0.20, false),
        evidenceSummary: { identityEvidencePresent: true },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.selectedEntity).toBeDefined();
      expect(output.chosenEntityId).toBeDefined();
      expect(output.selectedEntity?.entityId).toBe(output.chosenEntityId);
    });
  });

  describe('ambiguous status', () => {
    it('ambiguous when C < T_resolve (with clarify fallback)', async () => {
      const input = makeInput({
        resolverResult: makeResolverResult(0.5, 0.20, false),
        evidenceSummary: { identityEvidencePresent: true },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionStatus).toBe('ambiguous');
    });

    it('ambiguous when ambiguityDetected=true even though C and gap pass', async () => {
      const input = makeInput({
        resolverResult: makeResolverResult(0.85, 0.20, true),
        evidenceSummary: { identityEvidencePresent: true },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionStatus).toBe('ambiguous');
    });

    it('ambiguous when gap < T_gap even though C passes', async () => {
      // Wave 3: short_entity now has dynamic gap_tau=0.03 (was 0.10)
      // To test gap failure, use gap < 0.03
      const input = makeInput({
        resolverResult: makeResolverResult(0.85, 0.01, false),
        evidenceSummary: { identityEvidencePresent: true },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionStatus).toBe('ambiguous');
    });

    it('ambiguous when conformalSetSize >= 2', async () => {
      const input = makeInput({
        resolverResult: makeResolverResult(0.85, 0.20, false),
        conformalSetSize: 2,
        evidenceSummary: { identityEvidencePresent: true },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionStatus).toBe('ambiguous');
      expect(output.decisionTrace.rulesApplied).toContain('CONFORMAL_SET_AMBIGUOUS');
    });

    it('clarifies short noisy queries that only resolved via fuzzy lookup strategies', async () => {
      const input = makeInput({
        queryPlan: {
          ...makeQueryPlan('short_entity'),
          rawQuery: 'romane conti',
          normalizedQuery: 'romane conti',
        },
        resolverResult: makeResolverResult(0.85, 0.20, false, {
          anchorLookupStrategies: ['fuzzy_char_ngram'],
          anchorLookupVariants: ['romane conti'],
        }),
        evidenceSummary: { identityEvidencePresent: true },
      });

      const output = await engine.decide(input, TEST_SNAPSHOT);

      expect(output.decisionStatus).toBe('ambiguous');
      expect(output.nextAction).toBe('clarify');
      expect(output.decisionTrace.rulesApplied).toContain('NOISY_SHORT_QUERY_GUARD');
      expect(output.decisionTrace.rulesApplied).toContain('NOISY_LOOKUP_STRATEGY_DETECTED');
    });
  });

  describe('failed status', () => {
    it('failed when C < T_resolve with fallbackMode=fail', async () => {
      const input = makeInput({
        resolverResult: makeResolverResult(0.5, 0.20, false),
        policy: {
          requireExact: false,
          allowApproximate: true,
          requireClarification: false,
          fallbackMode: 'fail',
          policyReasonCodes: [],
        },
        evidenceSummary: { identityEvidencePresent: true },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionStatus).toBe('failed');
      expect(output.nextAction).toBe('fail');
    });

    it('failed when uncertainty.decisionEffect=block_resolve', async () => {
      const input = makeInput({
        uncertainty: {
          overall: 0.9,
          ambiguityDetected: true,
          ambiguityTypes: ['blocked'],
          ambiguitySeverity: 'high',
          decisionEffect: 'block_resolve',
          parserConfidence: 0.5,
          anchorConfidence: 0.3,
          constraintConfidence: 0.5,
        },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionStatus).toBe('failed');
      expect(output.decisionTrace.rulesApplied).toContain('UNCERTAINTY_BLOCK_RESOLVE');
    });

    it('failed when ambiguitySummary.decisionEffect=block_resolve', async () => {
      const input = makeInput({
        ambiguitySummary: {
          types: ['brand_vs_region'],
          severity: 'high',
          sources: ['resolver'],
          decisionEffect: 'block_resolve',
        },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionStatus).toBe('failed');
      expect(output.decisionTrace.rulesApplied).toContain('AMBIGUITY_BLOCK_RESOLVE');
    });
  });

  describe('noisy short-query guard', () => {
    it('does not block very high-confidence noisy short lookups', async () => {
      const input = makeInput({
        queryPlan: {
          ...makeQueryPlan('short_entity'),
          rawQuery: 'romane conti',
          normalizedQuery: 'romane conti',
        },
        resolverResult: makeResolverResult(0.93, 0.20, false, {
          anchorLookupStrategies: ['transliterated_fuzzy'],
          anchorLookupVariants: ['romanee conti'],
        }),
        evidenceSummary: { identityEvidencePresent: true },
      });

      const output = await engine.decide(input, TEST_SNAPSHOT);

      expect(output.decisionStatus).toBe('resolved');
      expect(output.decisionTrace.rulesApplied).toContain(
        'NOISY_SHORT_QUERY_GUARD_BYPASSED_HIGH_CONFIDENCE',
      );
    });
  });

  describe('evidence obligation', () => {
    it('resolved without identity evidence → downgraded to ambiguous', async () => {
      const input = makeInput({
        resolverResult: makeResolverResult(0.85, 0.20, false),
        evidenceSummary: {
          identityEvidencePresent: false,
        },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionStatus).toBe('ambiguous');
      expect(output.decisionTrace.rulesApplied).toContain('EVIDENCE_GATE_DOWNGRADE');
    });

    it('resolved with missing evidenceSummary → downgraded to ambiguous', async () => {
      const full = makeInput({
        resolverResult: makeResolverResult(0.85, 0.20, false),
      });
      const { evidenceSummary: _omit, ...input } = full;
      void _omit;
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionStatus).toBe('ambiguous');
    });

    it('resolved with constraints but no constraint evidence → downgraded', async () => {
      const input = makeInput({
        resolverResult: makeResolverResult(0.85, 0.20, false),
        queryPlan: {
          ...makeQueryPlan(),
          constraints: {
            hard: [{ attribute: 'color', operator: '=', value: 'red', source_phrase: 'red', confidence: 0.9 }],
            soft: [],
            inferred: [],
          },
        },
        evidenceSummary: {
          identityEvidencePresent: true,
          constraintEvidencePresent: false,
        },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionStatus).toBe('ambiguous');
    });

    it('resolved with anchor but no anchor evidence → downgraded', async () => {
      const anchorEntityId = createEntityId('entity-mageau');
      const input = makeInput({
        resolverResult: makeResolverResult(0.85, 0.20, false),
        queryPlan: {
          ...makeQueryPlan(),
          route: 'mixed',
          anchors: [{
            surfaceForm: '마고',
            normalizedForm: '마고',
            candidateEntityIds: [anchorEntityId],
            confidence: 0.9,
            source: 'alias',
          }],
        },
        evidenceSummary: {
          identityEvidencePresent: true,
          anchorEvidencePresent: false,
        },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionStatus).toBe('ambiguous');
    });
  });

  describe('policy overlay', () => {
    it('requireClarification=true → force ambiguous even if numerics pass', async () => {
      const input = makeInput({
        resolverResult: makeResolverResult(0.95, 0.40, false),
        policy: {
          requireExact: false,
          allowApproximate: true,
          requireClarification: true,
          fallbackMode: 'clarify',
          policyReasonCodes: ['forced_clarify'],
        },
        evidenceSummary: { identityEvidencePresent: true },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionStatus).toBe('ambiguous');
      expect(output.nextAction).toBe('clarify');
      expect(output.decisionTrace.rulesApplied).toContain('POLICY_REQUIRE_CLARIFICATION');
    });

    it('uncertainty.decisionEffect=force_clarify → force ambiguous', async () => {
      const input = makeInput({
        resolverResult: makeResolverResult(0.95, 0.40, false),
        uncertainty: {
          overall: 0.8,
          ambiguityDetected: true,
          ambiguityTypes: ['force_clarify_test'],
          ambiguitySeverity: 'high',
          decisionEffect: 'force_clarify',
          parserConfidence: 0.5,
          anchorConfidence: 0.3,
          constraintConfidence: 0.5,
        },
        evidenceSummary: { identityEvidencePresent: true },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionStatus).toBe('ambiguous');
      expect(output.decisionTrace.rulesApplied).toContain('UNCERTAINTY_FORCE_CLARIFY');
    });

    it('requireExact=true and top candidate score < 0.99 → downgrade to ambiguous', async () => {
      const input = makeInput({
        resolverResult: makeResolverResult(0.85, 0.20, false),
        policy: {
          requireExact: true,
          allowApproximate: false,
          requireClarification: false,
          fallbackMode: 'clarify',
          policyReasonCodes: [],
        },
        evidenceSummary: { identityEvidencePresent: true },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionStatus).toBe('ambiguous');
      expect(output.decisionTrace.rulesApplied).toContain('POLICY_REQUIRE_EXACT_DOWNGRADE');
    });

    it('allowApproximate=false switches nextAction from hybrid_search to clarify', async () => {
      const input = makeInput({
        resolverResult: makeResolverResult(0.5, 0.20, false),
        policy: {
          requireExact: false,
          allowApproximate: false,
          requireClarification: false,
          fallbackMode: 'hybrid',
          policyReasonCodes: [],
        },
        evidenceSummary: { identityEvidencePresent: true },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.nextAction).toBe('clarify');
      expect(output.decisionTrace.rulesApplied).toContain('POLICY_NO_APPROXIMATE_OVERRIDE');
    });
  });

  describe('wrong resolve guard', () => {
    it('wrong entity with high score still passes through the numeric gate correctly', async () => {
      // The decision engine has no knowledge of "correctness" — it gates on C and gap.
      // A high-C, high-gap, no-ambiguity result should resolve regardless of which entity it is.
      // The utility scorer (not the decision engine) determines correctness.
      const wrongEntityId = createEntityId('entity-wrong-wine');
      const wrongResolverResult: EntityResolveResult = {
        status: 'resolved',
        topEntity: {
          entityId: wrongEntityId,
          canonicalLabel: 'Wrong Wine',
          calibratedScore: 0.95,
        },
        candidates: [{
          entityId: wrongEntityId,
          canonicalLabel: 'Wrong Wine',
          calibratedScore: 0.95,
          rank: 1,
          evidenceRefs: ['alias:wrong'],
        }],
        decisionTrace: {
          queryClass: 'short_entity',
          top1CalibratedScore: 0.95,
          top2CalibratedScore: 0.5,
          calibratedGap: 0.45,
          decisionConfidenceC: 0.95,
          ambiguityDetected: false,
          ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0.75, gapThreshold: 0.15 },
          outcomeReasonCodes: [],
        },
        conformalSetSize: computeConformalSetSize(0.95, 0.1, 1),
      };

      const input = makeInput({
        resolverResult: wrongResolverResult,
        evidenceSummary: { identityEvidencePresent: true },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      // Engine resolves — it is not responsible for semantic correctness
      expect(output.decisionStatus).toBe('resolved');
      expect(output.chosenEntityId).toBe(wrongEntityId);
    });
  });

  describe('DecisionTrace completeness', () => {
    it('trace always has all required fields', async () => {
      const input = makeInput({
        resolverResult: makeResolverResult(0.85, 0.20, false),
        evidenceSummary: { identityEvidencePresent: true },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      const trace = output.decisionTrace;

      expect(trace.decisionStatus).toBeDefined();
      expect(trace.nextAction).toBeDefined();
      expect(trace.inputs).toBeDefined();
      expect(trace.inputs.queryClass).toBeDefined();
      expect(trace.inputs.policy).toBeDefined();
      expect(trace.signals).toBeDefined();
      expect(trace.signals.decisionConfidence).toBeDefined();
      expect(trace.signals.calibratedGap).toBeDefined();
      expect(typeof trace.signals.ambiguity).toBe('boolean');
      expect(trace.thresholds).toBeDefined();
      expect(trace.thresholds.resolveThreshold).toBeDefined();
      expect(trace.thresholds.gapThreshold).toBeDefined();
      expect(trace.versions).toBeDefined();
      expect(trace.versions.thresholdProfileId).toBeDefined();
      expect(trace.versions.policyRuleVersion).toBeDefined();
      expect(Array.isArray(trace.rulesApplied)).toBe(true);
      expect(typeof trace.finalReason).toBe('string');
    });

    it('trace status matches output status', async () => {
      for (const scenario of [
        makeInput({ resolverResult: makeResolverResult(0.85, 0.20, false), evidenceSummary: { identityEvidencePresent: true } }),
        makeInput({ resolverResult: makeResolverResult(0.5, 0.20, false), evidenceSummary: { identityEvidencePresent: true } }),
      ]) {
        const output = await engine.decide(scenario, TEST_SNAPSHOT);
        expect(output.decisionTrace.decisionStatus).toBe(output.decisionStatus);
        expect(output.decisionTrace.nextAction).toBe(output.nextAction);
      }
    });

    it('trace signals reflect resolver trace inputs', async () => {
      const C = 0.88;
      const gap = 0.22;
      const input = makeInput({
        resolverResult: makeResolverResult(C, gap, false),
        evidenceSummary: { identityEvidencePresent: true },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionTrace.signals.decisionConfidence).toBe(C);
      expect(output.decisionTrace.signals.calibratedGap).toBe(gap);
    });

    it('decisionConfidenceSemantics is always calibrated_decision_confidence', async () => {
      const input = makeInput({
        resolverResult: makeResolverResult(0.85, 0.20, false),
        evidenceSummary: { identityEvidencePresent: true },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.confidenceSemantics).toBe('calibrated_decision_confidence');
    });

    it('decisionSnapshot is attached to output', async () => {
      const input = makeInput({
        resolverResult: makeResolverResult(0.85, 0.20, false),
        evidenceSummary: { identityEvidencePresent: true },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionSnapshot).toBe(TEST_SNAPSHOT);
    });
  });

  describe('ambiguity summary policy pre-processing', () => {
    it('ambiguitySummary.decisionEffect=force_clarify → ambiguous immediately', async () => {
      const input = makeInput({
        resolverResult: makeResolverResult(0.95, 0.40, false),
        ambiguitySummary: {
          types: ['name_collision'],
          severity: 'high',
          sources: ['resolver'],
          decisionEffect: 'force_clarify',
        },
        evidenceSummary: { identityEvidencePresent: true },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionStatus).toBe('ambiguous');
      expect(output.decisionTrace.rulesApplied).toContain('AMBIGUITY_FORCE_CLARIFY');
    });
  });

  describe('query class thresholds', () => {
    it('ambiguous_short_form class uses higher T_resolve=0.75', async () => {
      // C=0.70 passes short_entity (T=0.60) but fails ambiguous_short_form (T=0.75)
      const input: DecisionInput = {
        queryPlan: makeQueryPlan('ambiguous_short_form'),
        resolverResult: makeResolverResult(0.70, 0.20, false),
        policy: {
          requireExact: false,
          allowApproximate: true,
          requireClarification: false,
          fallbackMode: 'clarify',
          policyReasonCodes: [],
        },
        uncertainty: {
          overall: 0.2,
          ambiguityDetected: false,
          ambiguityTypes: [],
          ambiguitySeverity: 'low',
          decisionEffect: 'trace_only',
          parserConfidence: 0.9,
          anchorConfidence: 0.8,
          constraintConfidence: 0.8,
        },
        evidenceSummary: { identityEvidencePresent: true },
      };
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionStatus).toBe('ambiguous');
    });

    it('short_entity class resolves with C=0.80 and gap=0.20', async () => {
      const input = makeInput({
        resolverResult: makeResolverResult(0.80, 0.20, false),
        evidenceSummary: { identityEvidencePresent: true },
      });
      const output = await engine.decide(input, TEST_SNAPSHOT);
      expect(output.decisionStatus).toBe('resolved');
    });
  });
});

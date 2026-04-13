import { describe, it, expect } from 'vitest';
import { DecisionEngine } from '../../../src/domain/decision/service/decision-engine.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../../../src/domain/query/model/threshold-profile.js';
import type { ThresholdStore } from '../../../src/domain/query/port/threshold-store.port.js';
import type { ThresholdProfileV1 } from '../../../src/domain/query/model/threshold-profile.js';
import type { DecisionInput } from '../../../src/domain/decision/model/decision-input.js';
import type { DecisionSnapshot } from '../../../src/domain/shared/types/index.js';
import type { QueryPlanV1 } from '../../../src/domain/query/model/query-plan.js';
import type { EntityResolveResult } from '../../../src/domain/resolver/model/resolve-result.js';
import type { QueryPolicy } from '../../../src/domain/query/model/query-policy.js';
import type { QueryUncertainty } from '../../../src/domain/query/model/query-uncertainty.js';

// ── Stub: ThresholdStore returning DEFAULT_THRESHOLD_PROFILE ──────────────────
class StubThresholdStore implements ThresholdStore {
  async getProfile(_id: string): Promise<ThresholdProfileV1 | null> {
    return DEFAULT_THRESHOLD_PROFILE;
  }
  async getDefault(): Promise<ThresholdProfileV1> {
    return DEFAULT_THRESHOLD_PROFILE;
  }
  async save(_profile: ThresholdProfileV1): Promise<void> {}
}

// ── Snapshot factory ──────────────────────────────────────────────────────────
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

// ── Base resolver result factory ──────────────────────────────────────────────
function makeResolverResult(overrides?: {
  C?: number;
  gap?: number;
  ambiguityDetected?: boolean;
  topEntityLabel?: string;
}): EntityResolveResult {
  const C = overrides?.C ?? 0.85;
  const gap = overrides?.gap ?? 0.2;
  const ambiguityDetected = overrides?.ambiguityDetected ?? false;

  return {
    status: 'resolved',
    candidates: [
      {
        entityId: 'entity-opus-one' as any,
        canonicalLabel: overrides?.topEntityLabel ?? 'Opus One',
        calibratedScore: C,
        rank: 1,
        evidenceRefs: ['alias-match-1'],
      },
    ],
    topEntity: {
      entityId: 'entity-opus-one' as any,
      canonicalLabel: overrides?.topEntityLabel ?? 'Opus One',
      calibratedScore: C,
    },
    decisionTrace: {
      queryClass: 'short_entity',
      top1CalibratedScore: C,
      top2CalibratedScore: C - gap,
      calibratedGap: gap,
      decisionConfidenceC: C,
      ambiguityDetected,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0.45, gapThreshold: 0.02 },
      outcomeReasonCodes: [],
      queryProvenance: {
        normalizedQueryViews: {
          raw: 'Opus-One 18',
          strict: 'opus-one 18',
          accentless: 'opus-one 18',
          collapsedWhitespace: 'opus-one 18',
          punctuationStripped: 'opus one 18',
          compact: 'opusone18',
          vintageCanonicalized: 'opus one 2018',
          vintageStripped: 'opus one',
          lookupVariants: ['opus-one 18', 'opus one 18', 'opusone18'],
        },
        anchorLookupVariants: ['opusone18', 'opus one 2018'],
      },
    },
    conformalSetSize: 1,
  };
}

// ── Base policy factory ───────────────────────────────────────────────────────
function makePolicy(overrides?: Partial<QueryPolicy>): QueryPolicy {
  return {
    requireExact: false,
    allowApproximate: false,
    requireClarification: false, clarificationBias: 0,
    fallbackMode: 'hybrid',
    policyReasonCodes: ['default_policy'],
    ...overrides,
  };
}

// ── Base uncertainty factory ──────────────────────────────────────────────────
function makeUncertainty(overrides?: Partial<QueryUncertainty>): QueryUncertainty {
  return {
    overall: 0.1,
    ambiguityDetected: false,
    ambiguitySeverity: 'low',
    ...overrides,
  };
}

// ── Base query plan factory ───────────────────────────────────────────────────
function makeQueryPlan(overrides?: {
  queryClass?: QueryPlanV1['queryClass'];
  hardConstraints?: any[];
  softConstraints?: any[];
  anchors?: any[];
  policy?: QueryPolicy;
  uncertainty?: QueryUncertainty;
}): QueryPlanV1 {
  return {
    rawQuery: 'opus one',
    normalizedQuery: 'opus one',
    intent: 'entity_exact',
    route: 'entity',
    queryClass: overrides?.queryClass ?? 'short_entity',
    anchors: overrides?.anchors ?? [],
    constraints: {
      hard: overrides?.hardConstraints ?? [],
      soft: overrides?.softConstraints ?? [],
      inferred: [],
    },
    expansions: { lexical: [], semantic: [] },
    policy: overrides?.policy ?? makePolicy(),
    uncertainty: overrides?.uncertainty ?? makeUncertainty(),
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default-v1',
  };
}

// ── Base DecisionInput factory ────────────────────────────────────────────────
function makeDecisionInput(overrides?: Partial<DecisionInput>): DecisionInput {
  const resolverResult = overrides?.resolverResult ?? makeResolverResult();
  return {
    queryPlan: makeQueryPlan(),
    resolverResult,
    policy: makePolicy(),
    uncertainty: makeUncertainty(),
    evidenceSummary: {
      identityEvidencePresent: true,
      constraintEvidencePresent: true,
      anchorEvidencePresent: false,
    },
    ...(resolverResult.conformalSetSize !== undefined
      ? { conformalSetSize: resolverResult.conformalSetSize }
      : {}),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('DecisionEngine', () => {
  const store = new StubThresholdStore();
  const engine = new DecisionEngine(store);
  const snapshot = makeSnapshot();

  // short_entity thresholds: resolveTau=0.50, gapTau=0.02

  it('C >= T_resolve AND gap >= T_gap AND no ambiguity → resolved', async () => {
    const input = makeDecisionInput({
      resolverResult: makeResolverResult({ C: 0.80, gap: 0.20, ambiguityDetected: false }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('resolved');
  });

  it('C < T_fail (well below resolve threshold) → failed', async () => {
    // Gate 3 requires: C < resolveTau AND gap >= gapTau AND no ambiguity AND conformal<2
    // short_entity from DEFAULT_THRESHOLD_PROFILE: resolveTau=0.45, gapTau=0.02
    // C=0.40 < 0.45, gap=0.03 >= 0.02, no ambiguity, conformal=1 → Gate 3 with fallbackMode='fail'
    const input = makeDecisionInput({
      resolverResult: makeResolverResult({ C: 0.40, gap: 0.03, ambiguityDetected: false }),
      policy: makePolicy({ fallbackMode: 'fail' }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('failed');
  });

  it('T_fail <= C < T_resolve with conformal set size >= 2 → ambiguous', async () => {
    // C below resolveTau=0.45 but conformal set indicates ambiguity
    const input = makeDecisionInput({
      resolverResult: makeResolverResult({ C: 0.40, gap: 0.05, ambiguityDetected: true }),
      conformalSetSize: 2,
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('ambiguous');
  });

  it('C >= T_resolve but gap < T_gap → ambiguous (insufficient separation)', async () => {
    // Wave 3: short_entity: resolveTau=0.45, dynamic gapTau=0.03
    // To test gap failure, use gap < 0.03
    const input = makeDecisionInput({
      resolverResult: makeResolverResult({ C: 0.50, gap: 0.01, ambiguityDetected: false }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('ambiguous');
  });

  it('C >= T_resolve, gap >= T_gap, but NO identity evidence → downgrade to ambiguous', async () => {
    const input = makeDecisionInput({
      resolverResult: makeResolverResult({ C: 0.80, gap: 0.20, ambiguityDetected: false }),
      evidenceSummary: {
        identityEvidencePresent: false, // no identity evidence
      },
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('ambiguous');
  });

  it('policy requireClarification=true → ambiguous even if numerics pass', async () => {
    const input = makeDecisionInput({
      resolverResult: makeResolverResult({ C: 0.95, gap: 0.30, ambiguityDetected: false }),
      policy: makePolicy({ requireClarification: true, clarificationBias: 0 }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('ambiguous');
  });

  it('DecisionTrace is always returned with all required fields', async () => {
    const input = makeDecisionInput();
    const output = await engine.decide(input, snapshot);

    const trace = output.decisionTrace;
    expect(trace).toBeDefined();
    expect(trace.decisionStatus).toBeDefined();
    expect(trace.nextAction).toBeDefined();
    expect(trace.inputs).toBeDefined();
    expect(trace.signals).toBeDefined();
    expect(trace.thresholds).toBeDefined();
    expect(trace.versions).toBeDefined();
    expect(trace.rulesApplied).toBeInstanceOf(Array);
    expect(trace.finalReason).toBeTypeOf('string');
  });

  it('nextAction=return_result when resolved', async () => {
    const input = makeDecisionInput({
      resolverResult: makeResolverResult({ C: 0.85, gap: 0.20, ambiguityDetected: false }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('resolved');
    expect(output.nextAction).toBe('return_result');
  });

  it('nextAction=clarify when ambiguous with requireClarification=true', async () => {
    const input = makeDecisionInput({
      resolverResult: makeResolverResult({ C: 0.85, gap: 0.20, ambiguityDetected: false }),
      policy: makePolicy({ requireClarification: true, clarificationBias: 0 }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.nextAction).toBe('clarify');
  });

  it('nextAction=hybrid_search when C < resolveTau, gap >= gapTau, no ambiguity, fallbackMode=hybrid', async () => {
    // Gate 3 path: C < resolveTau AND gap >= gapTau AND no ambiguity AND conformal<2
    // short_entity: resolveTau=0.45, gapTau=0.02
    // C=0.40 < 0.45, gap=0.03 >= 0.02, no ambiguity → Gate 3 → hybrid_search
    const input = makeDecisionInput({
      resolverResult: makeResolverResult({ C: 0.40, gap: 0.03, ambiguityDetected: false }),
      policy: makePolicy({ fallbackMode: 'hybrid', allowApproximate: true }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.nextAction).toBe('hybrid_search');
  });

  it('nextAction=fail when failed (Gate 3 with fallbackMode=fail)', async () => {
    // Gate 3: C < resolveTau AND gap >= gapTau AND no ambiguity AND conformal<2 → fallbackMode='fail'
    // short_entity: resolveTau=0.45, gapTau=0.02
    const input = makeDecisionInput({
      resolverResult: makeResolverResult({ C: 0.40, gap: 0.03, ambiguityDetected: false }),
      policy: makePolicy({ fallbackMode: 'fail' }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('failed');
    expect(output.nextAction).toBe('fail');
  });

  it('DecisionTrace contains signals from resolver', async () => {
    const input = makeDecisionInput({
      resolverResult: makeResolverResult({ C: 0.85, gap: 0.20, ambiguityDetected: false }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionTrace.signals.decisionConfidence).toBe(0.85);
    expect(output.decisionTrace.signals.calibratedGap).toBeCloseTo(0.20);
    expect(output.decisionTrace.signals.ambiguity).toBe(false);
  });

  it('DecisionTrace contains threshold values used', async () => {
    const input = makeDecisionInput();
    const output = await engine.decide(input, snapshot);
    // short_entity from DEFAULT_THRESHOLD_PROFILE v2.1.0 with dynamic gap
    expect(output.decisionTrace.thresholds.resolveThreshold).toBe(0.45);
    // Wave 3: dynamic gap threshold for short_entity is 0.03 (was 0.10)
    expect(output.decisionTrace.thresholds.gapThreshold).toBe(0.03);
  });

  it('DecisionTrace preserves query provenance from the resolver trace', async () => {
    const input = makeDecisionInput();
    const output = await engine.decide(input, snapshot);

    expect(output.decisionTrace.queryProvenance).toBeDefined();
    expect(output.decisionTrace.queryProvenance?.anchorLookupVariants).toEqual(
      expect.arrayContaining(['opusone18', 'opus one 2018']),
    );
  });

  it('resolved output includes selectedEntity and chosenEntityId', async () => {
    const input = makeDecisionInput({
      resolverResult: makeResolverResult({ C: 0.85, gap: 0.20, ambiguityDetected: false }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('resolved');
    expect(output.selectedEntity).toBeDefined();
    expect(output.selectedEntity?.entityId).toBe('entity-opus-one');
    expect(output.chosenEntityId).toBe('entity-opus-one');
  });

  it('ambiguous output does NOT include selectedEntity', async () => {
    const input = makeDecisionInput({
      resolverResult: makeResolverResult({ C: 0.85, gap: 0.20, ambiguityDetected: false }),
      policy: makePolicy({ requireClarification: true, clarificationBias: 0 }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('ambiguous');
    expect(output.selectedEntity).toBeUndefined();
  });

  it('uncertainty decisionEffect=force_clarify applies bias but does not short-circuit', async () => {
    // SOTA++: force_clarify is a soft bias, not a hard gate. C=0.95 with
    // bias 0.10 → effective resolveTau = 0.55. 0.95 >= 0.55 → resolved.
    const input = makeDecisionInput({
      resolverResult: makeResolverResult({ C: 0.95, gap: 0.30 }),
      uncertainty: makeUncertainty({ decisionEffect: 'force_clarify' }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('resolved');
  });

  it('uncertainty decisionEffect=block_resolve short-circuits to failed', async () => {
    const input = makeDecisionInput({
      resolverResult: makeResolverResult({ C: 0.95, gap: 0.30 }),
      uncertainty: makeUncertainty({ decisionEffect: 'block_resolve' }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('failed');
    expect(output.nextAction).toBe('fail');
  });
});

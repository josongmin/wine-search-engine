import { beforeEach, describe, it, expect } from 'vitest';
import { DecisionEngine } from '../../../src/domain/decision/service/decision-engine.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../../../src/domain/query/model/threshold-profile.js';
import type { ThresholdStore } from '../../../src/domain/query/port/threshold-store.port.js';
import type { ThresholdProfileV1 } from '../../../src/domain/query/model/threshold-profile.js';
import {
  hasAnchorEvidence,
  hasConstraintEvidence,
  hasIdentityEvidence,
  type DecisionInput,
} from '../../../src/domain/decision/model/decision-input.js';
import type { DecisionSnapshot } from '../../../src/domain/shared/types/index.js';
import type { QueryPlanV1 } from '../../../src/domain/query/model/query-plan.js';
import type { EntityResolveResult } from '../../../src/domain/resolver/model/resolve-result.js';
import type { QueryPolicy } from '../../../src/domain/query/model/query-policy.js';
import type { QueryUncertainty } from '../../../src/domain/query/model/query-uncertainty.js';
import { globalSilentSkipCounter } from '../../../src/domain/observability/silent-skip-counters.js';

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
    model_versions: { embedding: 'text-embedding-3-small-v1' },
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
  conformalSetSize?: number;
  calibrationTrusted?: boolean;
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
      ...(overrides?.calibrationTrusted !== undefined
        ? { calibrationTrusted: overrides.calibrationTrusted }
        : {}),
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
          semanticVariants: ['Opus-One 18', 'opus-one 18', 'opus one 18', 'opus one 2018', 'opus one'],
          lookupVariants: ['opus-one 18', 'opus one 18', 'opusone18'],
        },
        anchorLookupVariants: ['opusone18', 'opus one 2018'],
      },
    },
    conformalSetSize: overrides?.conformalSetSize ?? 1,
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
  intent?: QueryPlanV1['intent'];
  route?: QueryPlanV1['route'];
  retrievalMode?: QueryPlanV1['retrievalMode'];
  hardConstraints?: any[];
  softConstraints?: any[];
  anchors?: any[];
  policy?: QueryPolicy;
  uncertainty?: QueryUncertainty;
}): QueryPlanV1 {
  return {
    rawQuery: 'opus one',
    normalizedQuery: 'opus one',
    intent: overrides?.intent ?? 'entity_exact',
    route: overrides?.route ?? 'entity',
    retrievalMode: overrides?.retrievalMode ?? 'entity_lookup',
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

// ── Base DecisionInput factory ────────────────────────────────────────────────
function makeDecisionInput(overrides?: Partial<DecisionInput>): DecisionInput {
  const queryPlan = overrides?.queryPlan ?? makeQueryPlan();
  const resolveResult = overrides?.resolveResult ?? makeResolverResult();
  const evidenceSummary = overrides?.evidenceSummary ?? {
    identityEvidencePresent: true,
    identityEvidence: {
      source: 'identity_artifact' as const,
      resolveTopEntityPresent: true,
      winnerIdentityArtifactPresent: true,
      winnerIdentityArtifactMatchesResolveResult: true,
      exactnessTier: 'exact' as const,
      identityEvidenceRefCount: 1,
    },
    constraintEvidencePresent: true,
    anchorEvidencePresent: false,
  };
  return {
    queryPlan,
    effectiveRoute: 'hybrid',
    effectiveRetrievalMode: 'hybrid',
    resolveResult,
    policy: makePolicy(),
    uncertainty: makeUncertainty(),
    evidenceSummary,
    provenanceContract: makeProvenanceContract({
      queryPlan,
      evidenceSummary,
      provenancePolicy: overrides?.provenanceContract?.policy,
      resolveResult,
    }),
    ...(resolveResult.conformalSetSize !== undefined
      ? { conformalSetSize: resolveResult.conformalSetSize }
      : {}),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('DecisionEngine', () => {
  const store = new StubThresholdStore();
  const engine = new DecisionEngine(store);
  const snapshot = makeSnapshot();

  beforeEach(() => {
    globalSilentSkipCounter.reset();
  });

  // short_entity thresholds: resolveTau=0.50, gapTau=0.02

  it('C >= T_resolve AND gap >= T_gap AND no ambiguity → resolved', async () => {
    const input = makeDecisionInput({
      resolveResult: makeResolverResult({ C: 0.80, gap: 0.20, ambiguityDetected: false }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('resolved');
  });

  it('C < T_fail (well below resolve threshold) → failed', async () => {
    // Gate 3 requires: C < resolveTau AND gap >= gapTau AND no ambiguity AND conformal<2
    // short_entity from DEFAULT_THRESHOLD_PROFILE: resolveTau=0.45, gapTau=0.02
    // C=0.40 < 0.45, gap=0.03 >= 0.02, no ambiguity, conformal=1 → Gate 3 with fallbackMode='fail'
    const input = makeDecisionInput({
      resolveResult: makeResolverResult({ C: 0.40, gap: 0.03, ambiguityDetected: false }),
      policy: makePolicy({ fallbackMode: 'fail' }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('failed');
  });

  it('T_fail <= C < T_resolve with conformal set size >= 2 → ambiguous', async () => {
    // C below resolveTau=0.45 but conformal set indicates ambiguity
    const input = makeDecisionInput({
      resolveResult: makeResolverResult({ C: 0.40, gap: 0.05, ambiguityDetected: true }),
      conformalSetSize: 2,
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('ambiguous');
  });

  it('C >= T_resolve but gap < T_gap → ambiguous (insufficient separation)', async () => {
    // Wave 3: short_entity: resolveTau=0.45, dynamic gapTau=0.03
    // To test gap failure, use gap < 0.03
    const input = makeDecisionInput({
      resolveResult: makeResolverResult({ C: 0.50, gap: 0.01, ambiguityDetected: false }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('ambiguous');
  });

  it('semantic_preference recommendation uses confidence-only numeric gate and resolves despite wide conformal sets', async () => {
    const input = makeDecisionInput({
      queryPlan: makeQueryPlan({
        queryClass: 'semantic_preference',
        intent: 'pairing_search',
        route: 'hybrid',
        retrievalMode: 'recommendation',
        policy: makePolicy({ allowApproximate: true }),
      }),
      effectiveRoute: 'hybrid',
      effectiveRetrievalMode: 'recommendation',
      resolveResult: makeResolverResult({
        C: 0.52,
        gap: 0.0001,
        ambiguityDetected: true,
        conformalSetSize: 10,
      }),
      policy: makePolicy({ allowApproximate: true }),
      evidenceSummary: {
        identityEvidencePresent: true,
        identityEvidence: {
          source: 'identity_artifact',
          resolveTopEntityPresent: true,
          winnerIdentityArtifactPresent: true,
          winnerIdentityArtifactMatchesResolveResult: true,
          exactnessTier: 'alias_exact',
          identityEvidenceRefCount: 1,
        },
      },
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('resolved');
    expect(output.decisionTrace.rulesApplied).toContain('NUMERIC_GATE_PREFERENCE_MODE');
    expect(output.decisionTrace.thresholds.numericGateMode).toBe('preference');
  });

  it('semantic_preference preserves numericGateMode through clarificationBias spread (no strict gate)', async () => {
    // Reproduction: when clarificationBias > 0, effectiveThresholds was rebuilt
    // with a partial object literal that dropped numericGateMode (and any other
    // ThresholdEntry field). That coerced numericGateMode to 'strict' via the
    // `?? 'strict'` default in applyNumericGate, sending a recommendation-style
    // query through the strict Gate 2 → clarify instead of preference-mode resolve.
    // effectiveRetrievalMode is 'hybrid' (NON-exploratory) on purpose: that
    // isolates numericGateMode as the ONLY signal keeping the gate in
    // preference-mode. If the spread drops it, exploratoryListMode=false too,
    // so the query falls through to strict Gate 2 → ambiguous/clarify.
    const input = makeDecisionInput({
      queryPlan: makeQueryPlan({
        queryClass: 'semantic_preference',
        intent: 'pairing_search',
        route: 'hybrid',
        retrievalMode: 'hybrid',
        // clarificationBias > 0 forces the (previously buggy) spread branch.
        policy: makePolicy({ allowApproximate: true, clarificationBias: 0.10 }),
      }),
      effectiveRoute: 'hybrid',
      effectiveRetrievalMode: 'hybrid',
      resolveResult: makeResolverResult({
        // C must clear resolveTau (0.35) + clarificationBias (0.10) = 0.45.
        C: 0.52,
        gap: 0.0001,
        ambiguityDetected: true,
        conformalSetSize: 10,
      }),
      policy: makePolicy({ allowApproximate: true, clarificationBias: 0.10 }),
      evidenceSummary: {
        identityEvidencePresent: true,
        identityEvidence: {
          source: 'identity_artifact',
          resolveTopEntityPresent: true,
          winnerIdentityArtifactPresent: true,
          winnerIdentityArtifactMatchesResolveResult: true,
          exactnessTier: 'alias_exact',
          identityEvidenceRefCount: 1,
        },
      },
    });
    const output = await engine.decide(input, snapshot);
    // numericGateMode must survive the clarificationBias spread so the gate
    // routes through preference-mode (confidence-only), not strict Gate 2.
    expect(output.decisionTrace.rulesApplied).toContain('NUMERIC_GATE_PREFERENCE_MODE');
    expect(output.decisionStatus).toBe('resolved');
  });

  it('clarificationBias spread preserves numericGateMode AND raises resolveTau (regression)', async () => {
    // Adjacent case: same bias path, but C sits between the base resolveTau
    // (0.35) and the biased resolveTau (0.45). The bias must still apply (low
    // confidence → fallback), proving resolveTau is raised while numericGateMode
    // is preserved (preference-mode fallback rule, not strict Gate 3).
    const input = makeDecisionInput({
      queryPlan: makeQueryPlan({
        queryClass: 'semantic_preference',
        intent: 'pairing_search',
        route: 'hybrid',
        retrievalMode: 'hybrid',
        policy: makePolicy({ allowApproximate: true, clarificationBias: 0.10 }),
      }),
      effectiveRoute: 'hybrid',
      effectiveRetrievalMode: 'hybrid',
      resolveResult: makeResolverResult({
        // 0.35 (base) < C=0.40 < 0.45 (base + bias) → below biased resolveTau.
        // Tiny gap + conformal=2 would trip strict Gate 2 (ambiguous) if
        // numericGateMode were lost; preference-mode treats gap as advisory and
        // falls through to LOW_CONFIDENCE because C is below the BIASED tau.
        C: 0.40,
        gap: 0.0001,
        ambiguityDetected: false,
        conformalSetSize: 2,
      }),
      // No categoriesCovered → preference-mode low-confidence fallback path.
      policy: makePolicy({ allowApproximate: true, clarificationBias: 0.10, fallbackMode: 'clarify' }),
      evidenceSummary: {
        identityEvidencePresent: true,
        identityEvidence: {
          source: 'identity_artifact',
          resolveTopEntityPresent: true,
          winnerIdentityArtifactPresent: true,
          winnerIdentityArtifactMatchesResolveResult: true,
          exactnessTier: 'alias_exact',
          identityEvidenceRefCount: 1,
        },
      },
    });
    const output = await engine.decide(input, snapshot);
    // Bias raised the bar so C=0.40 is "low confidence", but the preference-mode
    // branch (not strict Gate 3) handled it — confirming both fields survived.
    expect(output.decisionTrace.rulesApplied).toContain('CLARIFICATION_BIAS_0.10');
    expect(output.decisionTrace.rulesApplied).toContain('NUMERIC_GATE_LOW_CONFIDENCE');
    expect(output.decisionTrace.rulesApplied).not.toContain('NUMERIC_GATE_AMBIGUOUS');
  });

  it('C >= T_resolve, gap >= T_gap, but NO identity evidence → downgrade to ambiguous', async () => {
    const input = makeDecisionInput({
      resolveResult: makeResolverResult({ C: 0.80, gap: 0.20, ambiguityDetected: false }),
      evidenceSummary: {
        identityEvidencePresent: false, // no identity evidence
      },
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('ambiguous');
  });

  it('requireExact=true downgrades when winner identity evidence is approximate', async () => {
    const input = makeDecisionInput({
      // calibrationTrusted=true so the calibration-trust gate (which also
      // downgrades approximate-identity resolved verdicts when the score is an
      // untrusted raw ranker value) does NOT preempt; this isolates the
      // requireExact policy override as the rule under test.
      resolveResult: makeResolverResult({ C: 0.92, gap: 0.20, ambiguityDetected: false, calibrationTrusted: true }),
      policy: makePolicy({ requireExact: true, allowApproximate: false }),
      evidenceSummary: {
        identityEvidencePresent: true,
        identityEvidence: {
          source: 'identity_artifact',
          resolveTopEntityPresent: true,
          winnerIdentityArtifactPresent: true,
          winnerIdentityArtifactMatchesResolveResult: true,
          exactnessTier: 'alias_fuzzy',
          identityEvidenceRefCount: 1,
        },
        constraintEvidencePresent: true,
        anchorEvidencePresent: false,
      },
    });

    const output = await engine.decide(input, snapshot);

    expect(output.decisionStatus).toBe('ambiguous');
    expect(output.nextAction).toBe('clarify');
    expect(output.decisionTrace.rulesApplied).toContain('POLICY_REQUIRE_EXACT_DOWNGRADE');
  });

  it('policy requireClarification=true → ambiguous even if numerics pass', async () => {
    const input = makeDecisionInput({
      resolveResult: makeResolverResult({ C: 0.95, gap: 0.30, ambiguityDetected: false }),
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

  it('counts absent decision evidenceItems before returning the legacy empty evidence surface', async () => {
    const input = makeDecisionInput({ evidenceItems: undefined });

    const output = await engine.decide(input, snapshot);

    expect(output.evidenceItems).toEqual([]);
    expect(globalSilentSkipCounter.snapshot().decision_evidence_items_absent).toBe(1);
  });

  it('nextAction=return_result when resolved', async () => {
    const input = makeDecisionInput({
      resolveResult: makeResolverResult({ C: 0.85, gap: 0.20, ambiguityDetected: false }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('resolved');
    expect(output.nextAction).toBe('return_result');
  });

  it('nextAction=clarify when ambiguous with requireClarification=true', async () => {
    const input = makeDecisionInput({
      resolveResult: makeResolverResult({ C: 0.85, gap: 0.20, ambiguityDetected: false }),
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
      resolveResult: makeResolverResult({ C: 0.40, gap: 0.03, ambiguityDetected: false }),
      policy: makePolicy({ fallbackMode: 'hybrid', allowApproximate: true }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.nextAction).toBe('hybrid_search');
  });

  it('nextAction=fail when failed (Gate 3 with fallbackMode=fail)', async () => {
    // Gate 3: C < resolveTau AND gap >= gapTau AND no ambiguity AND conformal<2 → fallbackMode='fail'
    // short_entity: resolveTau=0.45, gapTau=0.02
    const input = makeDecisionInput({
      resolveResult: makeResolverResult({ C: 0.40, gap: 0.03, ambiguityDetected: false }),
      policy: makePolicy({ fallbackMode: 'fail' }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('failed');
    expect(output.nextAction).toBe('fail');
  });

  it('DecisionTrace contains signals from resolver', async () => {
    const input = makeDecisionInput({
      resolveResult: makeResolverResult({ C: 0.85, gap: 0.20, ambiguityDetected: false }),
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
      resolveResult: makeResolverResult({ C: 0.85, gap: 0.20, ambiguityDetected: false }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('resolved');
    expect(output.selectedEntity).toBeDefined();
    expect(output.selectedEntity?.entityId).toBe('entity-opus-one');
    expect(output.chosenEntityId).toBe('entity-opus-one');
  });

  it('ambiguous output does NOT include selectedEntity', async () => {
    const input = makeDecisionInput({
      resolveResult: makeResolverResult({ C: 0.85, gap: 0.20, ambiguityDetected: false }),
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
      resolveResult: makeResolverResult({ C: 0.95, gap: 0.30 }),
      uncertainty: makeUncertainty({ decisionEffect: 'force_clarify' }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('resolved');
  });

  it('uncertainty decisionEffect=block_resolve short-circuits to failed', async () => {
    const input = makeDecisionInput({
      resolveResult: makeResolverResult({ C: 0.95, gap: 0.30 }),
      uncertainty: makeUncertainty({ decisionEffect: 'block_resolve' }),
    });
    const output = await engine.decide(input, snapshot);
    expect(output.decisionStatus).toBe('failed');
    expect(output.nextAction).toBe('fail');
  });
});

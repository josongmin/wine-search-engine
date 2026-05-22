/**
 * Bench self-validation — synthetic `BenchmarkReportSlice` shapes feed into
 * the deterministic insight generator, and we assert that every rule fires
 * exactly when its threshold is crossed.
 *
 * This is the analogue for the insight layer of the L3 metric regression
 * (which catches scorer regressions). The motivation: a silent bug in an
 * insight rule (wrong threshold direction, swapped sign, dropped null
 * guard) can suppress a "🔴 critical regression" line — exactly the
 * scenario reviewers cannot easily catch by eyeballing CI output.
 *
 * Also exercises the annotation schema + env-manifest pipelines so any
 * future schema drift fails this regression instead of silently corrupting
 * archived runs.
 */

import { describe, expect, it } from 'vitest';

import {
  generateDeterministicInsights,
  type BenchmarkReportSlice,
} from '../benchmark/agent/benchmark-insight-generator.js';
import {
  parseScenarioAnnotation,
  scenarioAnnotationSchema,
} from '../benchmark/agent/annotation-schema.js';
import {
  applyAnnotationDiagnostics,
  mergeAnnotationIntoScenario,
} from '../benchmark/agent/annotation-apply.js';
import { buildEnvManifest, manifestHash, envManifestSchema } from '../benchmark/agent/env-manifest.js';
import type { AgentBenchmarkScenario } from '../benchmark/agent/scenario.js';
import type { ScenarioExecution, ScenarioResult } from '../benchmark/agent/scorer.js';

// ─── helpers ──────────────────────────────────────────────────────────────

function makeSlice(overrides: Partial<BenchmarkReportSlice> = {}): BenchmarkReportSlice {
  return {
    overallScore: 0.85,
    overallCi95Lower: 0.78,
    overallCi95Upper: 0.90,
    executionEfficiency: 0.92,
    answerQuality: 0.88,
    faithfulness: 0.86,
    contextRelevance: 0.82,
    contextRecall: 0.77,
    judge: 0.74,
    latencyP50Ms: 4_000,
    latencyP95Ms: 9_000,
    tier6SoleExtractionRate: 0.10,
    meanHardConstraints: 3.0,
    scrOverall: 0.80,
    scrHard: 0.85,
    scrSoft: 0.75,
    scrInferred: 0.60,
    entityLinkingAccuracy: 0.94,
    slotF1Strict: 0.88,
    constraintEvaluatedCount: 20,
    scenarioCount: 50,
    criticalFailureCount: 0,
    worstScenarios: [],
    ...overrides,
  };
}

function ruleIds(lines: readonly string[]): readonly string[] {
  // Each line looks like:  "  🟢 [rule_id] message…"
  return lines
    .map((l) => {
      const m = /\[([\w_]+)\]/u.exec(l);
      return m === null ? null : m[1] ?? null;
    })
    .filter((id): id is string => id !== null);
}

// ─── insight rule fixtures ────────────────────────────────────────────────

describe('benchmark insight rules — happy baseline', () => {
  it('fires green rules only when thresholds are met', () => {
    const ids = ruleIds(generateDeterministicInsights(makeSlice()));
    // Happy baseline → green overall + good faithfulness + ELA achieved + good hard constraints.
    expect(ids).toContain('overall_good');
    expect(ids).toContain('faithful_good');
    expect(ids).toContain('ela_achieved');
    expect(ids).toContain('hard_constraints_good');
    // Sparse-annotation rule fires above 50 scenarios with only 20 annotated;
    // that's not <10 so it should NOT fire.
    expect(ids).not.toContain('scr_annotation_sparse');
    // Critical-failure rule must stay off when count=0.
    expect(ids).not.toContain('critical_failures');
  });

});

describe('benchmark insight rules — critical regressions', () => {
  it('overall_critical fires below warn threshold', () => {
    const ids = ruleIds(generateDeterministicInsights(makeSlice({ overallScore: 0.55 })));
    expect(ids).toContain('overall_critical');
    expect(ids).not.toContain('overall_good');
  });

  it('faithful_low fires when faithfulness < warn', () => {
    const ids = ruleIds(generateDeterministicInsights(makeSlice({ faithfulness: 0.60 })));
    expect(ids).toContain('faithful_low');
    expect(ids).not.toContain('faithful_good');
  });

  it('critical_failures fires whenever count > 0', () => {
    const ids = ruleIds(generateDeterministicInsights(makeSlice({ criticalFailureCount: 1 })));
    expect(ids).toContain('critical_failures');
  });

  it('scr_inferred_low fires below 0.20 floor', () => {
    const ids = ruleIds(generateDeterministicInsights(makeSlice({ scrInferred: 0.05 })));
    expect(ids).toContain('scr_inferred_low');
  });

  it('scr_annotation_sparse fires when constraintEvaluatedCount < 10', () => {
    const ids = ruleIds(generateDeterministicInsights(makeSlice({ constraintEvaluatedCount: 4 })));
    expect(ids).toContain('scr_annotation_sparse');
  });

  it('latency_p95_fail fires above 20s SLA', () => {
    const ids = ruleIds(generateDeterministicInsights(makeSlice({ latencyP95Ms: 25_000 })));
    expect(ids).toContain('latency_p95_fail');
  });

  it('hard_constraints_low fires below 1.5 mean', () => {
    const ids = ruleIds(generateDeterministicInsights(makeSlice({ meanHardConstraints: 1.0 })));
    expect(ids).toContain('hard_constraints_low');
    expect(ids).not.toContain('hard_constraints_good');
  });

  it('ela_near_target fires in the warn band (0.85 ≤ ela < 0.92)', () => {
    const ids = ruleIds(generateDeterministicInsights(makeSlice({ entityLinkingAccuracy: 0.88 })));
    expect(ids).toContain('ela_near_target');
    expect(ids).not.toContain('ela_achieved');
  });

  it('judge_variance fires when >=2 worst-5 scenarios have judge=0', () => {
    const ids = ruleIds(generateDeterministicInsights(makeSlice({
      worstScenarios: [
        { id: 1, tier: 'single_shot', score: 0.10, judge: 0 },
        { id: 2, tier: 'single_shot', score: 0.10, judge: 0 },
        { id: 3, tier: 'single_shot', score: 0.10, judge: 0.5 },
        { id: 4, tier: 'single_shot', score: 0.10, judge: 0.5 },
        { id: 5, tier: 'single_shot', score: 0.10, judge: 0.5 },
      ],
    })));
    expect(ids).toContain('judge_variance');
  });
});

// ─── annotation schema round-trip ─────────────────────────────────────────

describe('annotation schema — round-trip', () => {
  it('parses a fully populated annotation', () => {
    const fixture = {
      scenarioId: 999,
      annotatedBy: 'self-test',
      annotatedAt: '2026-05-22T00:00:00Z',
      notes: 'round trip',
      expectedConstraints: {
        hard: [{ attribute: 'wine_type', operator: '=', value: 'red' }],
        soft: [{ attribute: 'max_price_krw', operator: '<=', value: 100000 }],
      },
      expectedEntities: [
        { surface: '레드', canonical: 'red', type: 'wine_type' },
      ],
      expectedRetrievalIds: ['opus one'],
      expectedClaims: { mustMention: ['steak'], mustNotMention: ['sparkling'] },
      expectedSteps: { min: 1, max: 4 },
      expectedTerminationReason: 'answer',
      expectedRubric: ['Wine is red', 'Pairing addressed'],
    };
    const parsed = parseScenarioAnnotation(fixture);
    expect(parsed.scenarioId).toBe(999);
    expect(parsed.expectedConstraints?.hard?.[0]?.attribute).toBe('wine_type');
    // Zod re-emits the schema; ensure parse → schema.parse is idempotent.
    expect(scenarioAnnotationSchema.parse(parsed)).toEqual(parsed);
  });

  it('rejects malformed annotation (extra key)', () => {
    expect(() => parseScenarioAnnotation({
      scenarioId: 1,
      bogusField: 'should fail .strict()',
    })).toThrow();
  });

  it('rejects expectedSteps with min > max', () => {
    expect(() => parseScenarioAnnotation({
      scenarioId: 1,
      expectedSteps: { min: 5, max: 1 },
    })).toThrow();
  });
});

// ─── annotation apply ────────────────────────────────────────────────────

describe('annotation apply — merge + diagnostics', () => {
  const baseScenario: AgentBenchmarkScenario = {
    id: 99,
    tier: 'single_shot',
    query: 'red wine',
    description: 'self-test scenario',
    expectation: { maxSteps: 3 },
  };

  it('merge layers annotation expectedClaims onto inline answerContains', () => {
    const annotation = parseScenarioAnnotation({
      scenarioId: 99,
      expectedClaims: { mustMention: ['merlot'], mustNotMention: ['sparkling'] },
    });
    const merged = mergeAnnotationIntoScenario(
      { ...baseScenario, expectation: { ...baseScenario.expectation, answerContains: ['red'] } },
      annotation,
    );
    expect(merged.applied.applied).toBe(true);
    expect(merged.applied.drives.answerClaims).toBe(true);
    expect(merged.scenario.expectation.answerContains).toContain('red');
    expect(merged.scenario.expectation.answerContains).toContain('merlot');
    expect(merged.scenario.expectation.answerExcludes).toContain('sparkling');
  });

  it('apply diagnostics flags steps_out_of_range', () => {
    const annotation = parseScenarioAnnotation({
      scenarioId: 99,
      expectedSteps: { min: 1, max: 2 },
    });
    const exec: ScenarioExecution = {
      answer: 'fine',
      stepCount: 5,
      toolCallCount: 0,
      toolsUsed: [],
      observations: [],
      terminationReason: 'answer',
      totalDurationMs: 1000,
      totalTokens: { input: 0, output: 0 },
    };
    const scored: ScenarioResult = {
      id: 99,
      tier: 'single_shot',
      query: 'red wine',
      skipped: false,
      answer: 'fine',
      stepCount: 5,
      terminationReason: 'answer',
      scores: makeScores(),
      judgeRequiredButSkipped: false,
    };
    const updated = applyAnnotationDiagnostics(scored, exec, annotation);
    const codes = (updated.diagnostics ?? []).map((d) => d.code);
    expect(codes).toContain('annotation_steps_out_of_range');
  });

  it('apply diagnostics flags must_not_mention violations as critical', () => {
    const annotation = parseScenarioAnnotation({
      scenarioId: 99,
      expectedClaims: { mustNotMention: ['hallucinated'] },
    });
    const exec: ScenarioExecution = {
      answer: 'This is a hallucinated wine.',
      stepCount: 1,
      toolCallCount: 0,
      toolsUsed: [],
      observations: [],
      terminationReason: 'answer',
      totalDurationMs: 1000,
      totalTokens: { input: 0, output: 0 },
    };
    const scored: ScenarioResult = {
      id: 99,
      tier: 'single_shot',
      query: 'red wine',
      skipped: false,
      answer: 'This is a hallucinated wine.',
      stepCount: 1,
      terminationReason: 'answer',
      scores: makeScores(),
      judgeRequiredButSkipped: false,
    };
    const updated = applyAnnotationDiagnostics(scored, exec, annotation);
    const critical = (updated.diagnostics ?? []).filter((d) => d.severity === 'critical');
    expect(critical.map((d) => d.code)).toContain('annotation_must_not_mention_violation');
  });
});

// ─── env manifest ────────────────────────────────────────────────────────

describe('env manifest — hash stability', () => {
  it('two identical configs produce identical hashes', () => {
    const a = buildEnvManifest({
      agentModel: 'gpt-5.4-mini',
      judgeModel: 'gpt-5.4-mini',
      embeddingModel: 'text-embedding-3-small',
      apiBaseDomain: 'api.openai.com',
      container: 'real',
      seed: 42,
      profile: 'standard',
      promptHash: 'deadbeef00000000',
    });
    const b = buildEnvManifest({
      agentModel: 'gpt-5.4-mini',
      judgeModel: 'gpt-5.4-mini',
      embeddingModel: 'text-embedding-3-small',
      apiBaseDomain: 'api.openai.com',
      container: 'real',
      seed: 42,
      profile: 'standard',
      promptHash: 'deadbeef00000000',
    });
    // capturedAt differs (timestamp), but hash excludes it.
    expect(manifestHash(a)).toBe(manifestHash(b));
  });

  it('manifest passes its own Zod schema', () => {
    const m = buildEnvManifest({
      agentModel: 'gpt-5.4-mini',
      judgeModel: null,
      embeddingModel: 'text-embedding-3-small',
      apiBaseDomain: 'api.openai.com',
      container: 'real',
      seed: null,
      profile: undefined,
      promptHash: 'a'.repeat(16),
    });
    expect(envManifestSchema.parse(m).judgeModel).toBe('disabled');
  });

  it('different seeds produce different hashes', () => {
    const a = buildEnvManifest({
      agentModel: 'gpt-5.4-mini', judgeModel: null, embeddingModel: 'text-embedding-3-small',
      apiBaseDomain: 'api.openai.com', container: 'real', seed: 1, profile: undefined,
      promptHash: 'a'.repeat(16),
    });
    const b = buildEnvManifest({
      agentModel: 'gpt-5.4-mini', judgeModel: null, embeddingModel: 'text-embedding-3-small',
      apiBaseDomain: 'api.openai.com', container: 'real', seed: 2, profile: undefined,
      promptHash: 'a'.repeat(16),
    });
    expect(manifestHash(a)).not.toBe(manifestHash(b));
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────

function makeScores(): ScenarioResult['scores'] {
  return {
    executionEfficiency: 1,
    toolAccuracy: 1,
    stepEfficiency: 1,
    answerQuality: 1,
    terminationCorrectness: 1,
    costEfficiency: 1,
    faithfulness: null,
    contextRelevance: null,
    contextRecall: null,
    exactLookupHit: null,
    failClosedAccuracy: null,
    answerRelevancy: null,
    judge: null,
    overall: 1,
    criticalFailure: false,
    semanticConstraintRecall: null,
    scrHard: null,
    scrSoft: null,
    scrInferred: null,
    scrInferredGraph: null,
    entityLinkingAccuracy: null,
    slotF1Strict: null,
    slotF1Relaxed: null,
    csrOverall: null,
    csrHard: null,
    csrSoft: null,
    csrInferred: null,
    csrInferredGraph: null,
  };
}

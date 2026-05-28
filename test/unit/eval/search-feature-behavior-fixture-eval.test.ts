import { describe, expect, it } from 'vitest';

import {
  buildSearchFeatureBehaviorReport,
  evaluateCase,
  extractSearchResponseFromUseCaseResponse,
  type SearchFeatureBehaviorFixtureReport,
  summarizeSearchFeatureBehaviorCorpusGovernance,
  validateSearchFeatureBehaviorCorpusGovernance,
} from '../../../scripts/eval/run-search-feature-behavior-fixture-eval.ts';

// ─── Test helpers ────────────────────────────────────────────────────────────

interface CaseResult {
  benchmark_id: string;
  query: string;
  pass: boolean;
  topKHit: boolean;
  constraintCompliant: boolean;
  top_entity_id: string | null;
  top_k_entities: readonly string[];
  expected_constraints_summary: readonly string[];
  constraint_violation_reason: string | null;
}

function makeResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    benchmark_id: 'sfb-001',
    query: 'test query',
    pass: true,
    topKHit: true,
    constraintCompliant: true,
    top_entity_id: 'wine-001',
    top_k_entities: ['wine-001'],
    expected_constraints_summary: [],
    constraint_violation_reason: null,
    ...overrides,
  };
}

function makeFixtureCase(
  overrides: Partial<{
    benchmark_id: string;
    query: string;
    category: string;
    language: 'ko' | 'en' | 'mixed';
    difficulty: 'easy' | 'medium' | 'hard';
    top_k: number;
    evaluation_mode: string;
    target_entity_id: string | undefined;
    expected_constraints_summary: readonly string[];
    answer_must_match: readonly string[];
    answer_must_not_match: readonly string[];
  }> = {},
) {
  return {
    benchmark_id: 'sfb-001',
    query: '풀바디 레드 와인',
    category: 'attribute_recovery',
    language: 'ko' as const,
    difficulty: 'easy' as const,
    top_k: 3,
    evaluation_mode: 'exact_entity_topk',
    target_entity_id: 'wine-001',
    expected_constraints_summary: [],
    answer_must_match: [],
    answer_must_not_match: [],
    ...overrides,
  };
}

// ─── Report builder ───────────────────────────────────────────────────────────

describe('buildSearchFeatureBehaviorReport', () => {
  it('returns zero metrics for empty results', () => {
    const report = buildSearchFeatureBehaviorReport([]);
    expect(report.query_count).toBe(0);
    expect(report.top3_accuracy).toBe(0);
    expect(report.constraint_compliance_rate).toBe(0);
    expect(report.min_pass_rate).toBe(0);
    expect(report.failures).toHaveLength(0);
    expect(report.benchmark).toBe('search-feature-behavior-fixture');
    expect(report.suite_id).toBe('search_feature_behavior');
  });

  it('computes top3_accuracy as topKHit proportion', () => {
    const results = [
      makeResult({ topKHit: true, constraintCompliant: true, pass: true }),
      makeResult({ benchmark_id: 'sfb-002', topKHit: false, constraintCompliant: true, pass: false }),
      makeResult({ benchmark_id: 'sfb-003', topKHit: true, constraintCompliant: false, pass: false }),
      makeResult({ benchmark_id: 'sfb-004', topKHit: true, constraintCompliant: true, pass: true }),
    ];
    const report = buildSearchFeatureBehaviorReport(results);
    expect(report.top3_accuracy).toBeCloseTo(3 / 4);
    expect(report.constraint_compliance_rate).toBeCloseTo(3 / 4);
    expect(report.min_pass_rate).toBeCloseTo(2 / 4);
  });

  it('includes only failures in failures array', () => {
    const results = [
      makeResult({ pass: true }),
      makeResult({ benchmark_id: 'sfb-002', pass: false, constraint_violation_reason: '2 unmet constraints: region, vintage' }),
    ];
    const report = buildSearchFeatureBehaviorReport(results);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.benchmark_id).toBe('sfb-002');
    expect(report.failures[0]?.constraint_violation_reason).toBe('2 unmet constraints: region, vintage');
  });

  it('caps failures at 50', () => {
    const results = Array.from({ length: 60 }, (_, i) =>
      makeResult({ benchmark_id: `sfb-${String(i).padStart(3, '0')}`, pass: false }),
    );
    const report = buildSearchFeatureBehaviorReport(results);
    expect(report.failures.length).toBeLessThanOrEqual(50);
  });

  it('failure records include all required ADR-005 fields', () => {
    const results = [
      makeResult({
        benchmark_id: 'sfb-002',
        query: '타닌 적은 레드와인',
        pass: false,
        top_entity_id: 'wrong-wine',
        top_k_entities: ['wrong-wine', 'another-wine'],
        expected_constraints_summary: ['low_tannin', 'red_wine'],
        constraint_violation_reason: 'unmet: tannin constraint',
      }),
    ];
    const report = buildSearchFeatureBehaviorReport(results);
    const failure = report.failures[0];
    expect(failure).toBeDefined();
    expect(failure?.benchmark_id).toBe('sfb-002');
    expect(failure?.query).toBe('타닌 적은 레드와인');
    expect(failure?.top_entity_id).toBe('wrong-wine');
    expect(failure?.top_k_entities).toEqual(['wrong-wine', 'another-wine']);
    expect(failure?.expected_constraints_summary).toEqual(['low_tannin', 'red_wine']);
    expect(failure?.constraint_violation_reason).toBe('unmet: tannin constraint');
  });

  it('perfect results produce 1.0 for all metrics', () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      makeResult({ benchmark_id: `sfb-${String(i).padStart(3, '0')}`, pass: true }),
    );
    const report = buildSearchFeatureBehaviorReport(results);
    expect(report.top3_accuracy).toBe(1);
    expect(report.constraint_compliance_rate).toBe(1);
    expect(report.min_pass_rate).toBe(1);
    expect(report.failures).toHaveLength(0);
  });

  it('evaluated_at is a valid ISO 8601 timestamp', () => {
    const report = buildSearchFeatureBehaviorReport([makeResult()]);
    expect(() => new Date(report.evaluated_at)).not.toThrow();
    expect(Number.isFinite(new Date(report.evaluated_at).getTime())).toBe(true);
  });
});

// ─── Top-K hit scoring ───────────────────────────────────────────────────────

describe('top-K hit scoring semantics', () => {
  it('case with topKHit=false contributes to failures even if constraintCompliant=true', () => {
    const results = [
      makeResult({ topKHit: false, constraintCompliant: true, pass: false }),
    ];
    const report = buildSearchFeatureBehaviorReport(results);
    expect(report.min_pass_rate).toBe(0);
    expect(report.top3_accuracy).toBe(0);
    expect(report.constraint_compliance_rate).toBe(1);
  });

  it('case with constraintCompliant=false contributes to failures even if topKHit=true', () => {
    const results = [
      makeResult({ topKHit: true, constraintCompliant: false, pass: false }),
    ];
    const report = buildSearchFeatureBehaviorReport(results);
    expect(report.min_pass_rate).toBe(0);
    expect(report.top3_accuracy).toBe(1);
    expect(report.constraint_compliance_rate).toBe(0);
  });
});

// ─── Threshold violation detection ──────────────────────────────────────────

describe('threshold violation detection (report shape)', () => {
  it('report shape satisfies ADR-005 required output contract', () => {
    const report: SearchFeatureBehaviorFixtureReport = buildSearchFeatureBehaviorReport([
      makeResult({ pass: true }),
    ]);
    // Required fields per ADR-005 Workstream A
    expect(report).toHaveProperty('benchmark');
    expect(report).toHaveProperty('suite_id');
    expect(report).toHaveProperty('query_count');
    expect(report).toHaveProperty('top3_accuracy');
    expect(report).toHaveProperty('constraint_compliance_rate');
    expect(report).toHaveProperty('min_pass_rate');
    expect(report).toHaveProperty('failures');
    expect(report).toHaveProperty('evaluated_at');
  });
});

describe('search_feature_behavior corpus governance', () => {
  it('summarizes corpus diversity and coverage', () => {
    const summary = summarizeSearchFeatureBehaviorCorpusGovernance([
      makeFixtureCase({
        benchmark_id: 'sfb-001',
        category: 'attribute_recovery',
        difficulty: 'easy',
        evaluation_mode: 'exact_entity_topk',
        target_entity_id: 'wine-001',
      }),
      makeFixtureCase({
        benchmark_id: 'sfb-002',
        category: 'negation_behavior',
        difficulty: 'medium',
        evaluation_mode: 'answer_rubric',
        target_entity_id: undefined,
        answer_must_not_match: ['sparkling'],
      }),
    ]);

    expect(summary.queryCount).toBe(2);
    expect(summary.categoryMix).toEqual({ attribute_recovery: 1, negation_behavior: 1 });
    expect(summary.difficultyMix).toEqual({ easy: 1, medium: 1 });
    expect(summary.languageMix).toEqual({ ko: 2 });
    expect(summary.evaluationModeMix).toEqual({ answer_rubric: 1, exact_entity_topk: 1 });
    expect(summary.targetEntityCaseCount).toBe(1);
    expect(summary.constraintBearingCaseCount).toBe(1);
    expect(summary.entityShareTop).toEqual([
      expect.objectContaining({ entityId: 'wine-001', count: 1, share: 0.5 }),
    ]);
  });

  it('fails closed when the external suite is too small and shallow', () => {
    expect(() => validateSearchFeatureBehaviorCorpusGovernance([
      makeFixtureCase({
        benchmark_id: 'sfb-001',
        category: 'attribute_recovery',
        difficulty: 'easy',
        evaluation_mode: 'exact_entity_topk',
        target_entity_id: 'wine-001',
      }),
      makeFixtureCase({
        benchmark_id: 'sfb-002',
        category: 'attribute_recovery',
        difficulty: 'easy',
        evaluation_mode: 'exact_entity_topk',
        target_entity_id: 'wine-002',
      }),
      makeFixtureCase({
        benchmark_id: 'sfb-003',
        category: 'attribute_recovery',
        difficulty: 'easy',
        evaluation_mode: 'answer_rubric',
        target_entity_id: undefined,
        answer_must_not_match: ['sparkling'],
      }),
    ])).toThrow(/query_count=3 < minimum 12/);
  });

  it('rejects corpora over-concentrated on one target entity', () => {
    const cases = Array.from({ length: 12 }, (_, index) =>
      makeFixtureCase({
        benchmark_id: `sfb-${String(index + 1).padStart(3, '0')}`,
        category: index < 6 ? 'attribute_recovery' : 'regional_style',
        difficulty: index < 10 ? 'medium' : 'hard',
        evaluation_mode: 'exact_entity_topk',
        target_entity_id: index < 5 ? 'wine-hot' : `wine-${index + 1}`,
        expected_constraints_summary: ['wine_type=red'],
      }),
    );

    expect(() => validateSearchFeatureBehaviorCorpusGovernance(cases)).toThrow(/entity_share_cap_exceeded/);
  });
});

describe('evaluateCase', () => {
  it('maps in-process SearchResponseV1 payloads into fixture-eval response shape', () => {
    const response = extractSearchResponseFromUseCaseResponse({
      queryType: 'search',
      engineDecision: {
        decisionStatus: 'resolved',
        nextAction: 'answer',
        route: 'hybrid',
        decisionConfidence: 0.61,
        confidenceSemantics: 'uncalibrated_decision_score',
        decisionTraceRef: 'trace',
        decisionSnapshot: {
          snapshotId: 'snapshot',
          modelVersions: {},
          indexVersions: {},
          policyRuleVersion: '1.0.0',
          plannerVersion: '1.0.0',
          thresholdProfileId: 'heuristic-v1.0',
          featureFlags: {},
          responseContractVersion: 'search_response_v1',
        },
      },
      results: [{
        entity: {
          entityId: 'wine-001',
          canonicalLabel: 'Wine 001',
          type: 'wine',
          wineType: 'white',
          style: 'crisp white',
        },
        relevanceScore: 0.9,
        match: {
          matchType: 'semantic',
          scoreComponents: {
            lexical: 0.1,
            semantic: 0.7,
            attribute: 0.1,
            popularity: 0,
          },
        },
        constraints: {
          matched: ['wine_type'],
          unmet: ['acidity'],
          inferred: [],
        },
        uncertainty: {
          uncertaintyConfidence: 0.7,
          missingInfo: [],
          approximationUsed: false,
        },
        evidenceItems: [],
        violatedConstraints: ['acidity'],
        matchReasons: ['fresh acidity'],
      }],
      meta: {
        requestId: 'req-1',
        queryTimeMs: 10,
        route: 'hybrid',
        version: '1.0.0',
        engineSchemaVersion: 'search_response_v1',
      },
    });

    expect(response).toEqual({
      decision_status: 'resolved',
      results: [{
        entity_id: 'wine-001',
        canonical_label: 'Wine 001',
        wine_type: 'white',
        style: 'crisp white',
        constraints: {
          matched: ['wine_type'],
          unmet: ['acidity'],
          inferred: [],
        },
        violated_constraints: ['acidity'],
        match_reasons: ['fresh acidity'],
      }],
    });
  });

  it('supports answer_rubric cases via top-k positive match and top-1 negative guard', () => {
    const result = evaluateCase(
      makeFixtureCase({
        evaluation_mode: 'answer_rubric',
        target_entity_id: undefined,
        answer_must_match: ['(opus|sassicaia|margaux|grange|barolo|amarone)'],
        answer_must_not_match: ['(sparkling|샴페인|화이트|sweet|달달)'],
      }),
      {
        decision_status: 'resolved',
        results: [
          {
            entity_id: 'barolo-giacomo',
            canonical_label: 'Giacomo Conterno Barolo Monfortino',
            wine_type: 'red',
            style: 'full-body red',
            constraints: { matched: [], unmet: [], inferred: [] },
            violated_constraints: undefined,
            match_reasons: ['full-body red'],
          },
        ],
      },
    );

    expect(result.topKHit).toBe(true);
    expect(result.constraintCompliant).toBe(true);
    expect(result.pass).toBe(true);
  });

  it('fails answer_rubric when top-1 matches a forbidden pattern', () => {
    const result = evaluateCase(
      makeFixtureCase({
        evaluation_mode: 'answer_rubric',
        target_entity_id: undefined,
        answer_must_match: ['(moet|krug|dom)'],
        answer_must_not_match: ['(sparkling|샴페인|화이트|sweet|달달)'],
      }),
      {
        decision_status: 'resolved',
        results: [
          {
            entity_id: 'moet-brut-nv',
            canonical_label: 'Moet Brut Imperial',
            wine_type: 'sparkling',
            style: 'sparkling',
            constraints: { matched: [], unmet: [], inferred: [] },
            violated_constraints: undefined,
            match_reasons: ['sparkling'],
          },
        ],
      },
    );

    expect(result.topKHit).toBe(true);
    expect(result.constraintCompliant).toBe(false);
    expect(result.pass).toBe(false);
    expect(result.constraint_violation_reason).toMatch(/forbidden answer_rubric pattern/);
  });

  it('smoke answer_rubric payload can satisfy the positive rubric path', () => {
    const result = evaluateCase(
      makeFixtureCase({
        evaluation_mode: 'answer_rubric',
        target_entity_id: undefined,
        answer_must_match: ['(opus|grange|sassicaia|margaux)'],
      }),
      {
        decision_status: 'resolved',
        results: [
          {
            entity_id: 'smoke-entity-sfb-012',
            canonical_label: 'smoke-entity-sfb-012',
            constraints: { matched: [], unmet: [], inferred: [] },
            violated_constraints: undefined,
            match_reasons: ['(opus|grange|sassicaia|margaux)'],
          },
        ],
      },
    );

    expect(result.pass).toBe(true);
  });
});

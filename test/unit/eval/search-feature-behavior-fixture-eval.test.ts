import { describe, expect, it } from 'vitest';

import {
  buildSearchFeatureBehaviorReport,
  type SearchFeatureBehaviorFixtureReport,
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

import { describe, expect, it } from 'vitest';

import {
  buildPerformanceLoadReport,
  type PerformanceLoadFixtureReport,
} from '../../../scripts/eval/run-performance-load-fixture-eval.ts';

// ─── Test helpers ────────────────────────────────────────────────────────────

interface CaseLoadResult {
  benchmark_id: string;
  query: string;
  achieved_rps: number;
  error_rate: number;
  p99_latency_ms: number;
  pass: boolean;
  violation_reason: string | null;
}

function makeLoadResult(overrides: Partial<CaseLoadResult> = {}): CaseLoadResult {
  return {
    benchmark_id: 'pld-001',
    query: 'Opus One',
    achieved_rps: 50,
    error_rate: 0,
    p99_latency_ms: 200,
    pass: true,
    violation_reason: null,
    ...overrides,
  };
}

// ─── Report builder ───────────────────────────────────────────────────────────

describe('buildPerformanceLoadReport', () => {
  it('returns zero metrics for empty results', () => {
    const report = buildPerformanceLoadReport([]);
    expect(report.query_count).toBe(0);
    expect(report.achieved_rps).toBe(0);
    expect(report.error_rate).toBe(0);
    expect(report.p99_latency_under_load_ms).toBe(0);
    expect(report.min_pass_rate).toBe(0);
    expect(report.benchmark).toBe('performance-load-fixture');
    expect(report.suite_id).toBe('performance_load');
  });

  it('aggregates rps, error_rate as mean across cases', () => {
    const results = [
      makeLoadResult({ achieved_rps: 40, error_rate: 0.01 }),
      makeLoadResult({ benchmark_id: 'pld-002', achieved_rps: 60, error_rate: 0.03 }),
    ];
    const report = buildPerformanceLoadReport(results);
    expect(report.achieved_rps).toBeCloseTo(50);
    expect(report.error_rate).toBeCloseTo(0.02);
  });

  it('computes p99_latency_under_load_ms as p99 of per-case p99 values', () => {
    const results = [
      makeLoadResult({ p99_latency_ms: 100 }),
      makeLoadResult({ benchmark_id: 'pld-002', p99_latency_ms: 200 }),
      makeLoadResult({ benchmark_id: 'pld-003', p99_latency_ms: 1500 }),
    ];
    const report = buildPerformanceLoadReport(results);
    // p99 of [100, 200, 1500] should be near 1500
    expect(report.p99_latency_under_load_ms).toBeGreaterThanOrEqual(1000);
  });

  it('min_pass_rate reflects proportion of passing cases', () => {
    const results = [
      makeLoadResult({ pass: true }),
      makeLoadResult({ benchmark_id: 'pld-002', pass: false, violation_reason: 'achieved_rps=5.00 < target 10.00' }),
      makeLoadResult({ benchmark_id: 'pld-003', pass: true }),
      makeLoadResult({ benchmark_id: 'pld-004', pass: false, violation_reason: 'p99=2000ms > SLO 500ms' }),
    ];
    const report = buildPerformanceLoadReport(results);
    expect(report.min_pass_rate).toBeCloseTo(0.5);
  });

  it('failure records include all ADR-005 Workstream C required fields', () => {
    const results = [
      makeLoadResult({
        benchmark_id: 'pld-002',
        query: '10만원 이하 와인',
        pass: false,
        achieved_rps: 3,
        error_rate: 0.15,
        p99_latency_ms: 2500,
        violation_reason: 'achieved_rps=3.00 < target 10.00',
      }),
    ];
    const report = buildPerformanceLoadReport(results);
    expect(report.failures).toHaveLength(1);
    const f = report.failures[0];
    expect(f?.benchmark_id).toBe('pld-002');
    expect(f?.query).toBe('10만원 이하 와인');
    expect(f?.achieved_rps).toBe(3);
    expect(f?.error_rate).toBe(0.15);
    expect(f?.p99_latency_ms).toBe(2500);
    expect(f?.violation_reason).toBe('achieved_rps=3.00 < target 10.00');
  });

  it('caps failures at 50', () => {
    const results = Array.from({ length: 60 }, (_, i) =>
      makeLoadResult({ benchmark_id: `pld-${String(i).padStart(3, '0')}`, pass: false }),
    );
    const report = buildPerformanceLoadReport(results);
    expect(report.failures.length).toBeLessThanOrEqual(50);
  });

  it('all-passing results yield min_pass_rate=1 and empty failures', () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeLoadResult({ benchmark_id: `pld-${String(i + 1).padStart(3, '0')}`, pass: true }),
    );
    const report = buildPerformanceLoadReport(results);
    expect(report.min_pass_rate).toBe(1);
    expect(report.failures).toHaveLength(0);
  });

  it('evaluated_at is a valid ISO 8601 timestamp', () => {
    const report = buildPerformanceLoadReport([makeLoadResult()]);
    expect(Number.isFinite(new Date(report.evaluated_at).getTime())).toBe(true);
  });
});

// ─── ADR-005 output contract ──────────────────────────────────────────────────

describe('report shape satisfies ADR-005 Workstream C required output', () => {
  it('has all required fields', () => {
    const report: PerformanceLoadFixtureReport = buildPerformanceLoadReport([
      makeLoadResult(),
    ]);
    expect(report).toHaveProperty('benchmark');
    expect(report).toHaveProperty('suite_id');
    expect(report).toHaveProperty('query_count');
    expect(report).toHaveProperty('achieved_rps');
    expect(report).toHaveProperty('error_rate');
    expect(report).toHaveProperty('p99_latency_under_load_ms');
    expect(report).toHaveProperty('min_pass_rate');
    expect(report).toHaveProperty('failures');
    expect(report).toHaveProperty('evaluated_at');
  });
});

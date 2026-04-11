import { describe, expect, it } from 'vitest';

import {
  buildPerformanceLatencyReport,
  type PerformanceLatencyFixtureReport,
} from '../../../scripts/eval/run-performance-latency-fixture-eval.ts';

// ─── Test helpers ────────────────────────────────────────────────────────────

interface CaseLatencyResult {
  benchmark_id: string;
  query: string;
  duration_ms: number;
  slo_p95_ms: number | undefined;
  pass: boolean;
  violation_reason: string | null;
}

function makeLatencyResult(overrides: Partial<CaseLatencyResult> = {}): CaseLatencyResult {
  return {
    benchmark_id: 'plt-001',
    query: 'Opus One 2018',
    duration_ms: 100,
    slo_p95_ms: 500,
    pass: true,
    violation_reason: null,
    ...overrides,
  };
}

// ─── Report builder ───────────────────────────────────────────────────────────

describe('buildPerformanceLatencyReport', () => {
  it('returns zero metrics for empty results', () => {
    const report = buildPerformanceLatencyReport([]);
    expect(report.query_count).toBe(0);
    expect(report.slo_pass_rate).toBe(0);
    expect(report.min_pass_rate).toBe(0);
    expect(report.latency_summary.p50).toBe(0);
    expect(report.latency_summary.p95).toBe(0);
    expect(report.latency_summary.p99).toBe(0);
    expect(report.benchmark).toBe('performance-latency-fixture');
    expect(report.suite_id).toBe('performance_latency');
  });

  it('computes percentiles correctly for known duration values', () => {
    // 10 results: 100-1000ms in steps of 100
    const results = Array.from({ length: 10 }, (_, i) =>
      makeLatencyResult({ benchmark_id: `plt-${String(i + 1).padStart(3, '0')}`, duration_ms: (i + 1) * 100, pass: true }),
    );
    const report = buildPerformanceLatencyReport(results);
    expect(report.latency_summary.p50).toBeCloseTo(550, 0);
    expect(report.latency_summary.p95).toBeGreaterThanOrEqual(900);
    expect(report.latency_summary.p99).toBeGreaterThanOrEqual(950);
  });

  it('slo_pass_rate reflects proportion of passing cases', () => {
    const results = [
      makeLatencyResult({ pass: true }),
      makeLatencyResult({ benchmark_id: 'plt-002', pass: false, duration_ms: 2000, violation_reason: '2000ms > p95 SLO 500ms' }),
      makeLatencyResult({ benchmark_id: 'plt-003', pass: true }),
    ];
    const report = buildPerformanceLatencyReport(results);
    expect(report.slo_pass_rate).toBeCloseTo(2 / 3);
    expect(report.min_pass_rate).toBeCloseTo(2 / 3);
  });

  it('failure records include required fields', () => {
    const results = [
      makeLatencyResult({
        benchmark_id: 'plt-002',
        query: 'DRC Romanée-Conti',
        pass: false,
        duration_ms: 3200,
        slo_p95_ms: 500,
        violation_reason: '3200ms > p95 SLO 500ms',
      }),
    ];
    const report = buildPerformanceLatencyReport(results);
    expect(report.failures).toHaveLength(1);
    const f = report.failures[0];
    expect(f?.benchmark_id).toBe('plt-002');
    expect(f?.query).toBe('DRC Romanée-Conti');
    expect(f?.duration_ms).toBe(3200);
    expect(f?.slo_p95_ms).toBe(500);
    expect(f?.violation_reason).toBe('3200ms > p95 SLO 500ms');
  });

  it('caps failures at 50', () => {
    const results = Array.from({ length: 60 }, (_, i) =>
      makeLatencyResult({ benchmark_id: `plt-${String(i).padStart(3, '0')}`, pass: false }),
    );
    const report = buildPerformanceLatencyReport(results);
    expect(report.failures.length).toBeLessThanOrEqual(50);
  });

  it('all-passing results yield slo_pass_rate=1 and empty failures', () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeLatencyResult({ benchmark_id: `plt-${String(i + 1).padStart(3, '0')}`, pass: true }),
    );
    const report = buildPerformanceLatencyReport(results);
    expect(report.slo_pass_rate).toBe(1);
    expect(report.failures).toHaveLength(0);
  });

  it('evaluated_at is a valid ISO 8601 timestamp', () => {
    const report = buildPerformanceLatencyReport([makeLatencyResult()]);
    expect(Number.isFinite(new Date(report.evaluated_at).getTime())).toBe(true);
  });
});

// ─── ADR-005 output contract ──────────────────────────────────────────────────

describe('report shape satisfies ADR-005 Workstream B required output', () => {
  it('has all required fields', () => {
    const report: PerformanceLatencyFixtureReport = buildPerformanceLatencyReport([
      makeLatencyResult(),
    ]);
    expect(report).toHaveProperty('benchmark');
    expect(report).toHaveProperty('suite_id');
    expect(report).toHaveProperty('query_count');
    expect(report).toHaveProperty('slo_pass_rate');
    expect(report).toHaveProperty('latency_summary');
    expect(report.latency_summary).toHaveProperty('p50');
    expect(report.latency_summary).toHaveProperty('p95');
    expect(report.latency_summary).toHaveProperty('p99');
    expect(report).toHaveProperty('min_pass_rate');
    expect(report).toHaveProperty('failures');
    expect(report).toHaveProperty('evaluated_at');
  });
});

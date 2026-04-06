import { describe, expect, it } from 'vitest';
import {
  buildEvalMetricPolicySummary,
  createEvalMetricViolation,
  getEvalMetricPolicy,
  splitEvalMetricViolations,
} from '../../../../scripts/eval/eval-metric-policy.js';

describe('eval metric policy', () => {
  it('treats global release metrics as blocking', () => {
    expect(getEvalMetricPolicy({ scope: 'global', metric: 'wrong_top1_rate' })).toBe('blocking');
    expect(getEvalMetricPolicy({ scope: 'scenario', metric: 'ndcg_at_10' })).toBe('blocking');
  });

  it('treats mode metrics as advisory', () => {
    expect(getEvalMetricPolicy({ scope: 'mode', metric: 'producer_variety' })).toBe('advisory');
    expect(getEvalMetricPolicy({ scope: 'entity_type', metric: 'confusion_rate' })).toBe('advisory');
  });

  it('splits blocking and advisory violations for gate reporting', () => {
    const violations = [
      createEvalMetricViolation('global', 'wrong_top1_rate', 'wrong_top1_rate 0.03 > 0.02'),
      createEvalMetricViolation('mode', 'producer_variety', 'producer_variety 0.40 < 0.60'),
    ];

    const split = splitEvalMetricViolations(violations);
    expect(split.blocking).toHaveLength(1);
    expect(split.advisory).toHaveLength(1);
    expect(split.blocking[0]?.metric).toBe('wrong_top1_rate');
    expect(split.advisory[0]?.metric).toBe('producer_variety');
  });

  it('publishes a stable policy summary for eval JSON output', () => {
    const summary = buildEvalMetricPolicySummary();
    expect(summary.blocking_metrics).toContain('wrong_top1_rate');
    expect(summary.blocking_metrics).toContain('scenario:ndcg_at_10');
    expect(summary.advisory_metrics).toContain('producer_variety');
    expect(summary.advisory_metrics).toContain('anchor_preservation_score');
  });
});

import { describe, it, expect } from 'vitest';
import { evaluateRollback, type RollbackThresholds } from '../service/auto-rollback-decision.js';
import type { QualitySnapshot } from '../service/online-quality-monitor.js';

const THRESHOLDS: RollbackThresholds = {
  ctrDropPct: 0.10,
  zeroResultRiseAbs: 0.05,
  minSamples: 1000,
};

function snap(overrides: Partial<QualitySnapshot>): QualitySnapshot {
  return {
    windowMs: 60_000,
    impressions: 0,
    clicks: 0,
    ctr: 0,
    zeroResultRate: 0,
    topPositionCtr: 0,
    degradationFlagRate: 0,
    ...overrides,
  };
}

describe('evaluateRollback', () => {
  it('insufficient samples → no rollback', () => {
    const baseline = snap({ impressions: 5000, ctr: 0.5 });
    const current = snap({ impressions: 500, ctr: 0.0 }); // catastrophic but too small
    const decision = evaluateRollback(current, baseline, THRESHOLDS);
    expect(decision.shouldRollback).toBe(false);
    expect(decision.reasons).toEqual([]);
  });

  it('significant CTR drop → rollback with reason', () => {
    const baseline = snap({ impressions: 5000, ctr: 0.5, zeroResultRate: 0.02 });
    const current = snap({ impressions: 5000, ctr: 0.4, zeroResultRate: 0.02 }); // 20% drop
    const decision = evaluateRollback(current, baseline, THRESHOLDS);
    expect(decision.shouldRollback).toBe(true);
    expect(decision.reasons.some((r) => r.includes('ctr dropped'))).toBe(true);
    expect(decision.reasons.some((r) => r.includes('zero-result'))).toBe(false);
  });

  it('zero-result rise → rollback with reason', () => {
    const baseline = snap({ impressions: 5000, ctr: 0.5, zeroResultRate: 0.02 });
    const current = snap({ impressions: 5000, ctr: 0.5, zeroResultRate: 0.10 }); // +8pp
    const decision = evaluateRollback(current, baseline, THRESHOLDS);
    expect(decision.shouldRollback).toBe(true);
    expect(decision.reasons.some((r) => r.includes('zero-result'))).toBe(true);
    expect(decision.reasons.some((r) => r.includes('ctr dropped'))).toBe(false);
  });

  it('both fire → multiple reasons', () => {
    const baseline = snap({ impressions: 5000, ctr: 0.5, zeroResultRate: 0.02 });
    const current = snap({ impressions: 5000, ctr: 0.3, zeroResultRate: 0.15 });
    const decision = evaluateRollback(current, baseline, THRESHOLDS);
    expect(decision.shouldRollback).toBe(true);
    expect(decision.reasons).toHaveLength(2);
  });

  it('stable metrics → no rollback', () => {
    const baseline = snap({ impressions: 5000, ctr: 0.5, zeroResultRate: 0.02 });
    const current = snap({ impressions: 5000, ctr: 0.49, zeroResultRate: 0.025 });
    const decision = evaluateRollback(current, baseline, THRESHOLDS);
    expect(decision.shouldRollback).toBe(false);
    expect(decision.reasons).toEqual([]);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createCalibrationHealthRegistry,
  type CalibrationHealthRegistry,
} from '../calibration-health-registry.js';

describe('CalibrationHealthRegistry', () => {
  let reg: CalibrationHealthRegistry;
  beforeEach(() => {
    reg = createCalibrationHealthRegistry();
  });

  it('records a fresh trusted load with method', () => {
    reg.recordParamLoad('short_entity', { trusted: true, method: 'isotonic' });
    expect(reg.getClassStatus('short_entity')).toEqual({
      queryClass: 'short_entity',
      trusted: true,
      method: 'isotonic',
      trustGateDowngradeCount: 0,
    });
  });

  it('records an untrusted load with its reason + stale params method', () => {
    reg.recordParamLoad('short_entity', { trusted: false, reason: 'stale', method: 'platt' });
    const s = reg.getClassStatus('short_entity');
    expect(s?.trusted).toBe(false);
    expect(s?.reason).toBe('stale');
    expect(s?.method).toBe('platt');
  });

  it('records a missing-params untrusted load with no method', () => {
    reg.recordParamLoad('exact_entity', { trusted: false, reason: 'missing' });
    const s = reg.getClassStatus('exact_entity');
    expect(s?.trusted).toBe(false);
    expect(s?.reason).toBe('missing');
    expect(s?.method).toBeUndefined();
  });

  it('counts trust-gate downgrades per class (fires exactly once per call)', () => {
    reg.recordTrustGateDowngrade('short_entity');
    reg.recordTrustGateDowngrade('short_entity');
    reg.recordTrustGateDowngrade('short_entity');
    expect(reg.getTrustGateDowngradeCount('short_entity')).toBe(3);
    expect(reg.getTrustGateDowngradeCount('exact_entity')).toBe(0);
  });

  it('downgrade counts are scoped by query class (no cross-class leakage)', () => {
    reg.recordTrustGateDowngrade('short_entity');
    reg.recordTrustGateDowngrade('semantic_preference');
    expect(reg.getTrustGateDowngradeCount('short_entity')).toBe(1);
    expect(reg.getTrustGateDowngradeCount('semantic_preference')).toBe(1);
    expect(reg.getTrustGateDowngradeCount('no_match')).toBe(0);
  });

  // ── False-positive guards (verdict-required) ─────────────────────────────

  it('FALSE-POSITIVE: a fresh trusted load is the healthy baseline — never looks untrusted', () => {
    reg.recordParamLoad('short_entity', { trusted: true, method: 'isotonic' });
    const s = reg.getClassStatus('short_entity');
    expect(s?.trusted).toBe(true);
    expect(s?.reason).toBeUndefined();
    // A healthy class accrues zero downgrades on a pure-load path.
    expect(reg.getTrustGateDowngradeCount('short_entity')).toBe(0);
  });

  it('FALSE-POSITIVE: recording a load does NOT imply a downgrade (disjoint signals)', () => {
    reg.recordParamLoad('short_entity', { trusted: false, reason: 'stale', method: 'platt' });
    // Untrusted load alone (stale params still applied for display) is NOT a
    // downgrade — the downgrade counter only moves when the decision engine
    // actually walls off a resolve.
    expect(reg.getTrustGateDowngradeCount('short_entity')).toBe(0);
  });

  it('a class seen only via a downgrade still surfaces in status/snapshot', () => {
    reg.recordTrustGateDowngrade('short_entity');
    expect(reg.getClassStatus('short_entity')).toEqual({
      queryClass: 'short_entity',
      trusted: false,
      trustGateDowngradeCount: 1,
    });
  });

  it('snapshot lists every class seen by load or downgrade, sorted, with counts', () => {
    reg.recordParamLoad('exact_entity', { trusted: true, method: 'isotonic' });
    reg.recordParamLoad('short_entity', { trusted: false, reason: 'stale', method: 'platt' });
    reg.recordTrustGateDowngrade('short_entity');
    reg.recordTrustGateDowngrade('semantic_preference');
    const snap = reg.snapshot();
    expect(snap.map((s) => s.queryClass)).toEqual([
      'exact_entity',
      'semantic_preference',
      'short_entity',
    ]);
    const shortEntity = snap.find((s) => s.queryClass === 'short_entity');
    expect(shortEntity).toEqual({
      queryClass: 'short_entity',
      trusted: false,
      reason: 'stale',
      method: 'platt',
      trustGateDowngradeCount: 1,
    });
  });

  it('getClassStatus is undefined for a never-seen class (no phantom rows)', () => {
    expect(reg.getClassStatus('never_seen')).toBeUndefined();
  });

  it('reset clears both status and downgrade counters', () => {
    reg.recordParamLoad('short_entity', { trusted: true, method: 'isotonic' });
    reg.recordTrustGateDowngrade('short_entity');
    reg.reset();
    expect(reg.snapshot()).toEqual([]);
    expect(reg.getTrustGateDowngradeCount('short_entity')).toBe(0);
  });
});

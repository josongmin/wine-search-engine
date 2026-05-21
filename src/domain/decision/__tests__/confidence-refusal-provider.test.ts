import { describe, it, expect, beforeEach } from 'vitest';
import { ConfidenceRefusalPolicy } from '../service/confidence-refusal.js';
import type {
  RefusalThresholdLookup,
  RefusalThresholdProvider,
} from '../port/refusal-threshold-provider.port.js';
import type { RefusalThreshold } from '../model/refusal-threshold.js';
import { REFUSAL_THRESHOLD_FALLBACK_CLASS } from '../model/refusal-threshold.js';
import { globalSilentSkipCounter } from '../../observability/silent-skip-counters.js';

/**
 * P0.2: per-class AURC threshold lookup. The policy must:
 *  - look up τ by queryClass when the provider returns ok
 *  - fall back to the `general` row when the class is unknown
 *  - emit a silent-skip counter on fallback or unavailability
 *  - report calibrationTrusted=false on provider unavailability
 *
 * No external infrastructure is exercised — the provider is stubbed inline.
 */

function makeThreshold(queryClass: string, threshold: number): RefusalThreshold {
  return {
    queryClass,
    threshold,
    targetCoverage: 0.85,
    riskAtCoverage: 0.02,
    sampleSize: 1000,
    aurc: 0.05,
    fittedAt: new Date('2026-05-21T00:00:00Z'),
    datasetHash: 'deadbeef',
  };
}

class StubProvider implements RefusalThresholdProvider {
  constructor(private readonly result: RefusalThresholdLookup) {}
  loadThresholds(): Promise<RefusalThresholdLookup> {
    return Promise.resolve(this.result);
  }
}

beforeEach(() => {
  globalSilentSkipCounter.reset();
});

describe('ConfidenceRefusalPolicy (provider-backed)', () => {
  it('looks up τ by queryClass when the class is present', async () => {
    const thresholds = new Map<string, RefusalThreshold>([
      ['wine_name', makeThreshold('wine_name', 0.6)],
      ['producer', makeThreshold('producer', 0.4)],
      [REFUSAL_THRESHOLD_FALLBACK_CLASS, makeThreshold('general', 0.5)],
    ]);
    const policy = new ConfidenceRefusalPolicy({
      provider: new StubProvider({ status: 'ok', thresholds }),
    });
    const wineDecision = await policy.evaluate(0.55, 'wine_name');
    expect(wineDecision.calibrationTrusted).toBe(true);
    expect(wineDecision.shouldRefuse).toBe(true);
    expect(wineDecision.thresholdApplied).toBe(0.6);
    expect(wineDecision.classApplied).toBe('wine_name');

    const producerDecision = await policy.evaluate(0.55, 'producer');
    expect(producerDecision.shouldRefuse).toBe(false);
    expect(producerDecision.thresholdApplied).toBe(0.4);
  });

  it('falls back to the general class when queryClass is unknown', async () => {
    const thresholds = new Map<string, RefusalThreshold>([
      [REFUSAL_THRESHOLD_FALLBACK_CLASS, makeThreshold('general', 0.5)],
    ]);
    const policy = new ConfidenceRefusalPolicy({
      provider: new StubProvider({ status: 'ok', thresholds }),
    });
    const decision = await policy.evaluate(0.51, 'mystery_class');
    expect(decision.calibrationTrusted).toBe(true);
    expect(decision.shouldRefuse).toBe(false);
    expect(decision.classApplied).toBe('general');
    expect(
      globalSilentSkipCounter.snapshot()['refusal_threshold_class_fallback'],
    ).toBe(1);
  });

  it('reports calibrationTrusted=false when provider is unavailable', async () => {
    const policy = new ConfidenceRefusalPolicy({
      provider: new StubProvider({ status: 'unavailable', reason: 'db_down' }),
    });
    const decision = await policy.evaluate(0.0, 'wine_name');
    expect(decision.calibrationTrusted).toBe(false);
    expect(decision.shouldRefuse).toBe(false); // never refuse on untrusted
    expect(
      globalSilentSkipCounter.snapshot()['refusal_threshold_provider_unavailable'],
    ).toBe(1);
  });

  it('reports calibrationTrusted=false when neither exact nor fallback class exists', async () => {
    const thresholds = new Map<string, RefusalThreshold>([
      ['wine_name', makeThreshold('wine_name', 0.6)],
    ]);
    const policy = new ConfidenceRefusalPolicy({
      provider: new StubProvider({ status: 'ok', thresholds }),
    });
    const decision = await policy.evaluate(0.0, 'mystery');
    expect(decision.calibrationTrusted).toBe(false);
    expect(
      globalSilentSkipCounter.snapshot()['refusal_threshold_fallback_missing'],
    ).toBe(1);
  });

  it('treats non-finite C as refuse when calibration is trusted (adversarial)', async () => {
    const thresholds = new Map<string, RefusalThreshold>([
      ['wine_name', makeThreshold('wine_name', 0.5)],
    ]);
    const policy = new ConfidenceRefusalPolicy({
      provider: new StubProvider({ status: 'ok', thresholds }),
    });
    const decision = await policy.evaluate(Number.NaN, 'wine_name');
    expect(decision.shouldRefuse).toBe(true);
  });

  it('legacy sync shouldRefuse throws when a provider is wired (adversarial)', () => {
    const policy = new ConfidenceRefusalPolicy({
      provider: new StubProvider({ status: 'ok', thresholds: new Map() }),
    });
    expect(() => policy.shouldRefuse(0.3)).toThrow(/provider/);
  });
});

describe('ConfidenceRefusalPolicy (legacy scalar)', () => {
  it('preserves backward-compat constructor + shouldRefuse', () => {
    const policy = new ConfidenceRefusalPolicy(0.45);
    expect(policy.getThreshold()).toBe(0.45);
    expect(policy.hasProvider()).toBe(false);
    expect(policy.shouldRefuse(0.4)).toBe(true);
    expect(policy.shouldRefuse(0.5)).toBe(false);
  });

  it('no-arg constructor uses the documented backward-compat default 0.45', () => {
    const policy = new ConfidenceRefusalPolicy();
    expect(policy.getThreshold()).toBe(0.45);
  });

  it('rejects out-of-range scalar (adversarial)', () => {
    expect(() => new ConfidenceRefusalPolicy(-0.1)).toThrow();
    expect(() => new ConfidenceRefusalPolicy(1.1)).toThrow();
    expect(() => new ConfidenceRefusalPolicy(Number.NaN)).toThrow();
  });
});

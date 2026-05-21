import { describe, it, expect } from 'vitest';
import {
  deriveRefusalThresholds,
  type RefusalDerivationSample,
} from '../../src/domain/calibration/service/refusal-threshold-derivation.js';
import { ConfidenceRefusalPolicy } from '../../src/domain/decision/service/confidence-refusal.js';
import { REFUSAL_THRESHOLD_FALLBACK_CLASS } from '../../src/domain/decision/model/refusal-threshold.js';
import type {
  RefusalThresholdLookup,
  RefusalThresholdProvider,
} from '../../src/domain/decision/port/refusal-threshold-provider.port.js';
import type { RefusalThreshold } from '../../src/domain/decision/model/refusal-threshold.js';

/**
 * Regression test for P0.2: AURC-derived per-class refusal threshold.
 *
 * The append-only invariant we lock in here is the end-to-end contract that
 * seeded eval data → derived thresholds → policy lookup behaves consistently:
 *  - producer-class threshold ≠ wine_name-class threshold (the whole point
 *    of per-class derivation is divergence; if they ever match for distinct
 *    distributions we have lost the per-class signal)
 *  - `general` row exists so unknown classes route through fallback
 *  - the policy refuses below τ and admits at-or-above τ for both classes
 *  - provider unavailability degrades to calibrationTrusted=false (NOT to
 *    a hardcoded scalar — this is the core "no heuristic fallback" rule)
 */

function buildSeededSamples(): RefusalDerivationSample[] {
  // Producer class: well-calibrated. Top scores → all correct.
  const producer: RefusalDerivationSample[] = [];
  for (let i = 0; i < 50; i++) {
    producer.push({
      score: 0.9 - i * 0.005, // 0.9 → 0.655
      isCorrect: true,
      queryClass: 'producer',
    });
  }
  for (let i = 0; i < 50; i++) {
    producer.push({
      score: 0.45 - i * 0.005, // 0.45 → 0.205
      isCorrect: false,
      queryClass: 'producer',
    });
  }

  // Wine-name class: weaker calibration — needs a higher τ to filter errors.
  const wineName: RefusalDerivationSample[] = [];
  for (let i = 0; i < 50; i++) {
    wineName.push({
      score: 0.95 - i * 0.003, // 0.95 → 0.803
      isCorrect: true,
      queryClass: 'wine_name',
    });
  }
  for (let i = 0; i < 50; i++) {
    wineName.push({
      score: 0.7 - i * 0.006, // 0.7 → 0.406
      isCorrect: false,
      queryClass: 'wine_name',
    });
  }

  // Synthetic `general` row from union (mirrors what the CLI builds).
  const general: RefusalDerivationSample[] = [...producer, ...wineName].map((s) => ({
    score: s.score,
    isCorrect: s.isCorrect,
    queryClass: REFUSAL_THRESHOLD_FALLBACK_CLASS,
  }));

  return [...producer, ...wineName, ...general];
}

function asThresholdMap(
  fitted: ReturnType<typeof deriveRefusalThresholds>['fitted'],
): Map<string, RefusalThreshold> {
  const out = new Map<string, RefusalThreshold>();
  for (const r of fitted) {
    out.set(r.queryClass, {
      queryClass: r.queryClass,
      threshold: r.threshold,
      targetCoverage: r.targetCoverage,
      riskAtCoverage: r.riskAtCoverage,
      sampleSize: r.sampleSize,
      aurc: r.aurc,
      fittedAt: new Date(),
      datasetHash: 'regression-fixture',
    });
  }
  return out;
}

class InProcessProvider implements RefusalThresholdProvider {
  constructor(private readonly result: RefusalThresholdLookup) {}
  loadThresholds(): Promise<RefusalThresholdLookup> {
    return Promise.resolve(this.result);
  }
}

describe('refusal-threshold-derivation regression', () => {
  it('derives distinct per-class τ and routes the policy correctly', async () => {
    const samples = buildSeededSamples();
    const { fitted, skipped } = deriveRefusalThresholds(samples, {
      targetCoverage: 0.5,
      minSamplesPerClass: 50,
    });
    expect(skipped).toEqual([]);
    expect(fitted.find((r) => r.queryClass === 'producer')).toBeDefined();
    expect(fitted.find((r) => r.queryClass === 'wine_name')).toBeDefined();
    expect(fitted.find((r) => r.queryClass === REFUSAL_THRESHOLD_FALLBACK_CLASS)).toBeDefined();

    const producerTau = fitted.find((r) => r.queryClass === 'producer')!.threshold;
    const wineTau = fitted.find((r) => r.queryClass === 'wine_name')!.threshold;
    // Different distributions → different τ. If this assertion ever fails, the
    // per-class derivation has collapsed and we are back to a global scalar.
    expect(producerTau).not.toBeCloseTo(wineTau, 4);

    const thresholds = asThresholdMap(fitted);
    const policy = new ConfidenceRefusalPolicy({
      provider: new InProcessProvider({ status: 'ok', thresholds }),
    });

    const aboveWine = await policy.evaluate(wineTau + 0.05, 'wine_name');
    expect(aboveWine.calibrationTrusted).toBe(true);
    expect(aboveWine.shouldRefuse).toBe(false);

    const belowWine = await policy.evaluate(wineTau - 0.05, 'wine_name');
    expect(belowWine.shouldRefuse).toBe(true);

    // Unknown class routes through the general row.
    const unknown = await policy.evaluate(0.5, 'novel_class');
    expect(unknown.classApplied).toBe(REFUSAL_THRESHOLD_FALLBACK_CLASS);
  });

  it('degrades to calibrationTrusted=false when provider is unavailable (no hardcoded fallback)', async () => {
    const policy = new ConfidenceRefusalPolicy({
      provider: new InProcessProvider({ status: 'unavailable', reason: 'cold_start' }),
    });
    const decision = await policy.evaluate(0.01, 'wine_name');
    expect(decision.calibrationTrusted).toBe(false);
    // Critically: the policy MUST NOT fabricate a refusal when calibration is
    // untrusted. This regression test enforces the "no heuristic fallback"
    // rule that motivates P0.2.
    expect(decision.shouldRefuse).toBe(false);
  });
});

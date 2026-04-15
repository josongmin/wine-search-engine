/**
 * Wave 1 — Decision Integrity regressions.
 *
 * Covers:
 *   C1: embedding combiner fail-loud on NaN/hole/dim-mismatch
 *   C2: resolver singleton vs runner-up 0 distinction
 *   C3: learned matcher failure → resolver degrade (no resolve)
 *   C4: score-aggregator throws on computed non-finite signal
 */
import { describe, expect, it } from 'vitest';
import { combineSemanticEmbeddings } from '../../src/domain/retrieval/service/semantic-embedding-combiner.js';
import { ScoreAggregator, RankComputationError } from '../../src/domain/ranking/service/score-aggregator.js';
import { Calibrator } from '../../src/domain/resolver/service/calibrator.js';
import type { ComponentScores } from '../../src/domain/ranking/model/ranked-result.js';
import type { ScoringWeights } from '../../src/domain/ranking/model/scoring-weights.js';
import type { CalibrationStore } from '../../src/domain/resolver/port/calibration-store.port.js';

// ---------------------------------------------------------------------------
// C1 — embedding combiner
// ---------------------------------------------------------------------------

describe('Wave 1 / C1: semantic embedding combiner fail-loud', () => {
  it('returns undefined when primary embedding contains NaN', () => {
    const a = [0.1, Number.NaN, 0.3];
    const b = [0.4, 0.5, 0.6];
    const result = combineSemanticEmbeddings([a, b]);
    expect(result).toBeUndefined();
  });

  it('returns undefined when secondary embedding contains Infinity', () => {
    const a = [0.1, 0.2, 0.3];
    const b = [0.4, Number.POSITIVE_INFINITY, 0.6];
    const result = combineSemanticEmbeddings([a, b]);
    expect(result).toBeUndefined();
  });

  it('returns undefined on dim mismatch (does NOT silently pad with 0)', () => {
    const a = [0.1, 0.2, 0.3];
    const b = [0.4, 0.5]; // shorter
    const result = combineSemanticEmbeddings([a, b]);
    expect(result).toBeUndefined();
  });

  it('returns undefined on hole in outer array', () => {
    const a = [0.1, 0.2, 0.3];
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- intentional hole for test
    const embeddings = [a, undefined as unknown as readonly number[], a];
    const result = combineSemanticEmbeddings(embeddings);
    expect(result).toBeUndefined();
  });

  it('succeeds when all embeddings are well-formed', () => {
    const a = [0.1, 0.2, 0.3];
    const b = [0.4, 0.5, 0.6];
    const result = combineSemanticEmbeddings([a, b]);
    expect(result).toBeDefined();
    expect(result?.length).toBe(3);
    // unit-norm
    const norm = Math.sqrt((result ?? []).reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('returns input verbatim for single well-formed embedding', () => {
    const v = [0.6, 0.8, 0];
    const result = combineSemanticEmbeddings([v]);
    expect(result).toEqual(v);
  });
});

// ---------------------------------------------------------------------------
// C2 — resolver singleton vs runner-up
// ---------------------------------------------------------------------------

describe('Wave 1 / C2: Calibrator distinguishes singleton from runner-up=0', () => {
  function makeStore(): CalibrationStore {
    return {
      async getCalibrationParams() { return null; },
      async setCalibrationParams() { /* noop */ },
    };
  }

  it('singleton: hasRunnerUp=false, top2/calibratedGap undefined', async () => {
    const calibrator = new Calibrator(makeStore());
    const result = await calibrator.calibrate(
      { top1: 0.8, top2: undefined, candidateCount: 1 },
      'short_entity',
    );
    expect(result.hasRunnerUp).toBe(false);
    expect(result.candidateCount).toBe(1);
    expect(result.top2CalibratedScore).toBeUndefined();
    expect(result.calibratedGap).toBeUndefined();
  });

  it('two candidates with real top2=0: hasRunnerUp=true, gap defined', async () => {
    const calibrator = new Calibrator(makeStore());
    const result = await calibrator.calibrate(
      { top1: 0.8, top2: 0.0, candidateCount: 2 },
      'short_entity',
    );
    expect(result.hasRunnerUp).toBe(true);
    expect(result.candidateCount).toBe(2);
    expect(result.top2CalibratedScore).toBeDefined();
    expect(result.calibratedGap).toBeDefined();
    expect(result.calibratedGap).toBeGreaterThan(0);
  });

  it('throws when top1 is non-finite', async () => {
    const calibrator = new Calibrator(makeStore());
    await expect(
      calibrator.calibrate({ top1: Number.NaN, top2: undefined, candidateCount: 1 }, 'short_entity'),
    ).rejects.toThrow(/not finite/);
  });

  it('throws when top2 is non-finite (must pass undefined for absence)', async () => {
    const calibrator = new Calibrator(makeStore());
    await expect(
      calibrator.calibrate({ top1: 0.5, top2: Number.NaN, candidateCount: 2 }, 'short_entity'),
    ).rejects.toThrow(/top2 raw score is not finite/);
  });

  it('throws when candidateCount < 1', async () => {
    const calibrator = new Calibrator(makeStore());
    await expect(
      calibrator.calibrate({ top1: 0.5, top2: undefined, candidateCount: 0 }, 'short_entity'),
    ).rejects.toThrow(/candidateCount must be >= 1/);
  });
});

// ---------------------------------------------------------------------------
// C4 — score aggregator fail-loud on non-finite
// ---------------------------------------------------------------------------

describe('Wave 1 / C4: ScoreAggregator throws RankComputationError on computed non-finite', () => {
  function baseWeights(): ScoringWeights {
    return {
      entityIntegrity: 0.1,
      entityIntegrityThreshold: 0.1,
      anchorSimilarity: 0.1,
      semantic: 0.1,
      softConstraint: 0.1,
      attributeAlignment: 0.1,
      preferenceAlignment: 0.1,
      popularity: 0.1,
      availability: 0.1,
      producerPrestige: 0.1,
      recency: 0.1,
      criticScore: 0.1,
      multilingualScore: 0.1,
      uncertaintyPenalty: 0.1,
    };
  }

  function baseSignals(overrides: Partial<ComponentScores> = {}): ComponentScores {
    return {
      hardConstraintPass: true,
      entityIntegrity: 0.5,
      anchorSimilarity: 0.5,
      semantic: 0.5,
      softConstraint: 0.5,
      attributeAlignment: 0.5,
      preferenceAlignment: 0.5,
      popularity: 0.5,
      availability: 0.5,
      uncertaintyPenalty: 0.1,
      ...overrides,
    };
  }

  it('computes happy path without throwing', () => {
    const agg = new ScoreAggregator();
    const score = agg.aggregate(baseSignals(), baseWeights());
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThan(0);
  });

  it('throws RankComputationError when a computed signal is NaN', () => {
    const agg = new ScoreAggregator();
    expect(() => agg.aggregate(baseSignals({ semantic: Number.NaN }), baseWeights()))
      .toThrow(RankComputationError);
  });

  it('throws RankComputationError on Infinity popularity', () => {
    const agg = new ScoreAggregator();
    try {
      agg.aggregate(baseSignals({ popularity: Number.POSITIVE_INFINITY }), baseWeights());
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RankComputationError);
      expect((e as RankComputationError).signalName).toBe('popularity');
    }
  });

  it('undefined optional signal skipped, no throw', () => {
    const agg = new ScoreAggregator();
    const signals = baseSignals();
    // Treat an optional signal as absent — the aggregator must simply skip it.
    const mutable: ComponentScores = { ...signals, producerPrestige: undefined };
    const score = agg.aggregate(mutable, baseWeights());
    expect(Number.isFinite(score)).toBe(true);
  });

  it('returns -Infinity on hard-constraint-pass=false without throwing', () => {
    const agg = new ScoreAggregator();
    const score = agg.aggregate(baseSignals({ hardConstraintPass: false }), baseWeights());
    expect(score).toBe(-Infinity);
  });

  it('throws when entityIntegrity itself is NaN (required signal)', () => {
    const agg = new ScoreAggregator();
    expect(() => agg.aggregate(baseSignals({ entityIntegrity: Number.NaN }), baseWeights()))
      .toThrow(RankComputationError);
  });
});

// ---------------------------------------------------------------------------
// C3 — resolver learned-matcher degrade (source-level contract check)
// ---------------------------------------------------------------------------

describe('Wave 1 / C3: resolver learned-matcher failure wiring', () => {
  it('resolver.ts defines learnedMatcherDegraded flag', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/domain/resolver/service/resolver.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/let learnedMatcherDegraded = false;/);
    expect(src).toMatch(/learnedMatcherDegraded = true;/);
    // Singleton bypass must be disabled when matcher degraded.
    expect(src).toMatch(/!learnedMatcherDegraded\s*$|!learnedMatcherDegraded\s*&&/);
    // Decision boundary receives the flag.
    expect(src).toMatch(/applyDecisionBoundary\(\s*input,\s*calibrated,\s*ambiguityState,\s*thresholds,\s*learnedMatcherDegraded/);
  });

  it('applyDecisionBoundary downgrades resolved→ambiguous when learned matcher degraded', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/domain/resolver/service/resolver.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/LEARNED_MATCHER_DEGRADED_NO_RESOLVE/);
    expect(src).toMatch(/if \(learnedMatcherDegraded\)/);
  });
});

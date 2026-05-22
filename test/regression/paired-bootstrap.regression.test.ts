/**
 * SOTA++ B2 regression: paired bootstrap significance test.
 *
 * Locks the paired-bootstrap statistical contract:
 *   - Known-delta synthetic input: returned CI brackets the true delta with
 *     the expected 95% coverage rate across many trial runs.
 *   - Empty / degenerate inputs (n=0, n=1) return sane non-throwing results.
 *   - Property: scrambling the per-scenario pairings inflates CI width
 *     (paired correlation is destroyed → variance of the difference grows).
 *   - p-value is bounded by 1/(B+1) and never zero (Davison-Hinkley convention).
 *   - Headline formatter renders the canonical one-line string.
 *
 * The "1000 trials" coverage rate uses a 1000-trial Monte Carlo. With p̂=0.95
 * and n=1000 the standard error of the empirical coverage is sqrt(p(1−p)/n) ≈
 * 0.0069, so we assert coverage ∈ [0.91, 0.99] — three SE margin to keep
 * the test stable on CI without admitting a broken estimator.
 *
 * Append-only: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPairedDeltas,
  formatPairedBootstrapHeadline,
  pairedBootstrap,
  type ScenarioScorePair,
} from '../benchmark/agent/statistical-compare.js';

describe('paired bootstrap (SOTA++ B2)', () => {
  describe('shape / edge cases', () => {
    it('returns p=1 and zero CI for zero paired scenarios', () => {
      const r = pairedBootstrap([], []);
      expect(r.n).toBe(0);
      expect(r.meanDelta).toBe(0);
      expect(r.ci95).toEqual([0, 0]);
      expect(r.pValue).toBe(1);
    });

    it('returns the single delta unchanged for n=1', () => {
      const r = pairedBootstrap(
        [{ id: 1, score: 0.5 }],
        [{ id: 1, score: 0.7 }],
      );
      expect(r.n).toBe(1);
      expect(r.meanDelta).toBeCloseTo(0.2, 6);
      // Single delta collapses CI to a point — fp jitter from 0.7-0.5
      // means we compare with toBeCloseTo, not toEqual.
      expect(r.ci95[0]).toBeCloseTo(0.2, 6);
      expect(r.ci95[1]).toBeCloseTo(0.2, 6);
      expect(r.pValue).toBe(1);
    });

    it('drops scenarios present only on one side', () => {
      const baseline: ScenarioScorePair[] = [
        { id: 1, score: 0.5 },
        { id: 2, score: 0.5 },
        { id: 3, score: 0.5 },
      ];
      const current: ScenarioScorePair[] = [
        { id: 1, score: 0.6 },
        { id: 2, score: 0.6 },
        // id 3 missing in current
        { id: 4, score: 0.9 }, // id 4 missing in baseline
      ];
      const deltas = buildPairedDeltas(baseline, current);
      expect(deltas.map((d) => d.id)).toEqual([1, 2]);
    });
  });

  describe('property: scrambling pairings inflates CI width', () => {
    it('paired CI is at most the width of the scrambled-pair CI', () => {
      // Build a scenario set where baseline and current are PERFECTLY
      // correlated by id (Δ is the same for every scenario). Paired
      // bootstrap CI collapses to a point. Scrambling pairings destroys
      // the correlation, so the resampled mean varies more across draws.
      const n = 40;
      const baseline: ScenarioScorePair[] = [];
      const current: ScenarioScorePair[] = [];
      for (let i = 0; i < n; i++) {
        const base = 0.3 + 0.4 * (i / n); // 0.3..0.7
        baseline.push({ id: i, score: base });
        current.push({ id: i, score: base + 0.05 }); // constant +5pp lift
      }

      const paired = pairedBootstrap(baseline, current, { iterations: 2_000, seed: 1 });
      const pairedWidth = paired.ci95[1] - paired.ci95[0];

      // Scrambled: shuffle the `current` ids so the implicit pairing breaks.
      const scrambled: ScenarioScorePair[] = current.map((row, idx) => ({
        id: row.id,
        score: current[(idx + 7) % n]!.score,
      }));
      const scrambledPaired = pairedBootstrap(baseline, scrambled, { iterations: 2_000, seed: 1 });
      const scrambledWidth = scrambledPaired.ci95[1] - scrambledPaired.ci95[0];

      // With constant lift the paired CI is essentially zero width;
      // scrambling injects variance ⇒ wider CI.
      expect(scrambledWidth).toBeGreaterThan(pairedWidth);
    });
  });

  describe('p-value bounds (Davison-Hinkley convention)', () => {
    it('p-value never reports zero (uses (count+1)/(B+1))', () => {
      // Massive separation between baseline and current — p ought to be tiny
      // but the (count+1)/(B+1) convention floors it at 1/(B+1).
      const baseline: ScenarioScorePair[] = Array.from({ length: 30 }, (_, i) => ({
        id: i, score: 0.1,
      }));
      const current: ScenarioScorePair[] = baseline.map((b) => ({
        id: b.id, score: 0.9,
      }));
      const r = pairedBootstrap(baseline, current, { iterations: 5_000, seed: 7 });
      expect(r.pValue).toBeGreaterThan(0);
      expect(r.pValue).toBeLessThanOrEqual(1 / (5_000 + 1) + 1e-12);
    });
  });

  describe('headline formatter', () => {
    it('renders the canonical one-line string with sign + pp + n + B', () => {
      const baseline: ScenarioScorePair[] = [
        { id: 1, score: 0.5 },
        { id: 2, score: 0.6 },
        { id: 3, score: 0.7 },
      ];
      const current: ScenarioScorePair[] = [
        { id: 1, score: 0.55 },
        { id: 2, score: 0.65 },
        { id: 3, score: 0.72 },
      ];
      const r = pairedBootstrap(baseline, current, { iterations: 2_000, seed: 42 });
      const headline = formatPairedBootstrapHeadline('overall', r);
      expect(headline).toMatch(/^Δoverall = \+/);
      expect(headline).toMatch(/95% paired CI \[/);
      expect(headline).toMatch(/p=0\.\d+/);
      expect(headline).toContain('(n=3, B=2000)');
    });
  });

  describe('Monte Carlo: 95% CI captures the true mean delta ≈ 95% of trials', () => {
    // Synthetic data-generating process:
    //   For each of TRIALS trials, draw NSCEN paired score pairs where
    //   baseline_i ∈ U[0.4, 0.7] (independent across trial+i) and
    //   current_i  = baseline_i + Δ_true + ε_i with ε_i ∈ N(0, σ_eps²).
    //   Run pairedBootstrap and check whether ci95 brackets Δ_true.
    //
    //   With TRIALS=1000, p̂=0.95, SE(p̂)=√(0.95·0.05/1000) ≈ 0.0069.
    //   Assert empirical coverage ∈ [0.91, 0.99] (~3 SE margin).
    //
    // Cost: 1000 trials × 60-scenario pairedBootstrap with B=1000 → fast,
    // well under the lightweight lane budget.
    it('empirical coverage of 95% CI is between 0.91 and 0.99', () => {
      const TRIALS = 1000;
      const NSCEN = 60;
      const DELTA_TRUE = 0.04;
      const SIGMA_EPS = 0.05;

      // Deterministic seeded normal via Box-Muller.
      let mcSeed = 0x1234_5678;
      const rand = (): number => {
        mcSeed = (mcSeed * 1_664_525 + 1_013_904_223) | 0;
        return ((mcSeed >>> 0) / 4_294_967_296);
      };
      const normal = (mean: number, sd: number): number => {
        const u1 = Math.max(rand(), 1e-12);
        const u2 = rand();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        return mean + sd * z;
      };
      const uniform = (lo: number, hi: number): number => lo + (hi - lo) * rand();

      let captured = 0;
      for (let t = 0; t < TRIALS; t++) {
        const baseline: ScenarioScorePair[] = [];
        const current: ScenarioScorePair[] = [];
        for (let i = 0; i < NSCEN; i++) {
          const base = uniform(0.4, 0.7);
          const cur = base + DELTA_TRUE + normal(0, SIGMA_EPS);
          baseline.push({ id: i, score: base });
          current.push({ id: i, score: cur });
        }
        // B=1000 iterations is enough to estimate the CI percentiles; the
        // full 10_000 is reserved for the production code path.
        const r = pairedBootstrap(baseline, current, { iterations: 1_000, seed: t + 1 });
        const [lo, hi] = r.ci95;
        if (DELTA_TRUE >= lo && DELTA_TRUE <= hi) captured++;
      }
      const coverage = captured / TRIALS;
      expect(coverage).toBeGreaterThanOrEqual(0.91);
      expect(coverage).toBeLessThanOrEqual(0.99);
    });
  });
});

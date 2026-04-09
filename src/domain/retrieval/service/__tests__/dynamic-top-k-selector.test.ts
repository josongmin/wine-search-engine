import { describe, it, expect } from 'vitest';
import { selectTopK } from '../dynamic-top-k-selector.js';

describe('dynamic-top-k-selector', () => {
  it('easy difficulty with small budget → small K', () => {
    const result = selectTopK({
      difficulty: 'easy',
      latencyBudgetMs: 200,
      hasAnchor: true,
    });
    expect(result.sparseTopK).toBe(50);
    expect(result.denseTopK).toBe(20);
    expect(result.anchorTopK).toBe(10);
    expect(result.latencyBudgetMs).toBe(200);
  });

  it('hard difficulty with large budget → large K', () => {
    const result = selectTopK({
      difficulty: 'hard',
      latencyBudgetMs: 1000,
      hasAnchor: true,
    });
    expect(result.sparseTopK).toBe(500);
    expect(result.denseTopK).toBe(300);
    expect(result.anchorTopK).toBe(100);
  });

  it('!hasAnchor forces anchorTopK to 0', () => {
    const result = selectTopK({
      difficulty: 'medium',
      latencyBudgetMs: 500,
      hasAnchor: false,
    });
    expect(result.anchorTopK).toBe(0);
    // Sparse/dense unaffected.
    expect(result.sparseTopK).toBeGreaterThan(0);
    expect(result.denseTopK).toBeGreaterThan(0);
  });

  it('applies sane minimum budget and element-wise tier minimum', () => {
    // Way-under-minimum budget is clamped to MIN_LATENCY_BUDGET_MS (50).
    const low = selectTopK({
      difficulty: 'hard',
      latencyBudgetMs: 10,
      hasAnchor: true,
    });
    expect(low.latencyBudgetMs).toBe(50);
    // Hard difficulty + tiny budget collapses to easy-tier widths
    // because the effective tier is the element-wise minimum.
    expect(low.sparseTopK).toBe(50);
    expect(low.denseTopK).toBe(20);
    expect(low.anchorTopK).toBe(10);

    // Conversely: easy difficulty + huge budget stays at easy widths.
    const highEasy = selectTopK({
      difficulty: 'easy',
      latencyBudgetMs: 5000,
      hasAnchor: true,
    });
    expect(highEasy.sparseTopK).toBe(50);
    expect(highEasy.denseTopK).toBe(20);
  });

  it('fails closed on NaN/Infinity latency budget', () => {
    // Before the fix, NaN budget bypassed the tier comparisons (all
    // comparisons with NaN are false), silently routing into the HARD
    // tier — the maximum recall spend. Non-finite budgets must instead
    // collapse to the minimum coherent budget and the easy tier.
    const nanBudget = selectTopK({
      difficulty: 'hard',
      latencyBudgetMs: Number.NaN,
      hasAnchor: true,
    });
    expect(nanBudget.latencyBudgetMs).toBe(50);
    expect(nanBudget.sparseTopK).toBe(50);
    expect(nanBudget.denseTopK).toBe(20);
    expect(nanBudget.anchorTopK).toBe(10);

    const infBudget = selectTopK({
      difficulty: 'hard',
      latencyBudgetMs: Number.POSITIVE_INFINITY,
      hasAnchor: true,
    });
    expect(infBudget.latencyBudgetMs).toBe(50);
    expect(infBudget.sparseTopK).toBe(50);

    // Negative budget: already finite, still clamped at the floor.
    const negBudget = selectTopK({
      difficulty: 'medium',
      latencyBudgetMs: -100,
      hasAnchor: true,
    });
    expect(negBudget.latencyBudgetMs).toBe(50);
    expect(negBudget.sparseTopK).toBe(50);
  });
});

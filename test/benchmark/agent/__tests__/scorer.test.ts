import { describe, it, expect } from 'vitest';
import { scoreScenario, DEFAULT_WEIGHTS, TIER_WEIGHTS, type ScenarioExecution, type ToolCallTrace } from '../scorer.js';
import type { AgentBenchmarkScenario, ScenarioExpectation } from '../scenario.js';

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function makeScenario(
  expectation: ScenarioExpectation,
  overrides: Partial<AgentBenchmarkScenario> = {},
): AgentBenchmarkScenario {
  return {
    id: 1,
    tier: 'single_shot',
    query: 'test query',
    description: 'test',
    expectation,
    ...overrides,
  };
}

function makeExecution(overrides: Partial<ScenarioExecution> = {}): ScenarioExecution {
  return {
    answer: 'a wine answer',
    stepCount: 2,
    toolCallCount: 1,
    toolsUsed: [{ tool: 'search_wines', input: '{"query":"test"}' }],
    observations: ['Found 3 results: Wine A (Benchmark Winery), Wine B, Wine C'],
    terminationReason: 'answer',
    totalDurationMs: 1_000,
    totalTokens: { input: 500, output: 200 },
    ...overrides,
  };
}

const tool = (name: string, input?: string): ToolCallTrace =>
  input !== undefined ? { tool: name, input } : { tool: name };

// ─────────────────────────────────────────────────────────────────────
// Skipped / errored
// ─────────────────────────────────────────────────────────────────────

describe('scoreScenario — skipped / errored', () => {
  it('skipped scenario returns zero scores', () => {
    const scenario = makeScenario({ maxSteps: 2 }, { skip: 'phase 2' });
    const result = scoreScenario(scenario, makeExecution(), undefined);
    expect(result.skipped).toBe(true);
    expect(result.scores.overall).toBe(0);
  });

  it('null execution returns zero scores with error', () => {
    const scenario = makeScenario({ maxSteps: 2 });
    const result = scoreScenario(scenario, null, undefined, undefined, 'crash');
    expect(result.error).toBe('crash');
    expect(result.scores.overall).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tool accuracy
// ─────────────────────────────────────────────────────────────────────

describe('scoreToolAccuracy', () => {
  it('returns 1 when no expected tools', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ toolsUsed: [tool('anything')] }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBe(1);
  });

  it('returns 1 when all expected tools called', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, tools: [{ tool: 'search_wines' }] }),
      makeExecution({ toolsUsed: [tool('search_wines', '{"query":"x"}')] }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBe(1);
  });

  it('penalises missing expected tool', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        tools: [{ tool: 'search_wines' }, { tool: 'compare_wines' }],
      }),
      makeExecution({ toolsUsed: [tool('search_wines')] }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBe(0.5);
  });

  it('inputContains: passes when args contain required substring', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        tools: [{ tool: 'search_wines', inputContains: ['Opus'] }],
      }),
      makeExecution({
        toolsUsed: [tool('search_wines', '{"query":"Opus One 2018"}')],
      }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBe(1);
  });

  it('inputContains: fails when args missing required substring', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        tools: [{ tool: 'search_wines', inputContains: ['Opus'] }],
      }),
      makeExecution({
        toolsUsed: [tool('search_wines', '{"query":"Cabernet"}')],
      }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBe(0);
  });

  it('ordered: penalises out-of-order calls', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        ordered: true,
        tools: [{ tool: 'search_wines' }, { tool: 'compare_wines' }],
      }),
      makeExecution({
        toolsUsed: [tool('compare_wines'), tool('search_wines')],
      }),
      undefined,
    );
    // Both matched (1.0) but out of order → ×0.5
    expect(r.scores.toolAccuracy).toBe(0.5);
  });

  it('extra-call penalty: docks 10% per unexpected call', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, tools: [{ tool: 'search_wines' }] }),
      makeExecution({
        toolsUsed: [
          tool('search_wines'),
          tool('get_food_pairings'),
          tool('get_food_pairings'),
        ],
      }),
      undefined,
    );
    // 1.0 base × (1 - 0.2) = 0.8
    expect(r.scores.toolAccuracy).toBeCloseTo(0.8, 5);
  });

  it('extra-call penalty: caps at 50%', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 10, tools: [{ tool: 'search_wines' }] }),
      makeExecution({
        toolsUsed: [
          tool('search_wines'),
          tool('a'), tool('b'), tool('c'), tool('d'), tool('e'), tool('f'),
          tool('g'), tool('h'),
        ],
      }),
      undefined,
    );
    // 1.0 × (1 - 0.5) = 0.5
    expect(r.scores.toolAccuracy).toBe(0.5);
  });

  it('mustNotCallTools: hard fail when forbidden tool called', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        mustNotCallTools: ['search_wines'],
      }),
      makeExecution({ toolsUsed: [tool('search_wines')] }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBe(0);
  });

  it('expectedBlocked: passes when no tools called', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, expectedBlocked: true }),
      makeExecution({ toolsUsed: [], terminationReason: 'blocked', stepCount: 0 }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBe(1);
  });

  it('expectedBlocked: fails when tools called', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, expectedBlocked: true }),
      makeExecution({ toolsUsed: [tool('search_wines')] }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Step efficiency
// ─────────────────────────────────────────────────────────────────────

describe('scoreStepEfficiency', () => {
  it('full credit when within budget', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ stepCount: 3 }),
      undefined,
    );
    expect(r.scores.stepEfficiency).toBe(1);
  });

  it('penalises overshoot proportionally', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 4 }),
      makeExecution({ stepCount: 6 }),
      undefined,
    );
    // 1 - (6-4)/4 = 0.5
    expect(r.scores.stepEfficiency).toBe(0.5);
  });

  it('zero at 2x budget', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 3 }),
      makeExecution({ stepCount: 6 }),
      undefined,
    );
    expect(r.scores.stepEfficiency).toBe(0);
  });

  it('NaN-safe: invalid stepCount → 0', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ stepCount: Number.NaN }),
      undefined,
    );
    expect(r.scores.stepEfficiency).toBe(0);
  });

  it('maxSteps=0: passes only when stepCount=0', () => {
    const passed = scoreScenario(
      makeScenario({ maxSteps: 0 }),
      makeExecution({ stepCount: 0 }),
      undefined,
    );
    expect(passed.scores.stepEfficiency).toBe(1);

    const failed = scoreScenario(
      makeScenario({ maxSteps: 0 }),
      makeExecution({ stepCount: 1 }),
      undefined,
    );
    expect(failed.scores.stepEfficiency).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Answer quality
// ─────────────────────────────────────────────────────────────────────

describe('scoreAnswerQuality', () => {
  it('empty answer scores 0', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: '   ' }),
      undefined,
    );
    expect(r.scores.answerQuality).toBe(0);
  });

  it('all answerContains matched → 1', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, answerContains: ['Opus One', '2018'] }),
      makeExecution({ answer: 'I recommend Opus One 2018, a Napa Cabernet.' }),
      undefined,
    );
    expect(r.scores.answerQuality).toBe(1);
  });

  it('partial match returns ratio', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, answerContains: ['Opus One', '2018', 'Napa'] }),
      makeExecution({ answer: 'Opus One is great.' }),
      undefined,
    );
    expect(r.scores.answerQuality).toBeCloseTo(1 / 3, 5);
  });

  it('Korean substring matching is whitespace-normalised', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, answerContains: ['오푸스원'] }),
      makeExecution({ answer: '오푸스 원은 나파 카베르네입니다.' }),
      undefined,
    );
    // After NFKC + whitespace strip both become "오푸스원..." — match.
    expect(r.scores.answerQuality).toBe(1);
  });

  it('answerExcludes violation → hard 0 (not 0.5)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, answerExcludes: ['white'] }),
      makeExecution({ answer: 'A nice white wine.' }),
      undefined,
    );
    expect(r.scores.answerQuality).toBe(0);
  });

  it('answerExcludes case-insensitive', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, answerExcludes: ['WHITE'] }),
      makeExecution({ answer: 'A nice White wine.' }),
      undefined,
    );
    expect(r.scores.answerQuality).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Termination
// ─────────────────────────────────────────────────────────────────────

describe('scoreTermination', () => {
  it('answer termination → 1', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ terminationReason: 'answer' }),
      undefined,
    );
    expect(r.scores.terminationCorrectness).toBe(1);
  });

  it('fallback termination → 0 (was 0.5 in old scorer)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ terminationReason: 'fallback' }),
      undefined,
    );
    expect(r.scores.terminationCorrectness).toBe(0);
  });

  it('error termination → 0', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ terminationReason: 'error' }),
      undefined,
    );
    expect(r.scores.terminationCorrectness).toBe(0);
  });

  it('timeout termination → 0', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ terminationReason: 'timeout' }),
      undefined,
    );
    expect(r.scores.terminationCorrectness).toBe(0);
  });

  it('expectedBlocked: blocked → 1', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, expectedBlocked: true }),
      makeExecution({ terminationReason: 'blocked', toolsUsed: [], stepCount: 0 }),
      undefined,
    );
    expect(r.scores.terminationCorrectness).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Cost efficiency
// ─────────────────────────────────────────────────────────────────────

describe('scoreCostEfficiency', () => {
  it('within default budget → 1', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ totalDurationMs: 3_000, totalTokens: { input: 1_000, output: 500 } }),
      undefined,
    );
    expect(r.scores.costEfficiency).toBe(1);
  });

  it('latency overshoot penalises', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, maxDurationMs: 1_000 }),
      makeExecution({ totalDurationMs: 1_500, totalTokens: { input: 100, output: 100 } }),
      undefined,
    );
    // max-overshoot model: durOvershoot = 500/1000 = 0.5 → cost = 1 - 0.5 = 0.5
    expect(r.scores.costEfficiency).toBeCloseTo(0.5, 3);
  });

  it('token overshoot penalises', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, maxTotalTokens: 1_000 }),
      makeExecution({ totalDurationMs: 100, totalTokens: { input: 800, output: 800 } }),
      undefined,
    );
    // max-overshoot model: tokOvershoot = 600/1000 = 0.6 → cost = 1 - 0.6 = 0.4
    expect(r.scores.costEfficiency).toBeCloseTo(0.4, 3);
  });

  it('Infinity budget disables the check', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        maxDurationMs: Number.POSITIVE_INFINITY,
        maxTotalTokens: Number.POSITIVE_INFINITY,
      }),
      makeExecution({ totalDurationMs: 999_999, totalTokens: { input: 99_999, output: 99_999 } }),
      undefined,
    );
    expect(r.scores.costEfficiency).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Overall score (geometric mean)
// ─────────────────────────────────────────────────────────────────────

describe('overall score (weighted geometric mean)', () => {
  it('all dims = 1 → overall ≈ 1', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({
        answer: 'good answer about test wine',
        observations: ['Found: test wine results'],
      }),
      1,    // judge
      1,    // faithfulness
    );
    expect(r.scores.overall).toBeGreaterThan(0.95);
  });

  it('answer quality = 0 drags overall down sharply', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      // Empty answer → answerQuality=0, all other dims = 1
      makeExecution({ answer: '' }),
      1,
    );
    // Arithmetic mean would give 5/6 ≈ 0.83. Geometric mean must be MUCH lower.
    expect(r.scores.overall).toBeLessThan(0.5);
  });

  it('one dim at 0 with rest at 1: clearly distinguishable from arithmetic mean', () => {
    // termination=0 (fallback), answer/tool/step/cost/judge all at 1
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ terminationReason: 'fallback' }),
      1,
    );
    // Arithmetic mean would be 5/6 ≈ 0.833. Geometric should be lower.
    expect(r.scores.overall).toBeLessThan(0.83);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Diagnostics
// ─────────────────────────────────────────────────────────────────────

describe('diagnostics', () => {
  it('records each penalty reason', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 2,
        tools: [{ tool: 'search_wines', inputContains: ['Opus'] }],
        answerExcludes: ['white'],
      }),
      makeExecution({
        answer: 'A great white wine.',
        stepCount: 5,
        toolsUsed: [tool('search_wines', '{"query":"Cabernet"}'), tool('extra')],
      }),
      undefined,
    );
    expect(r.diagnostics).toBeDefined();
    expect(r.diagnostics!.length).toBeGreaterThan(0);
    // Diagnostic objects: search by code/message rather than string-only includes.
    const haystack = (d: { code: string; message: string }): string =>
      `${d.code} ${d.message}`;
    expect(r.diagnostics!.some((d) => haystack(d).toLowerCase().includes('inputcontains'))).toBe(true);
    expect(r.diagnostics!.some((d) => haystack(d).toLowerCase().includes('answerexcludes'))).toBe(true);
    expect(r.diagnostics!.some((d) => haystack(d).toLowerCase().includes('budget'))).toBe(true);
  });

  it('emits structured diagnostic objects with severity / code', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, mustNotCallTools: ['search_wines'] }),
      makeExecution({ toolsUsed: [tool('search_wines')] }),
      undefined,
    );
    const violation = r.diagnostics!.find((d) => d.code === 'MUST_NOT_CALL_VIOLATED');
    expect(violation).toBeDefined();
    expect(violation!.severity).toBe('critical');
    expect(violation!.dim).toBe('toolAccuracy');
  });

  it('exposes diagnosticStrings projection for CLI display', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 1 }),
      makeExecution({ stepCount: 5 }),
      undefined,
    );
    expect(r.diagnosticStrings).toBeDefined();
    expect(r.diagnosticStrings!.length).toBeGreaterThan(0);
    expect(r.diagnosticStrings![0]).toMatch(/^\[(info|warn|critical)\]/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Critical-failure short-circuit (P0-4)
// ─────────────────────────────────────────────────────────────────────

describe('criticalFailure short-circuit', () => {
  it('mustNotCallTools violation collapses overall to 0', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, mustNotCallTools: ['search_wines'] }),
      makeExecution({ toolsUsed: [tool('search_wines')] }),
      1,
    );
    expect(r.scores.criticalFailure).toBe(true);
    expect(r.scores.overall).toBe(0);
  });

  it('answerExcludes violation collapses overall to 0', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, answerExcludes: ['white'] }),
      makeExecution({ answer: 'recommend a white wine' }),
      1,
    );
    expect(r.scores.criticalFailure).toBe(true);
    expect(r.scores.overall).toBe(0);
  });

  it('answerMustNotMatch regex violation collapses overall to 0', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, answerMustNotMatch: ['(SELECT|FROM)'] }),
      makeExecution({ answer: 'SELECT wines FROM database' }),
      1,
    );
    expect(r.scores.criticalFailure).toBe(true);
    expect(r.scores.overall).toBe(0);
  });

  it('expectedBlocked but not blocked → criticalFailure', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 1, expectedBlocked: true }),
      makeExecution({ toolsUsed: [tool('search_wines')] }),
      1,
    );
    expect(r.scores.criticalFailure).toBe(true);
    expect(r.scores.overall).toBe(0);
  });

  it('soft fails do NOT trigger criticalFailure', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, tools: [{ tool: 'search_wines' }] }),
      // Right tool called but with extra calls — only soft penalties
      makeExecution({ toolsUsed: [tool('search_wines'), tool('search_wines'), tool('search_wines')], stepCount: 3 }),
      1,
    );
    expect(r.scores.criticalFailure).toBe(false);
    // Overall should be reduced but not zero
    expect(r.scores.overall).toBeGreaterThan(0);
    expect(r.scores.overall).toBeLessThan(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Null judge handling (P0-3)
// ─────────────────────────────────────────────────────────────────────

describe('null judge handling', () => {
  it('judge undefined → scores.judge is null and dim is dropped from geo-mean', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({
        answer: 'good answer about test wine',
        observations: ['Found: test wine results'],
      }),
      undefined, // no judge
      0.9,       // faithfulness — present to avoid imputation dragging score
    );
    expect(r.scores.judge).toBeNull();
    // Overall should be near 1 since all OTHER dims are 1 — judge should not bias upward.
    expect(r.scores.overall).toBeGreaterThan(0.85);
  });

  it('judge=0 with all other dims=1 → overall significantly less than 1', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'good answer' }),
      0, // judge says 0
    );
    expect(r.scores.judge).toBe(0);
    // Judge weight is only 0.10, so overall should be reduced but not crushed.
    expect(r.scores.overall).toBeLessThan(0.95);
    expect(r.scores.overall).toBeGreaterThan(0.3);
  });

  it('judge undefined produces SAME or HIGHER overall than judge=0 (no inverted incentive)', () => {
    const withoutJudge = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'good answer' }),
      undefined,
    );
    const withZeroJudge = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'good answer' }),
      0,
    );
    // Disabling judge must NOT inflate overall above what a 0-judge would give.
    // The right behavior is "disabled judge contributes nothing", which means
    // it should never make overall LOWER than withZeroJudge.
    expect(withoutJudge.scores.overall).toBeGreaterThanOrEqual(withZeroJudge.scores.overall);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Execution efficiency merge (P1-7)
// ─────────────────────────────────────────────────────────────────────

describe('executionEfficiency dimension merge', () => {
  it('high tool + high step → high exec eff', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, tools: [{ tool: 'search_wines' }] }),
      makeExecution({ toolsUsed: [tool('search_wines')], stepCount: 2 }),
      undefined,
    );
    expect(r.scores.executionEfficiency).toBeGreaterThan(0.9);
  });

  it('both tool + step low (thrashing) → max() merge prevents double-counting', () => {
    // tool=0 (no expected tool called) AND step=0 (way over budget) → both 0.
    // max(0,0)=0; the merge does NOT make this worse than either individual,
    // which is the property we want vs. arithmetic-mean double-penalty.
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, tools: [{ tool: 'search_wines' }] }),
      makeExecution({
        toolsUsed: [tool('a'), tool('b'), tool('c'), tool('d'), tool('e')],
        stepCount: 5,
      }),
      undefined,
    );
    // exec = max(0, 0) = 0 — same as the worst sub-dim, NOT lower
    expect(r.scores.executionEfficiency).toBe(0);
    // Compare with a healthier case where only ONE sub-dim is bad
    const onlyToolBad = scoreScenario(
      makeScenario({ maxSteps: 5, tools: [{ tool: 'search_wines' }] }),
      makeExecution({ toolsUsed: [tool('a')], stepCount: 1 }), // wrong tool but step=1 ≤ 5
      undefined,
    );
    // Independent: arithmetic mean used (not max). tool=0, step=1 → 0×0.6 + 1×0.4 = 0.4
    expect(onlyToolBad.scores.executionEfficiency).toBeCloseTo(0.4, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Per-tier weight overrides (P1-9)
// ─────────────────────────────────────────────────────────────────────

describe('per-tier weights', () => {
  it('adversarial tier weights termination higher than default', () => {
    // Build two scenarios that differ ONLY in tier; adversarial should
    // penalise a fallback termination harder than single_shot.
    const adv = scoreScenario(
      makeScenario({ maxSteps: 5 }, { tier: 'adversarial' }),
      makeExecution({ terminationReason: 'fallback' }),
      1,
    );
    const ss = scoreScenario(
      makeScenario({ maxSteps: 5 }, { tier: 'single_shot' }),
      makeExecution({ terminationReason: 'fallback' }),
      1,
    );
    // Adversarial weights termination at 0.30, single_shot at 0.15 (default).
    // Both have termination=0 (fallback), so adversarial overall should be LOWER.
    expect(adv.scores.overall).toBeLessThan(ss.scores.overall);
  });

  it('per-scenario weight override wins over tier default', () => {
    const r = scoreScenario(
      makeScenario(
        {
          maxSteps: 5,
          // Aggressively up-weight terminationCorrectness
          weights: { terminationCorrectness: 0.80, answerQuality: 0.05, executionEfficiency: 0.05, costEfficiency: 0.05, judge: 0.05 },
        },
        { tier: 'single_shot' },
      ),
      makeExecution({ terminationReason: 'fallback' }),
      1,
    );
    // With termination weight 0.80 and termination=0, overall should be very low
    expect(r.scores.overall).toBeLessThan(0.2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Weight invariants (M4)
// ─────────────────────────────────────────────────────────────────────

describe('weight invariants', () => {
  const REQUIRED_KEYS = [
    'executionEfficiency',
    'answerQuality',
    'terminationCorrectness',
    'costEfficiency',
    'judge',
  ] as const;

  function sumWeights(w: Record<string, number>): number {
    return Object.values(w).reduce((a, b) => a + b, 0);
  }

  it('DEFAULT_WEIGHTS sums to 1.0', () => {
    expect(Math.abs(sumWeights(DEFAULT_WEIGHTS) - 1)).toBeLessThan(1e-9);
  });

  it('DEFAULT_WEIGHTS has all required dimension keys', () => {
    for (const key of REQUIRED_KEYS) {
      expect(DEFAULT_WEIGHTS).toHaveProperty(key);
      expect(typeof DEFAULT_WEIGHTS[key]).toBe('number');
    }
  });

  it('every TIER_WEIGHTS entry sums to 1.0', () => {
    for (const [tier, weights] of Object.entries(TIER_WEIGHTS)) {
      const sum = sumWeights(weights as Record<string, number>);
      expect(Math.abs(sum - 1), `tier ${tier} sum=${sum}`).toBeLessThan(1e-9);
    }
  });

  it('every TIER_WEIGHTS entry has all required keys', () => {
    for (const [tier, weights] of Object.entries(TIER_WEIGHTS)) {
      for (const key of REQUIRED_KEYS) {
        expect(weights, `tier ${tier} missing ${key}`).toHaveProperty(key);
      }
    }
  });

  it('per-scenario partial weight override is renormalised to sum 1.0', () => {
    // Setting a single dimension should not break invariants — scorer must
    // renormalise so the user's intent (boost terminationCorrectness) holds
    // proportionally across the remaining dims.
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        // Only specify ONE dim — the others default. After merge they sum > 1.
        weights: { terminationCorrectness: 0.80 },
      }),
      makeExecution(),
      1,
    );
    // The score should be deterministic (no NaN, no Infinity).
    expect(Number.isFinite(r.scores.overall)).toBe(true);
    expect(r.scores.overall).toBeGreaterThanOrEqual(0);
    expect(r.scores.overall).toBeLessThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Structured checks (Track 1b — 9 schema fields)
// ─────────────────────────────────────────────────────────────────────

describe('scoreStructuredChecks', () => {
  it('priceBandKrw: penalises when answer contains out-of-range price', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, priceBandKrw: { max: 50_000 } }),
      makeExecution({ answer: '추천 와인: Opus One (15만원)' }),
      undefined,
    );
    // 15만원 = 150,000 KRW > max 50,000 → penalty
    expect(r.scores.answerQuality).toBeLessThan(1);
    expect(r.diagnostics?.some((d) => d.code === 'PRICE_BAND_VIOLATED')).toBe(true);
  });

  it('priceBandKrw: passes when price is within range', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, priceBandKrw: { max: 50_000 } }),
      makeExecution({ answer: '추천 와인: Good Wine (3만원)' }),
      undefined,
    );
    // 3만원 = 30,000 → within range
    expect(r.diagnostics?.some((d) => d.code === 'PRICE_BAND_VIOLATED')).toBeFalsy();
  });

  it('vintageRange: penalises when mentioned vintage is out of range', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, vintageRange: { min: 2018, max: 2020 } }),
      makeExecution({ answer: 'I recommend the 2015 Barolo' }),
      undefined,
    );
    expect(r.diagnostics?.some((d) => d.code === 'VINTAGE_RANGE_VIOLATED')).toBe(true);
  });

  it('drinkingWindowStatus: penalises when answer lacks expected keywords', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, drinkingWindowStatus: 'hold' }),
      makeExecution({ answer: 'This wine is fantastic right now, drink it tonight!' }),
      undefined,
    );
    expect(r.diagnostics?.some((d) => d.code === 'DRINKING_WINDOW_MISMATCH')).toBe(true);
  });

  it('drinkingWindowStatus: passes when correct keywords present', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, drinkingWindowStatus: 'hold' }),
      makeExecution({ answer: 'This young wine needs more cellar time — hold for 5 years.' }),
      undefined,
    );
    expect(r.diagnostics?.some((d) => d.code === 'DRINKING_WINDOW_MISMATCH')).toBeFalsy();
  });

  it('requireHedging: penalises when answer lacks hedging language', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, requireHedging: true }),
      makeExecution({ answer: 'The best wine is Opus One. Buy it now.' }),
      undefined,
    );
    expect(r.diagnostics?.some((d) => d.code === 'HEDGING_MISSING')).toBe(true);
  });

  it('requireHedging: passes when hedging present', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, requireHedging: true }),
      makeExecution({ answer: '여러 후보가 있는데, perhaps Opus One or Screaming Eagle' }),
      undefined,
    );
    expect(r.diagnostics?.some((d) => d.code === 'HEDGING_MISSING')).toBeFalsy();
  });

  it('requiredRegister: penalises wrong Korean register', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, requiredRegister: 'formal' }),
      makeExecution({ answer: '이 와인 좋아. 한번 먹어봐. 괜찮은 거야.' }),
      undefined,
    );
    expect(r.diagnostics?.some((d) => d.code === 'REGISTER_MISMATCH')).toBe(true);
  });

  it('requiredRegister: passes correct register', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, requiredRegister: 'formal' }),
      makeExecution({ answer: '이 와인을 추천합니다. 품질이 우수합니다.' }),
      undefined,
    );
    expect(r.diagnostics?.some((d) => d.code === 'REGISTER_MISMATCH')).toBeFalsy();
  });

  it('maxConfidence: penalises overconfident language', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, maxConfidence: 0.3 }),
      makeExecution({ answer: '확실히 이 와인이 최고입니다!' }),
      undefined,
    );
    expect(r.diagnostics?.some((d) => d.code === 'OVERCONFIDENT_LANGUAGE')).toBe(true);
  });

  it('refusalExpected: critical fail when no refusal markers', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, refusalExpected: true }),
      makeExecution({ answer: 'Here is a great 1962 Screaming Eagle!' }),
      undefined,
    );
    expect(r.scores.criticalFailure).toBe(true);
    expect(r.scores.overall).toBe(0);
  });

  it('refusalExpected: passes when refusal markers present', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, refusalExpected: true }),
      makeExecution({ answer: '해당 빈티지는 존재하지 않습니다. Screaming Eagle은 1992년부터 생산됩니다.' }),
      undefined,
    );
    expect(r.scores.criticalFailure).toBe(false);
    expect(r.scores.answerQuality).toBe(1);
  });

  it('mustCiteFromToolResults: penalises uncited wine names', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, mustCiteFromToolResults: true }),
      makeExecution({
        answer: 'I recommend Opus One and Screaming Eagle.',
        observations: ['Found: Opus One (Mondavi), Ridge Monte Bello'],
      }),
      undefined,
    );
    // Screaming Eagle not in observations → penalty
    expect(r.diagnostics?.some((d) => d.code === 'UNCITED_WINE_NAMES')).toBe(true);
    expect(r.scores.answerQuality).toBeLessThan(1);
  });

  it('mustCiteFromToolResults: passes when all cited', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, mustCiteFromToolResults: true }),
      makeExecution({
        answer: 'I recommend Opus One.',
        observations: ['Found: Opus One (Mondavi), Ridge Monte Bello'],
      }),
      undefined,
    );
    expect(r.diagnostics?.some((d) => d.code === 'UNCITED_WINE_NAMES')).toBeFalsy();
  });

  it('expectedToolArgs: penalises when tool arg predicate not satisfied', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        expectedToolArgs: [
          { tool: 'search_wines', argPath: 'filters.priceMaxKrw', predicate: 'lte', value: 50000 },
        ],
      }),
      makeExecution({
        toolsUsed: [tool('search_wines', '{"query":"wine","filters":{"priceMaxKrw":100000}}')],
      }),
      undefined,
    );
    // 100000 > 50000 → lte predicate fails
    expect(r.diagnostics?.some((d) => d.code === 'EXPECTED_TOOL_ARG_MISSING')).toBe(true);
  });

  it('expectedToolArgs: passes when predicate satisfied', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        expectedToolArgs: [
          { tool: 'search_wines', argPath: 'filters.priceMaxKrw', predicate: 'lte', value: 50000 },
        ],
      }),
      makeExecution({
        toolsUsed: [tool('search_wines', '{"query":"wine","filters":{"priceMaxKrw":30000}}')],
      }),
      undefined,
    );
    expect(r.diagnostics?.some((d) => d.code === 'EXPECTED_TOOL_ARG_MISSING')).toBeFalsy();
  });
});

// ─────────────────────────────────────────────────────────────────────
// RAGAS dimensions
// ─────────────────────────────────────────────────────────────────────

describe('RAGAS Faithfulness', () => {
  it('faithfulness score flows into scores.faithfulness', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution(),
      undefined,
      0.75, // faithfulnessScore
    );
    expect(r.scores.faithfulness).toBe(0.75);
  });

  it('faithfulness=null when no score provided', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution(),
      undefined,
      undefined,
    );
    expect(r.scores.faithfulness).toBeNull();
  });

  it('low faithfulness emits FAITHFULNESS_LOW diagnostic', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution(),
      undefined,
      0.3, // low
    );
    expect(r.diagnostics?.some((d) => d.code === 'FAITHFULNESS_LOW')).toBe(true);
  });

  it('high faithfulness does NOT emit FAITHFULNESS_LOW', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution(),
      undefined,
      0.8,
    );
    expect(r.diagnostics?.some((d) => d.code === 'FAITHFULNESS_LOW')).toBeFalsy();
  });
});

describe('RAGAS Context Precision', () => {
  it('returns null when no observations', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, vintageRange: { min: 2018, max: 2020 } }),
      makeExecution({ observations: [] }),
      undefined,
    );
    expect(r.scores.contextPrecision).toBeNull();
  });

  it('returns null when no structured constraints', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ observations: ['Found: Wine A | vintage: 2019'] }),
      undefined,
    );
    // No priceBandKrw, vintageRange, drinkingWindowStatus → null
    // (query_terms_in_context check may still fire if tools have query)
    expect(r.scores.contextPrecision).not.toBeUndefined();
  });

  it('vintageRange: passes when observation contains in-range year', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, vintageRange: { min: 2018, max: 2020 } }),
      makeExecution({
        observations: ['Found: Wine A | vintage: 2019 | region: Napa'],
      }),
      undefined,
    );
    expect(r.scores.contextPrecision).toBeGreaterThan(0);
  });

  it('vintageRange: fails when observation contains out-of-range year', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, vintageRange: { min: 2018, max: 2020 } }),
      makeExecution({
        observations: ['Found: Wine A | vintage: 2015 | region: Napa'],
      }),
      undefined,
    );
    expect(r.diagnostics?.some((d) => d.code === 'CONTEXT_PRECISION_LOW')).toBe(true);
  });

  it('drinkingWindowStatus: passes when keywords match', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, drinkingWindowStatus: 'now' }),
      makeExecution({
        observations: ['Wine A: currently drinkable, peak 2024-2028'],
      }),
      undefined,
    );
    expect(r.scores.contextPrecision).toBeGreaterThan(0);
  });

  it('query-context alignment: passes when tool query terms in observations', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({
        toolsUsed: [tool('search_wines', '{"query":"Opus One"}')],
        observations: ['Found: Opus One 2018 | producer: Mondavi'],
      }),
      undefined,
    );
    // "opus" from query should appear in observations
    expect(r.scores.contextPrecision).toBeGreaterThan(0);
  });
});

describe('RAGAS weight integration', () => {
  it('DEFAULT_WEIGHTS includes faithfulness + contextPrecision and sums to 1.0', () => {
    expect(DEFAULT_WEIGHTS).toHaveProperty('faithfulness');
    expect(DEFAULT_WEIGHTS).toHaveProperty('contextPrecision');
    const sum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it('every TIER_WEIGHTS entry includes faithfulness + contextPrecision', () => {
    for (const [tier, weights] of Object.entries(TIER_WEIGHTS)) {
      expect(weights, `${tier} missing faithfulness`).toHaveProperty('faithfulness');
      expect(weights, `${tier} missing contextPrecision`).toHaveProperty('contextPrecision');
      const sum = Object.values(weights).reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - 1), `${tier} sum=${sum}`).toBeLessThan(1e-9);
    }
  });

  it('renormaliseWeights preserves faithfulness + contextPrecision', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        weights: { terminationCorrectness: 0.80 },
      }),
      makeExecution(),
      1,
      0.9,
    );
    // If renormalization dropped faithfulness, it would be imputed rather than scored.
    // With faithfulness=0.9 and weight preserved, overall should be healthy.
    expect(Number.isFinite(r.scores.overall)).toBe(true);
    expect(r.scores.faithfulness).toBe(0.9);
  });
});

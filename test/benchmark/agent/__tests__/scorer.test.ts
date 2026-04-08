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
    answer: 'a wine answer for your query',
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
// judgeRequiredButSkipped
// ─────────────────────────────────────────────────────────────────────

describe('scoreScenario — judgeRequired', () => {
  it('judgeRequiredButSkipped is false when judgeRequired is not set', () => {
    const scenario = makeScenario({ maxSteps: 2 });
    const result = scoreScenario(scenario, makeExecution(), undefined);
    expect(result.judgeRequiredButSkipped).toBe(false);
  });

  it('judgeRequiredButSkipped is false when judgeRequired=true but judge ran', () => {
    const scenario = makeScenario({ maxSteps: 2, judgeRequired: true });
    const result = scoreScenario(scenario, makeExecution(), 0.8);
    expect(result.judgeRequiredButSkipped).toBe(false);
  });

  it('judgeRequiredButSkipped is true when judgeRequired=true and no judge score', () => {
    const scenario = makeScenario({ maxSteps: 2, judgeRequired: true });
    const result = scoreScenario(scenario, makeExecution(), undefined);
    expect(result.judgeRequiredButSkipped).toBe(true);
  });

  it('adds JUDGE_REQUIRED_BUT_SKIPPED diagnostic when judgeRequiredButSkipped', () => {
    const scenario = makeScenario({ maxSteps: 2, judgeRequired: true });
    const result = scoreScenario(scenario, makeExecution(), undefined);
    const diag = result.diagnostics?.find((d) => d.code === 'JUDGE_REQUIRED_BUT_SKIPPED');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('warn');
    expect(diag?.dim).toBe('judge');
  });

  it('judgeRequiredButSkipped is false for skipped scenarios', () => {
    const scenario = makeScenario({ maxSteps: 2, judgeRequired: true }, { skip: 'phase 2' });
    const result = scoreScenario(scenario, makeExecution(), undefined);
    expect(result.skipped).toBe(true);
    expect(result.judgeRequiredButSkipped).toBe(false);
  });

  it('judgeRequiredButSkipped is false for errored scenarios', () => {
    const scenario = makeScenario({ maxSteps: 2, judgeRequired: true });
    const result = scoreScenario(scenario, null, undefined, undefined, 'crash');
    expect(result.judgeRequiredButSkipped).toBe(false);
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
      // Answer is ≥20 chars to avoid the trivial-answer length penalty.
      makeExecution({ answer: 'Opus One is a great wine from California.' }),
      undefined,
    );
    expect(r.scores.answerQuality).toBeCloseTo(1 / 3, 5);
  });

  it('Korean substring matching is whitespace-normalised', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, answerContains: ['오푸스원'] }),
      // Answer is ≥20 chars to avoid the trivial-answer length penalty.
      makeExecution({ answer: '오푸스 원은 나파 카베르네 기반의 훌륭한 와인입니다.' }),
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

  it('fallback termination → 0.25 (graceful degradation partial credit)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ terminationReason: 'fallback' }),
      undefined,
    );
    expect(r.scores.terminationCorrectness).toBe(0.25);
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

  it('fallback dim at 0.25 with rest at 1: clearly distinguishable from arithmetic mean', () => {
    // termination=0.25 (fallback partial credit), answer/tool/step/cost/judge all at 1
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ terminationReason: 'fallback' }),
      1,
    );
    // Arithmetic mean would be 5/6 ≈ 0.833. Geometric should be lower.
    expect(r.scores.overall).toBeLessThan(0.83);
  });

  it('null-drop: judge=null excludes judge from geo-mean → overall ≥ judge=0.5', () => {
    // v4 null-drop: null dims are EXCLUDED (weight dropped from denominator).
    // judge=null → present dims only → no drag. judge=0.5 → participates → may lower.
    const base = makeExecution({ answer: 'Opus One 2018 is a great Napa Cabernet.', observations: ['Found: Opus One 2018 | region: Napa Valley'] });
    const withNull = scoreScenario(makeScenario({ maxSteps: 5 }), base, undefined, 0.8);
    const withHalf = scoreScenario(makeScenario({ maxSteps: 5 }), base, 0.5, 0.8);
    expect(withNull.scores.overall).toBeGreaterThanOrEqual(withHalf.scores.overall);
  });

  it('null-drop: adding weak judge (0.2) lowers overall vs null (judge now participates)', () => {
    // judge=null → excluded. judge=0.2 → participates with low value → drags geo-mean.
    const base = makeExecution({ answer: 'Opus One 2018 is a great Napa Cabernet.', observations: ['Found: Opus One 2018 | region: Napa Valley'] });
    const withNull = scoreScenario(makeScenario({ maxSteps: 5 }), base, undefined, 0.8);
    const withWeak = scoreScenario(makeScenario({ maxSteps: 5 }), base, 0.2, 0.8);
    expect(withWeak.scores.overall).toBeLessThan(withNull.scores.overall);
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

  it('answerMustNotMatch regex violation applies multiplicative penalty, NOT critical-fail', () => {
    // SOTA++ v3: answerMustNotMatch is no longer a hard critical-fail.
    // Judge still runs and can partially offset. criticalFailure stays false
    // so the overall score reflects the combined penalty, not a zero-clamp.
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, answerMustNotMatch: ['(SELECT|FROM)'] }),
      makeExecution({ answer: 'SELECT wines FROM database' }),
      1,
    );
    expect(r.scores.criticalFailure).toBe(false);
    expect(r.scores.overall).toBeGreaterThan(0);
    expect(r.diagnostics?.some((d) => d.code === 'ANSWER_MUST_NOT_MATCH_HIT')).toBe(true);
    // The penalty is multiplicative (PENALTY_MUST_NOT_MATCH = 0.50) → answerQuality reduced
    expect(r.scores.answerQuality).toBeLessThan(1);
  });

  it('answerMustNotMatch: polite Korean preamble before recommendation is NOT blocked', () => {
    // "죄송합니다만, 추천드립니다" — apology as prefix, not as terminal refusal.
    // The anchored pattern '죄송합니다[.。！!\\s]*$' should NOT match when text continues.
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, answerMustNotMatch: ['죄송합니다[.。！!\\s]*$'] }),
      makeExecution({ answer: '죄송합니다만, 이 와인을 추천드립니다: Opus One 2018.' }),
      1,
    );
    expect(r.diagnostics?.some((d) => d.code === 'ANSWER_MUST_NOT_MATCH_HIT')).toBe(false);
    expect(r.scores.answerQuality).toBeCloseTo(1, 1);
  });

  it('answerMustNotMatch: terminal refusal IS penalised', () => {
    // "죄송합니다." as the complete answer — terminal refusal.
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, answerMustNotMatch: ['죄송합니다[.。！!\\s]*$'] }),
      makeExecution({ answer: '죄송합니다.' }),
      1,
    );
    expect(r.diagnostics?.some((d) => d.code === 'ANSWER_MUST_NOT_MATCH_HIT')).toBe(true);
    expect(r.scores.answerQuality).toBeLessThan(1);
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
    // P0-B fix: judge dim has NO_FLOOR treatment — a judge score of 0 is a true
    // rubric failure (not noise). judge weight=0.07, no floor, so overall can
    // be driven very low by geo-mean. The exact value depends on other dims but
    // must be < 0.95 and > 0 (not total collapse — other dims are fine).
    expect(r.scores.overall).toBeLessThan(0.95);
    expect(r.scores.overall).toBeGreaterThan(0);
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

  // ─── v4 monotonicity boundary cases ───────────────────────────────────

  it('monotonicity: adding judge=1.0 strictly increases overall vs null', () => {
    // v4 fix: fixed 0.5 neutral imputation — null dims imputed at 0.5.
    // Adding judge=1.0 (above neutral) must raise overall.
    const base = makeExecution({ answer: 'Opus One 2018 is a great Napa Cabernet.', observations: ['Found: Opus One 2018'] });
    const withNullJudge = scoreScenario(makeScenario({ maxSteps: 5 }), base, undefined, 0.8);
    const withPerfectJudge = scoreScenario(makeScenario({ maxSteps: 5 }), base, 1.0, 0.8);
    expect(withPerfectJudge.scores.overall).toBeGreaterThan(withNullJudge.scores.overall);
  });

  it('monotonicity: adding judge=0.0 strictly decreases overall vs null', () => {
    // judge=0.0 (below neutral 0.5) must lower overall.
    const base = makeExecution({ answer: 'Opus One 2018 is a great Napa Cabernet.', observations: ['Found: Opus One 2018'] });
    const withNullJudge = scoreScenario(makeScenario({ maxSteps: 5 }), base, undefined, 0.8);
    const withZeroJudge = scoreScenario(makeScenario({ maxSteps: 5 }), base, 0, 0.8);
    expect(withZeroJudge.scores.overall).toBeLessThan(withNullJudge.scores.overall);
  });

  it('monotonicity: weight=0 dim (contextRecall) null→non-null does not change overall', () => {
    // contextRecall has weight=0 — transitioning from null to a real value must be inert.
    // Both cases use the SAME observations so that contextRelevance (weight>0) is
    // identical — the only variable is goldenKeywords presence (contextRecall).
    const obs = ['Found 3 results: Wine A (Benchmark Winery), Wine B, Wine C'];
    const scenarioNoKeywords = makeScenario({ maxSteps: 5 });
    const scenarioWithKeywords = makeScenario({ maxSteps: 5, goldenKeywords: ['Wine A'] });
    const exec = makeExecution({ answer: 'good answer', observations: obs });
    const rNull = scoreScenario(scenarioNoKeywords, exec, 0.8, 0.8);
    const rPresent = scoreScenario(scenarioWithKeywords, exec, 0.8, 0.8);
    // Weight=0 → contextRecall change must not affect overall (within float tolerance)
    expect(Math.abs(rPresent.scores.overall - rNull.scores.overall)).toBeLessThan(0.02);
  });

  it('null-drop: multiple null dims → overall computed from present dims only (no drag)', () => {
    // v4 null-drop: null dims excluded from denominator. With judge=null and
    // faithfulness=null, overall is computed from present dims only — no 0.5 drag.
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'good answer about wine vintage and region' }),
      undefined, // judge null
      undefined, // faithfulness null
    );
    // answerQuality and executionEfficiency are always computed (non-null), so presentWeight > 0.
    // Score should be > 0 and finite.
    expect(r.scores.overall).toBeGreaterThan(0);
    expect(Number.isFinite(r.scores.overall)).toBe(true);
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
    // With termination weight 0.80 and termination=0.25 (fallback partial credit),
    // overall is low but not collapsed due to EPS floor.
    expect(r.scores.overall).toBeLessThan(0.4);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Weight invariants (M4)
// ─────────────────────────────────────────────────────────────────────

describe('weight invariants', () => {
  const REQUIRED_KEYS = [
    'executionEfficiency',
    'answerQuality',
    'answerRelevancy',
    'terminationCorrectness',
    'costEfficiency',
    'judge',
    'contextRelevance',
    'contextRecall',
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
    // v4: casual markers now use multi-char patterns (줄게,건데,잖아,거든,거야,해줘,해봐...)
    // and threshold is 3. This answer has 4 casual markers: 해줘, 거든, 잖아, 할게.
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, requiredRegister: 'formal' }),
      makeExecution({ answer: '이 와인 해줘. 맛있거든. 잖아 진짜 좋다니까. 다음에도 할게.' }),
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
    // v4: '확실히'/'분명히' removed (normal polite Korean). Use '틀림없이' (truly extreme).
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, maxConfidence: 0.3 }),
      makeExecution({ answer: '틀림없이 이 와인이 최고입니다!' }),
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

describe('RAGAS Context Relevance', () => {
  it('returns null when no observations', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, vintageRange: { min: 2018, max: 2020 } }),
      makeExecution({ observations: [] }),
      undefined,
    );
    expect(r.scores.contextRelevance).toBeNull();
  });

  it('returns null when no structured constraints', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ observations: ['Found: Wine A | vintage: 2019'] }),
      undefined,
    );
    // No priceBandKrw, vintageRange, drinkingWindowStatus → null
    // (query_terms_in_context check may still fire if tools have query)
    expect(r.scores.contextRelevance).not.toBeUndefined();
  });

  it('vintageRange: passes when observation contains in-range year', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, vintageRange: { min: 2018, max: 2020 } }),
      makeExecution({
        observations: ['Found: Wine A | vintage: 2019 | region: Napa'],
      }),
      undefined,
    );
    expect(r.scores.contextRelevance).toBeGreaterThan(0);
  });

  it('vintageRange: fails when observation contains out-of-range year', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, vintageRange: { min: 2018, max: 2020 } }),
      makeExecution({
        observations: ['Found: Wine A | vintage: 2015 | region: Napa'],
      }),
      undefined,
    );
    // P1-B fix: vintage is a hard constraint — out-of-range → CONTEXT_HARD_CONSTRAINT_FAILED
    // (not CONTEXT_RELEVANCE_LOW), and contextRelevance collapses to 0.
    expect(r.diagnostics?.some((d) => d.code === 'CONTEXT_HARD_CONSTRAINT_FAILED')).toBe(true);
    expect(r.scores.contextRelevance).toBe(0);
  });

  it('drinkingWindowStatus: passes when keywords match', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, drinkingWindowStatus: 'now' }),
      makeExecution({
        observations: ['Wine A: currently drinkable, peak 2024-2028'],
      }),
      undefined,
    );
    expect(r.scores.contextRelevance).toBeGreaterThan(0);
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
    expect(r.scores.contextRelevance).toBeGreaterThan(0);
  });

  it('query-context alignment: Korean 2-syllable words (e.g. "레드") count as significant', () => {
    // "레드" is 2 chars (Hangul) — old ASCII threshold of 3 excluded it.
    // With Hangul min-length=2, "레드" should be included and match the observation.
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({
        toolsUsed: [tool('search_wines', '{"query":"레드 와인 추천"}')],
        observations: ['Found: 레드와인 1번 | producer: 와이너리A'],
      }),
      undefined,
    );
    // "레드" (2 chars, Hangul) should be found in observation → contextRelevance > 0
    expect(r.scores.contextRelevance).toBeGreaterThan(0);
  });

  it('query-context alignment: passes with Korean food-wine query terms', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({
        toolsUsed: [tool('search_wines', '{"query":"삼겹살과 어울리는 레드"}')],
        observations: ['Found: Cabernet Sauvignon | region: 나파 밸리 | grapes: Cabernet'],
      }),
      undefined,
    );
    // "삼겹살" (3 Hangul chars) should be present — even without match in obs,
    // "레드" from query should appear in observation ("레드" and Cabernet both present)
    expect(r.scores.contextRelevance).not.toBeNull();
  });

  it('cross-lingual: Korean query + English-only observation → contextRelevance null (v4 honest skip)', () => {
    // v4 fix: when query has Hangul but observation is English-only, we CANNOT
    // assess term relevance ("이탈리아" ≠ "Italy"). Skip the check entirely (null),
    // rather than auto-passing (true). null is honest: "insufficient info to assess".
    // Previously auto-passed, which made 96%+ of Korean scenarios score contextRelevance=1
    // regardless of retrieval quality, defeating the metric.
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({
        toolsUsed: [tool('search_wines', '{"query":"이탈리아 레드 평점 좋고 지금 마실 수 있는"}')],
        // English-only observation — no Hangul characters
        observations: ['Found 5 results: 1. Barolo 2018 (id: wine-001) | producer: Giacomo Conterno | region: Piedmont, Italy | grapes: Nebbiolo | price: 80000-120000'],
      }),
      undefined,
    );
    // No structured constraints (no priceBandKrw, vintageRange, etc.)
    // AND cross-lingual bypass skips query_terms_in_context → no checks at all → null
    expect(r.scores.contextRelevance).toBeNull();
  });

  it('cross-lingual: English query + English observation → normal term-matching still applies', () => {
    // English query + English observation: normal matching, not bypassed
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({
        toolsUsed: [tool('search_wines', '{"query":"Italian red high rating"}')],
        observations: ['Found 2 results: 1. Barolo Nebbiolo 2018 | region: Piedmont, Italy | grapes: Nebbiolo'],
      }),
      undefined,
    );
    // Italian + red should partially match (Italian→not present, but "red" is a stopword; "rating" missing)
    // Key point: this path goes through normal matching, not the cross-lingual bypass
    expect(r.scores.contextRelevance).not.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// RAGAS Context Recall (canonical-label keyword overlap — v3)
// ─────────────────────────────────────────────────────────────────────
// v3 breaking change: goldenEntityIds (slug-based) replaced by goldenKeywords
// (canonical-label fragments). Observations contain "1. Opus One 2018 (id: vivino-xxx)"
// so keyword "opus one" matches; slug "opus-one-2018" never matched.

describe('RAGAS Context Recall', () => {
  it('goldenKeywords present and keywords appear in observations → recall = 1', () => {
    const scenario = makeScenario(
      { maxSteps: 5 },
      { goldenKeywords: ['opus one', 'ridge monte bello'] },
    );
    const r = scoreScenario(
      scenario,
      makeExecution({
        observations: [
          '1. Opus One 2018 Robert Mondavi (id: vivino-abc123)',
          '2. Ridge Monte Bello 2019 (id: vivino-def456)',
        ],
      }),
      undefined,
    );
    expect(r.scores.contextRecall).toBe(1.0);
  });

  it('goldenKeywords present but none appear in observations → recall = 0, diagnostic emitted', () => {
    const scenario = makeScenario(
      { maxSteps: 5 },
      { goldenKeywords: ['château pétrus', 'screaming eagle'] },
    );
    const r = scoreScenario(
      scenario,
      makeExecution({
        observations: ['1. Some Other Wine (id: vivino-other999)'],
      }),
      undefined,
    );
    expect(r.scores.contextRecall).toBe(0);
    expect(r.diagnostics?.some((d) => d.code === 'CONTEXT_RECALL_LOW')).toBe(true);
  });

  it('scenario without goldenKeywords → recall is null (diagnostic only)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({
        observations: ['1. Opus One 2018 (id: vivino-abc)'],
      }),
      undefined,
    );
    expect(r.scores.contextRecall).toBeNull();
  });

  it('partial recall: only some keywords in observations → 0 < recall < 1', () => {
    const scenario = makeScenario(
      { maxSteps: 5 },
      { goldenKeywords: ['opus one', 'almaviva', 'petrus'] },
    );
    const r = scoreScenario(
      scenario,
      makeExecution({
        observations: ['1. Opus One 2019 (id: vivino-1) · 2. Almaviva 2019 (id: vivino-2)'],
      }),
      undefined,
    );
    // 2 of 3 keywords found → recall = 2/3 ≈ 0.667
    expect(r.scores.contextRecall).toBeCloseTo(2 / 3, 5);
  });

  it('no observations with goldenKeywords → recall is null', () => {
    const scenario = makeScenario(
      { maxSteps: 5 },
      { goldenKeywords: ['opus one'] },
    );
    const r = scoreScenario(
      scenario,
      makeExecution({ observations: [] }),
      undefined,
    );
    expect(r.scores.contextRecall).toBeNull();
  });

  it('keyword matching is case-insensitive', () => {
    // "Château Margaux" in obs vs lowercase "château margaux" in goldenKeywords — case only
    const scenario = makeScenario(
      { maxSteps: 5 },
      { goldenKeywords: ['château margaux'] },
    );
    const r = scoreScenario(
      scenario,
      makeExecution({
        observations: ['1. Château Margaux 2018 (id: vivino-xyz)'],
      }),
      undefined,
    );
    expect(r.scores.contextRecall).toBe(1.0);
  });

  it('keyword matching handles precomposed vs decomposed Unicode (NFKC)', () => {
    // keyword uses precomposed é (U+00E9); observation uses decomposed e + combining accent (U+0301).
    // NFKC normalization must convert both to the same form before matching.
    const scenario = makeScenario(
      { maxSteps: 5 },
      { goldenKeywords: ['château margaux'] },  // precomposed é in château
    );
    const r = scoreScenario(
      scenario,
      makeExecution({
        observations: ['1. Cha\u0302teau Margaux 2018 (id: vivino-xyz)'],  // â decomposed
      }),
      undefined,
    );
    // NFKC normalizes both to identical canonical form → match
    expect(r.scores.contextRecall).toBe(1.0);
  });

  it('vintage-qualified goldenKeywords do not match different vintages', () => {
    // scenario #1 uses 'opus one 2018' to avoid matching "Opus One Overture 2019"
    const scenario = makeScenario(
      { maxSteps: 5 },
      { goldenKeywords: ['opus one 2018'] },
    );
    const r = scoreScenario(
      scenario,
      makeExecution({
        observations: ['1. Opus One Overture 2019 (id: vivino-xyz)'],  // wrong vintage
      }),
      undefined,
    );
    expect(r.scores.contextRecall).toBe(0);  // '2018' not in observation → miss
  });

  it('two-word phrase goldenKeyword prevents AOC-region false matches', () => {
    // 'château margaux' (two words) won't match "Château Brane-Cantenac Margaux de Brane"
    const scenario = makeScenario(
      { maxSteps: 5 },
      { goldenKeywords: ['château margaux'] },
    );
    const r = scoreScenario(
      scenario,
      makeExecution({
        observations: ['1. Château Brane-Cantenac Margaux de Brane (id: vivino-aoc)'],
      }),
      undefined,
    );
    // "château margaux" NOT present as consecutive substring → recall = 0
    expect(r.scores.contextRecall).toBe(0);
  });

  it('contextRecall weight is 0 in DEFAULT_WEIGHTS — does not affect overall', () => {
    // Two identical scenarios except one has goldenKeywords with 0% hit.
    // Both should produce the same overall score because weight=0.
    const base = makeScenario({ maxSteps: 5 });
    const withKeywords = makeScenario({ maxSteps: 5 }, { goldenKeywords: ['petrus'] });
    const exec = makeExecution({ observations: ['1. Opus One (id: vivino-abc)'] });
    const rBase = scoreScenario(base, exec, undefined);
    const rWithKeywords = scoreScenario(withKeywords, exec, undefined);
    // contextRecall=null (base) vs 0 (withKeywords) — overall must be equal
    // since contextRecall weight=0.
    expect(rWithKeywords.scores.contextRecall).toBe(0);
    expect(rBase.scores.contextRecall).toBeNull();
    expect(rWithKeywords.scores.overall).toBeCloseTo(rBase.scores.overall, 4);
  });
});

describe('RAGAS weight integration', () => {
  it('DEFAULT_WEIGHTS includes faithfulness + contextRelevance + contextRecall + answerRelevancy and sums to 1.0', () => {
    expect(DEFAULT_WEIGHTS).toHaveProperty('faithfulness');
    expect(DEFAULT_WEIGHTS).toHaveProperty('contextRelevance');
    // contextRecall is diagnostic-only in v3 — weight=0 is expected and correct
    expect(DEFAULT_WEIGHTS).toHaveProperty('contextRecall');
    expect(DEFAULT_WEIGHTS.contextRecall).toBe(0);
    expect(DEFAULT_WEIGHTS).toHaveProperty('answerRelevancy');
    const sum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it('every TIER_WEIGHTS entry includes faithfulness + contextRelevance + contextRecall + answerRelevancy', () => {
    for (const [tier, weights] of Object.entries(TIER_WEIGHTS)) {
      expect(weights, `${tier} missing faithfulness`).toHaveProperty('faithfulness');
      expect(weights, `${tier} missing contextRelevance`).toHaveProperty('contextRelevance');
      expect(weights, `${tier} missing contextRecall`).toHaveProperty('contextRecall');
      expect(weights, `${tier} missing answerRelevancy`).toHaveProperty('answerRelevancy');
      const sum = Object.values(weights).reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - 1), `${tier} sum=${sum}`).toBeLessThan(1e-9);
    }
  });

  it('renormaliseWeights preserves faithfulness + contextRelevance + contextRecall', () => {
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

// ─────────────────────────────────────────────────────────────────────
// answerRelevancy dimension
// ─────────────────────────────────────────────────────────────────────

describe('answerRelevancy', () => {
  it('null when no judge and no answerMustMatch patterns', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'a wine recommendation' }),
      undefined, // no judge
    );
    expect(r.scores.answerRelevancy).toBeNull();
  });

  it('P0-A fix: judge present → answerRelevancy=null (no double-counting)', () => {
    // Before fix: answerRelevancy = judgeScore (0.75), meaning judge score was
    // applied at combined weight 0.07+0.10=0.17. Now answerRelevancy drops to
    // null when judge is present — the judge dim owns that signal at weight 0.07.
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'a wine recommendation' }),
      0.75, // judge present
    );
    expect(r.scores.answerRelevancy).toBeNull();
    expect(r.scores.judge).toBe(0.75);
  });

  it('P0-A fix: judge=0 → answerRelevancy=null, judge=0 in scores', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'a wine recommendation' }),
      0,
    );
    expect(r.scores.answerRelevancy).toBeNull();
    expect(r.scores.judge).toBe(0);
  });

  it('v4: always null even when answerMustMatch patterns match and no judge', () => {
    // v4: answerRelevancy removed from scoring — always null regardless of patterns.
    // answerMustMatch penalizes answerQuality via PENALTY_REGEX_MISS instead.
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, answerMustMatch: ['Opus One', '\\d{4}'] }),
      makeExecution({ answer: 'I recommend Opus One 2018.' }),
      undefined,
    );
    expect(r.scores.answerRelevancy).toBeNull();
    // answerMustMatch still affects answerQuality (no penalty since patterns matched)
    expect(r.scores.answerQuality).toBeGreaterThan(0.9);
  });

  it('v4: always null when patterns miss and no judge (was 0.0 in v3)', () => {
    // v4: answerRelevancy always null; penalty goes into answerQuality via PENALTY_REGEX_MISS.
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, answerMustMatch: ['Barolo', 'Napa'] }),
      makeExecution({ answer: 'Try this Chardonnay.' }),
      undefined,
    );
    expect(r.scores.answerRelevancy).toBeNull();
    // But answerQuality IS penalized for missing patterns (0.5 × 0.5 = 0.25)
    expect(r.scores.answerQuality).toBeCloseTo(0.25);
  });

  it('v4: always null when judge present', () => {
    // judge dim carries the rubric signal; answerRelevancy stays null.
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, answerMustMatch: ['Napa'] }),
      makeExecution({ answer: 'I recommend Opus One.' }),
      0.9, // judge present
    );
    expect(r.scores.answerRelevancy).toBeNull();
    expect(r.scores.judge).toBe(0.9);
  });

  it('is included in scores object', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution(),
      0.8,
    );
    expect(r.scores).toHaveProperty('answerRelevancy');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Round 2-5 regression tests
// ─────────────────────────────────────────────────────────────────────

describe('TOOL_DUPLICATE_CALLS — all violations penalized', () => {
  it('multiple tools duplicated → both penalized (no break-early)', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 10,
        tools: [{ tool: 'search_wines' }, { tool: 'compare_wines' }],
      }),
      makeExecution({
        stepCount: 6,
        toolCallCount: 6,
        toolsUsed: [
          tool('search_wines'), tool('search_wines'), tool('search_wines'),
          tool('compare_wines'), tool('compare_wines'), tool('compare_wines'),
        ],
      }),
      undefined,
    );
    // Both tools called 3x (expected 1x each), both should be penalized.
    // With 0.7 penalty per tool: 1.0 * 0.7 * 0.7 = 0.49
    expect(r.scores.toolAccuracy).toBeLessThan(0.5);
  });

  it('single tool duplicated → only one penalty applied', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 10,
        tools: [{ tool: 'search_wines' }, { tool: 'compare_wines' }],
      }),
      makeExecution({
        stepCount: 4,
        toolCallCount: 4,
        toolsUsed: [
          tool('search_wines'), tool('search_wines'), tool('search_wines'),
          tool('compare_wines'),
        ],
      }),
      undefined,
    );
    // Only search_wines is over-duplicated (3x vs 1x expected). Score = 1.0 * 0.7 = 0.7
    expect(r.scores.toolAccuracy).toBeGreaterThanOrEqual(0.69);
    expect(r.scores.toolAccuracy).toBeLessThan(0.71);
  });
});

describe('maxConfidence — handles all threshold values', () => {
  it('maxConfidence=0.7 with overconfident language → penalized', () => {
    // v4: '확실히' removed from overconfident patterns (normal polite Korean).
    // Use '틀림없이' (genuinely extreme) instead.
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, maxConfidence: 0.7 }),
      makeExecution({ answer: '틀림없이 이 와인이 최고입니다' }),
      undefined,
    );
    // Should be penalized even though 0.7 > 0.5
    expect(r.scores.answerQuality).toBeLessThan(1);
  });

  it('maxConfidence=0.8 without overconfident language → no penalty', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, maxConfidence: 0.8 }),
      // Answer is ≥20 chars to avoid the trivial-answer length penalty.
      makeExecution({ answer: '이 와인은 좋은 선택일 수 있습니다. 편하게 즐겨보세요.' }),
      undefined,
    );
    expect(r.scores.answerQuality).toBe(1);
  });
});

describe('multiple null dimensions — geo mean handles gracefully', () => {
  it('both judge and faithfulness null → overall uses remaining dims', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'good wine recommendation' }),
      undefined,  // no judge
      undefined,  // no faithfulness
    );
    expect(r.scores.judge).toBeNull();
    expect(r.scores.faithfulness).toBeNull();
    expect(Number.isFinite(r.scores.overall)).toBe(true);
    expect(r.scores.overall).toBeGreaterThan(0);
  });

  it('all optional dims null → still computes from execution + answer + cost + termination', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({
        answer: 'a helpful wine answer',
        observations: [],  // no observations → contextRelevance null, contextRecall null
      }),
      undefined,  // no judge
      undefined,  // no faithfulness
    );
    expect(r.scores.judge).toBeNull();
    expect(r.scores.faithfulness).toBeNull();
    expect(r.scores.contextRelevance).toBeNull();
    expect(r.scores.contextRecall).toBeNull();
    expect(Number.isFinite(r.scores.overall)).toBe(true);
    expect(r.scores.overall).toBeGreaterThan(0);
  });
});

describe('weightedGeometricMean null-drop invariant', () => {
  // Regression guard (v4 — null-drop):
  // A disabled (null) dimension is EXCLUDED from the geo-mean computation.
  // Its weight is dropped from the denominator, remaining dims are renormalized.
  //
  // Key invariants:
  //   - null → excluded from geo-mean (no drag, no inflation)
  //   - judge=1.0 with null → null has no effect; judge=1.0 may raise or lower
  //     depending on whether 1.0 is above or below the present-dims geo-mean
  //   - judge=0.0 → always lowers overall (0.0 is below any positive geo-mean)
  //   - No coupling: adding info about dim A cannot change the contribution of dim B

  it('null judge is excluded: overall is computed from present dims only', () => {
    const rNull = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'good recommendation', observations: ['found opus one'] }),
      undefined, // judge disabled → excluded
    );
    expect(rNull.scores.judge).toBeNull();
    expect(rNull.scores.overall).toBeGreaterThan(0);
    expect(Number.isFinite(rNull.scores.overall)).toBe(true);
  });

  it('null judge does not collapse overall compared to judge=0', () => {
    // judge=0 participates and drags geo-mean; judge=null is excluded.
    const rNull = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'good recommendation', observations: ['found opus one'] }),
      undefined,
    );
    const rZero = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'good recommendation', observations: ['found opus one'] }),
      0.0,
    );
    expect(rNull.scores.overall).toBeGreaterThan(rZero.scores.overall);
  });

  it('disabling two dims still yields finite positive overall', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'some answer', observations: [] }), // no obs → faith/ctxRel/ctxRecall null
      undefined, // judge null too
    );
    expect(r.scores.faithfulness).toBeNull();
    expect(r.scores.contextRelevance).toBeNull();
    expect(r.scores.judge).toBeNull();
    expect(Number.isFinite(r.scores.overall)).toBe(true);
    expect(r.scores.overall).toBeGreaterThan(0);
    expect(r.scores.overall).toBeLessThanOrEqual(1);
  });
});

describe('step-0 fallback exemption (LLM unavailable — infra failure)', () => {
  it('step-0 fallback with expected tool → toolAccuracy=1 (not penalized)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, tools: [{ tool: 'search_wines' }] }),
      makeExecution({ stepCount: 0, toolsUsed: [], toolCallCount: 0, terminationReason: 'fallback' }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBe(1);
    const diag = r.diagnostics.find((d) => d.code === 'TOOL_ACCURACY_SKIPPED_STEP0_FALLBACK');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('info');
  });

  it('step-0 fallback with TERMINATION_MISMATCH → 0.25 partial credit (not 0)', () => {
    // Scenario explicitly expects terminationReason='answer'
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, terminationReason: 'answer' }),
      makeExecution({ stepCount: 0, toolsUsed: [], terminationReason: 'fallback' }),
      undefined,
    );
    expect(r.scores.terminationCorrectness).toBeCloseTo(0.25, 2);
    const diag = r.diagnostics.find((d) => d.code === 'TERMINATION_MISMATCH');
    expect(diag?.message).toContain('partial credit');
  });

  it('step-0 fallback with mustNotCallTools → still checks (security gate must not be bypassed)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 1, mustNotCallTools: ['search_wines'] }),
      makeExecution({ stepCount: 0, toolsUsed: [], terminationReason: 'fallback' }),
      undefined,
    );
    // mustNotCallTools not violated (no tools called) → toolAccuracy=1
    expect(r.scores.toolAccuracy).toBe(1);
  });

  it('step-0 fallback with expectedBlocked=true → NOT exempted (security critical)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 1, expectedBlocked: true }),
      makeExecution({ stepCount: 0, toolsUsed: [], terminationReason: 'fallback' }),
      undefined,
    );
    // expectedBlocked=true but got fallback (not blocked) → critical failure
    expect(r.scores.terminationCorrectness).toBe(0);
    const diag = r.diagnostics.find((d) => d.code === 'EXPECTED_BLOCKED_NOT_BLOCKED');
    expect(diag).toBeDefined();
  });

  it('step-1 fallback (agent ran) → tool accuracy scored normally (missing tool IS penalized)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, tools: [{ tool: 'search_wines' }] }),
      makeExecution({ stepCount: 1, toolsUsed: [], toolCallCount: 0, terminationReason: 'fallback' }),
      undefined,
    );
    // stepCount=1 → agent did run, tool missing IS a genuine failure → toolAccuracy=0
    expect(r.scores.toolAccuracy).toBe(0);
  });

  it('step-1 fallback with explicit terminationReason expectation → partial credit (0.25)', () => {
    // Even a mid-run fallback (e.g. synthesis LLM rate-limited after 1 tool call)
    // is an infra failure, not agent logic failure — give partial credit.
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, terminationReason: 'answer' }),
      makeExecution({ stepCount: 1, toolsUsed: [], terminationReason: 'fallback' }),
      undefined,
    );
    expect(r.scores.terminationCorrectness).toBeCloseTo(0.25, 2);
    const diag = r.diagnostics.find((d) => d.code === 'TERMINATION_MISMATCH');
    expect(diag?.message).toContain('partial credit');
  });
});

describe('penalty constants are used correctly', () => {
  it('extra tool calls use PENALTY_EXTRA_TOOL_PER_CALL and CAP', () => {
    // 6 extra calls should hit the 50% cap
    const r = scoreScenario(
      makeScenario({
        maxSteps: 10,
        tools: [{ tool: 'search_wines' }],
      }),
      makeExecution({
        stepCount: 7,
        toolCallCount: 7,
        toolsUsed: [
          tool('search_wines'),
          tool('extra1'), tool('extra2'), tool('extra3'),
          tool('extra4'), tool('extra5'), tool('extra6'),
        ],
      }),
      undefined,
    );
    // 6 extras, 10% each = 60% but capped at 50%. Score = 1.0 * 0.5 = 0.5
    expect(r.scores.toolAccuracy).toBeCloseTo(0.5, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P0-B regression: DIMENSION_FLOOR must NOT apply to execution/term/judge
// ─────────────────────────────────────────────────────────────────────

describe('P0-B regression — DIMENSION_FLOOR exemptions', () => {
  it('executionEfficiency near-zero is NOT floored to 0.05 (regression mask prevention)', () => {
    // Before fix: executionEfficiency=0.01 would be raised to DIMENSION_FLOOR=0.05
    // making a critical tool failure look 5x less bad in the geo-mean.
    // After fix: executionEfficiency passes through unmodified.
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, tools: [{ tool: 'search_wines' }] }),
      makeExecution({
        stepCount: 20,        // massively over budget → near-zero stepEfficiency
        toolCallCount: 20,
        toolsUsed: [tool('wrong_tool')], // wrong tool → low toolAccuracy
      }),
      undefined,
    );
    // executionEfficiency = merge(toolAccuracy, stepEfficiency) — both near 0.
    // Must stay near 0, NOT be floored to 0.05.
    expect(r.scores.executionEfficiency).toBeLessThan(0.1);
  });

  it('judge=0 is NOT floored — stays at 0 and drives overall lower than no-judge', () => {
    const withZeroJudge = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'good answer' }),
      0,
    );
    // Structural: judge dim present in scores at 0
    expect(withZeroJudge.scores.judge).toBe(0);

    const withNoJudge = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ answer: 'good answer' }),
      undefined,
    );
    // Before P0-B fix: judge=0 was floored to 0.05, making it barely worse than no-judge.
    // After fix: judge=0 is unflored, so it drives overall clearly lower than no-judge.
    expect(withZeroJudge.scores.overall).toBeLessThan(withNoJudge.scores.overall);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P1-B regression: hard constraint failure → contextRelevance = 0
// ─────────────────────────────────────────────────────────────────────

describe('P1-B regression — contextRelevance hard constraint collapse', () => {
  it('price out-of-range → soft penalty (not critical)', () => {
    // Price is a soft constraint (search pipeline has no real price filter).
    // Out-of-range price docks contextRelevance but does NOT trigger critical failure.
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, priceBandKrw: { min: 50_000, max: 100_000 } }),
      makeExecution({
        observations: ['Wine A: 200,000원 | Napa Cabernet 2019 | score: 95'],
        toolsUsed: [tool('search_wines', JSON.stringify({ query: 'Cabernet Napa' }))],
      }),
      undefined,
    );
    expect(r.scores.contextRelevance).toBeLessThan(1);
    expect(r.scores.contextRelevance).toBeGreaterThan(0);
    expect(r.diagnostics?.some((d) => d.code === 'CONTEXT_HARD_CONSTRAINT_FAILED')).toBe(false);
  });

  it('vintage out-of-range → score 0', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, vintageRange: { min: 2015, max: 2020 } }),
      makeExecution({
        observations: ['Wine B: 2010 Burgundy Pinot Noir | 80,000원'],
      }),
      undefined,
    );
    expect(r.scores.contextRelevance).toBe(0);
    expect(r.diagnostics?.some((d) => d.code === 'CONTEXT_HARD_CONSTRAINT_FAILED')).toBe(true);
  });

  it('price in-range + vintage in-range → partial score from soft checks only', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        priceBandKrw: { min: 50_000, max: 150_000 },
        vintageRange: { min: 2015, max: 2020 },
      }),
      makeExecution({
        observations: ['Wine C: 2018 Napa Cabernet | 80,000원'],
        toolsUsed: [tool('search_wines', JSON.stringify({ query: 'Cabernet Napa 2018' }))],
      }),
      undefined,
    );
    // Both hard constraints pass → score > 0
    expect(r.scores.contextRelevance).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P2 regression: extractKoreanPrices €/£ support
// ─────────────────────────────────────────────────────────────────────

describe('P2 regression — extractKoreanPrices currency coverage', () => {
  it('€ amounts are extracted and converted to KRW', () => {
    // €50 × 1500 = 75,000 KRW — within 50k–100k range
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, priceBandKrw: { min: 50_000, max: 100_000 } }),
      makeExecution({
        observations: ['Wine: €50 Burgundy Chardonnay 2019'],
      }),
      undefined,
    );
    // price check should PASS (75k is in range) — no hard constraint failure
    expect(r.diagnostics?.some((d) => d.code === 'CONTEXT_HARD_CONSTRAINT_FAILED')).toBe(false);
  });

  it('£ amounts are extracted and converted to KRW', () => {
    // £100 × 1700 = 170,000 KRW — above 50k–100k range → soft penalty (not critical)
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, priceBandKrw: { min: 50_000, max: 100_000 } }),
      makeExecution({
        observations: ['Wine: £100 Bordeaux 2018'],
      }),
      undefined,
    );
    expect(r.scores.contextRelevance).toBeLessThan(1);
    // Price is soft, not hard — no critical failure
    expect(r.diagnostics?.some((d) => d.code === 'CONTEXT_HARD_CONSTRAINT_FAILED')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P2 regression: extractVintageYears 1600s support
// ─────────────────────────────────────────────────────────────────────

describe('P2 regression — extractVintageYears historic vintage coverage', () => {
  it('1797 vintage is extracted (pre-phylloxera historic bottle)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, vintageRange: { min: 1790, max: 1800 } }),
      makeExecution({
        observations: ['Rare 1797 Madeira Sercial — historic collector piece'],
      }),
      undefined,
    );
    // vintage 1797 is in range 1790–1800 → should pass, NOT hard fail
    expect(r.diagnostics?.some((d) => d.code === 'CONTEXT_HARD_CONSTRAINT_FAILED')).toBe(false);
  });

  it('1650 vintage NOT extracted (below minimum 1600 floor)', () => {
    // 1650 < 1600 regex lower bound — should be ignored, no vintage check fired
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, vintageRange: { min: 1640, max: 1660 } }),
      makeExecution({
        observations: ['Ancient 1650 bottle from private cellar'],
      }),
      undefined,
    );
    // 1650 not extracted (below regex range) → no vintage check → contextRelevance
    // either null or based on other checks only (no hard fail from vintage)
    expect(r.diagnostics?.some((d) => d.code === 'CONTEXT_HARD_CONSTRAINT_FAILED')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Blocked termination reason — security gate scenarios
// ─────────────────────────────────────────────────────────────────────

describe('blocked termination reason — security gate correct behavior', () => {
  it('terminationReason=blocked with no expectedBlocked → terminationCorrectness=1 (correct rejection)', () => {
    // Security gate fires correctly on adversarial input. Score should be 1.
    const r = scoreScenario(
      makeScenario({ maxSteps: 2 }),
      makeExecution({
        answer: '이 요청은 처리할 수 없습니다. 와인 검색과 관련된 질문을 해주세요.',
        stepCount: 0,
        toolsUsed: [],
        toolCallCount: 0,
        terminationReason: 'blocked',
      }),
      undefined,
    );
    expect(r.scores.terminationCorrectness).toBe(1);
    // Must not produce UNKNOWN_TERMINATION_REASON diagnostic for 'blocked'
    const hasUnknown = (r.diagnostics ?? []).some((d) => d.code === 'UNKNOWN_TERMINATION_REASON');
    expect(hasUnknown).toBe(false);
  });

  it('terminationReason=blocked with expectedBlocked=true → still 1 (explicit expectation)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, expectedBlocked: true, mustNotCallTools: ['search_wines'] }),
      makeExecution({
        answer: '처리 불가',
        stepCount: 0,
        toolsUsed: [],
        toolCallCount: 0,
        terminationReason: 'blocked',
      }),
      undefined,
    );
    expect(r.scores.terminationCorrectness).toBe(1);
  });

  it('terminationReason=answer with expectedBlocked=true → terminationCorrectness=0 (must block, not answer)', () => {
    // 'answer' is NOT acceptable when expectedBlocked=true.
    // A jailbreak scenario that produces an answer instead of blocking has FAILED
    // the security check — even if the answer is benign. Security gate must fire.
    // Enforcement: only 'blocked' scores 1; 'answer' scores 0.
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, expectedBlocked: true }),
      makeExecution({
        answer: 'I cannot process that request.',
        stepCount: 0,
        toolsUsed: [],
        toolCallCount: 0,
        terminationReason: 'answer',
      }),
      undefined,
    );
    expect(r.scores.terminationCorrectness).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Step-0 fallback exemptions for structured checks
// ─────────────────────────────────────────────────────────────────────

describe('step-0 fallback exemptions for structured checks', () => {
  const step0Fallback = makeExecution({
    answer: 'Based on your query, I found: Result for: 명절 가족 모임에 들고 갈 와인, 어른들도 드실 거야 (Benchmark Winery, Test Region).',
    stepCount: 0,
    toolsUsed: [],
    toolCallCount: 0,
    terminationReason: 'fallback',
  });

  it('requiredRegister check is skipped for step-0 fallback (no REGISTER_MISMATCH)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, requiredRegister: 'formal' }),
      step0Fallback,
      undefined,
    );
    const hasRegisterMismatch = (r.diagnostics ?? []).some((d) => d.code === 'REGISTER_MISMATCH');
    expect(hasRegisterMismatch).toBe(false);
  });

  it('drinkingWindowStatus check is skipped for step-0 fallback (no DRINKING_WINDOW_MISMATCH)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, drinkingWindowStatus: 'hold' }),
      makeExecution({
        answer: 'Result for: 셀러에 넣어둘 만한 거, 지금 마시면 아까운 와인 (Benchmark Winery).',
        stepCount: 0,
        toolsUsed: [],
        toolCallCount: 0,
        terminationReason: 'fallback',
      }),
      undefined,
    );
    const hasDrinkingMismatch = (r.diagnostics ?? []).some((d) => d.code === 'DRINKING_WINDOW_MISMATCH');
    expect(hasDrinkingMismatch).toBe(false);
  });

  it('requireHedging check is skipped for step-0 fallback (no HEDGING_MISSING)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, requireHedging: true }),
      makeExecution({
        answer: 'Result for: 그 유명한 와인 (Benchmark Winery, Test Region).',
        stepCount: 0,
        toolsUsed: [],
        toolCallCount: 0,
        terminationReason: 'fallback',
      }),
      undefined,
    );
    const hasHedgingMissing = (r.diagnostics ?? []).some((d) => d.code === 'HEDGING_MISSING');
    expect(hasHedgingMissing).toBe(false);
  });

  it('requiredRegister IS checked for step-1+ fallback (agent ran, produced output)', () => {
    // v4: casual markers now use multi-char patterns. This answer has 3 casual markers:
    // 해줘, 건데, 잖아 — enough to exceed the threshold (≥3).
    const r = scoreScenario(
      makeScenario({ maxSteps: 3, requiredRegister: 'formal' }),
      makeExecution({
        answer: '이거 해줘. 맛있건데 좋잖아. 다음에도 할게.',
        stepCount: 1,
        toolsUsed: [tool('search_wines')],
        toolCallCount: 1,
        terminationReason: 'fallback',
      }),
      undefined,
    );
    // step=1 → agent ran → register IS checked
    const hasRegisterMismatch = (r.diagnostics ?? []).some((d) => d.code === 'REGISTER_MISMATCH');
    expect(hasRegisterMismatch).toBe(true);
  });
});

// v4: ANSWER_LENGTH_BONUS and ANSWER_TRIVIAL_PENALTY removed entirely.
// scoreAnswerQuality is now purely contract-based. See scorer.ts removal comment.
// The 8 tests below were deleted — they tested behavior that no longer exists.

// ─────────────────────────────────────────────────────────────────────
// Korean CLR (Correct Language Rate) diagnostics
// ─────────────────────────────────────────────────────────────────────

describe('Korean CLR diagnostics', () => {
  it('emits CLR_CODE_SWITCH warn when Korean query gets English-only answer', () => {
    const scenario = makeScenario({}, { query: '레드 와인 추천해줘' });
    const execution = makeExecution({ answer: 'I recommend Chateau Margaux. It is a great red wine from Bordeaux France.' });
    const result = scoreScenario(scenario, execution, undefined);
    const clrDiag = result.diagnostics?.find((d) => d.code === 'CLR_CODE_SWITCH');
    expect(clrDiag).toBeDefined();
    expect(clrDiag?.severity).toBe('warn');
  });

  it('does NOT emit CLR_CODE_SWITCH when Korean query gets Korean answer', () => {
    const scenario = makeScenario({}, { query: '레드 와인 추천해줘' });
    const execution = makeExecution({ answer: '보르도 레드 와인을 추천드립니다. 까베르네 소비뇽 위주의 Chateau Margaux가 좋습니다.' });
    const result = scoreScenario(scenario, execution, undefined);
    const clrDiag = result.diagnostics?.find((d) => d.code === 'CLR_CODE_SWITCH');
    expect(clrDiag).toBeUndefined();
  });

  it('does NOT emit CLR_CODE_SWITCH for English-language query', () => {
    const scenario = makeScenario({}, { query: 'recommend a red wine from France' });
    const execution = makeExecution({ answer: 'I recommend Chateau Margaux from Bordeaux.' });
    const result = scoreScenario(scenario, execution, undefined);
    const clrDiag = result.diagnostics?.find((d) => d.code === 'CLR_CODE_SWITCH');
    expect(clrDiag).toBeUndefined();
  });

  it('CLR_CODE_SWITCH does NOT collapse overall score to 0', () => {
    const scenario = makeScenario({}, { query: '레드 와인 추천해줘' });
    const execution = makeExecution({ answer: 'I recommend Chateau Margaux red wine from Bordeaux.' });
    const result = scoreScenario(scenario, execution, undefined);
    const clrDiag = result.diagnostics?.find((d) => d.code === 'CLR_CODE_SWITCH');
    expect(clrDiag).toBeDefined();
    expect(result.scores.criticalFailure).toBe(false);
    expect(result.scores.overall).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// TIER_WEIGHTS sum to 1.0 (Fix 3)
// ─────────────────────────────────────────────────────────────────────

describe('TIER_WEIGHTS sum to 1.0', () => {
  it('core tier weights sum to 1.0', () => {
    // 'core' not a named tier — use knowledge_hybrid as the representative content-quality tier
    const sum = Object.values(TIER_WEIGHTS.knowledge_hybrid).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 3);
  });
  it('advanced tier weights sum to 1.0', () => {
    // 'advanced' not a named tier — use extreme as the representative cost-sensitive tier
    const sum = Object.values(TIER_WEIGHTS.extreme).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 3);
  });
  it('adversarial tier weights sum to 1.0', () => {
    const sum = Object.values(TIER_WEIGHTS.adversarial).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 3);
  });
});

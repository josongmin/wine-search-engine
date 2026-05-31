import { describe, it, expect } from 'vitest';
import { scoreScenario, DEFAULT_WEIGHTS, TIER_WEIGHTS } from '../scorer.js';
import { makeScenario, makeExecution, tool } from './__helpers__/scorer-test-helpers.js';

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


describe('diagnostics', () => {
  it('records each penalty reason', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 2,
        tools: [{ tool: 'search_hybrid', inputContains: ['Opus'] }],
        answerExcludes: ['white'],
      }),
      makeExecution({
        answer: 'A great white wine.',
        stepCount: 5,
        toolsUsed: [tool('search_hybrid', '{"query":"Cabernet"}'), tool('extra')],
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
      makeScenario({ maxSteps: 5, mustNotCallTools: ['search_hybrid'] }),
      makeExecution({ toolsUsed: [tool('search_hybrid')] }),
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
      makeScenario({ maxSteps: 5, mustNotCallTools: ['search_hybrid'] }),
      makeExecution({ toolsUsed: [tool('search_hybrid')] }),
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
      makeExecution({ toolsUsed: [tool('search_hybrid')] }),
      1,
    );
    expect(r.scores.criticalFailure).toBe(true);
    expect(r.scores.overall).toBe(0);
  });

  it('soft fails do NOT trigger criticalFailure', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, tools: [{ tool: 'search_hybrid' }] }),
      // Right tool called but with extra calls — only soft penalties
      makeExecution({ toolsUsed: [tool('search_hybrid'), tool('search_hybrid'), tool('search_hybrid')], stepCount: 3 }),
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
    // Judge receives DIMENSION_FLOOR treatment (0 -> 0.05) because rubric scoring
    // is treated as somewhat noisy. Even so, a 0 judge must still lower overall
    // meaningfully. The exact value depends on other dims but
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
    // Null judge is dropped from the geo-mean entirely.
    // Adding judge=1.0 must raise overall.
    const base = makeExecution({ answer: 'Opus One 2018 is a great Napa Cabernet.', observations: ['Found: Opus One 2018'] });
    const withNullJudge = scoreScenario(makeScenario({ maxSteps: 5 }), base, undefined, 0.8);
    const withPerfectJudge = scoreScenario(makeScenario({ maxSteps: 5 }), base, 1.0, 0.8);
    expect(withPerfectJudge.scores.overall).toBeGreaterThan(withNullJudge.scores.overall);
  });

  it('monotonicity: adding judge=0.0 strictly decreases overall vs null', () => {
    // judge=0.0 must lower overall relative to null-drop.
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
      makeScenario({ maxSteps: 5, tools: [{ tool: 'search_hybrid' }] }),
      makeExecution({ toolsUsed: [tool('search_hybrid')], stepCount: 2 }),
      undefined,
    );
    expect(r.scores.executionEfficiency).toBeGreaterThan(0.9);
  });

  it('both tool + step low (thrashing) → max() merge prevents double-counting', () => {
    // tool=0 (no expected tool called) AND step=0 (way over budget) → both 0.
    // max(0,0)=0; the merge does NOT make this worse than either individual,
    // which is the property we want vs. arithmetic-mean double-penalty.
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, tools: [{ tool: 'search_hybrid' }] }),
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
      makeScenario({ maxSteps: 5, tools: [{ tool: 'search_hybrid' }] }),
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


describe('maxConfidence — handles all threshold values', () => {
  it('maxConfidence: regex check removed (judge handles semantically) — no answerQuality penalty', () => {
    // v4: scorer no longer uses regex for overconfident language detection.
    // The judge evaluates this semantically via composeAutoRubric.
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, maxConfidence: 0.7 }),
      makeExecution({ answer: '틀림없이 이 와인이 최고입니다' }),
      undefined,
    );
    // No regex penalty applied; answerQuality stays at 1 (no other constraints).
    expect(r.scores.answerQuality).toBe(1);
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


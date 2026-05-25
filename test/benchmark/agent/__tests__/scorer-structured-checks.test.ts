import { describe, it, expect } from 'vitest';
import { scoreScenario, evaluatePredicate } from '../scorer.js';
import { makeScenario, makeExecution, tool } from './__helpers__/scorer-test-helpers.js';

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

  // v4 STRUCTURAL FIX: requireHedging, requiredRegister, maxConfidence, refusalExpected
  // are evaluated EXCLUSIVELY by the LLM judge via composeAutoRubric. The regex
  // path was removed (false positives + heuristic-tightening trap). The dimension
  // requires judgeRequired:true to produce a signal.

  it('requireHedging: no regex check (judge handles semantically) — no diagnostic emitted', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, requireHedging: true }),
      makeExecution({ answer: 'The best wine is Opus One. Buy it now.' }),
      undefined,
    );
    expect(r.diagnostics?.some((d) => d.code === 'HEDGING_MISSING')).toBeFalsy();
  });

  it('requiredRegister: no regex check (judge handles semantically) — no diagnostic emitted', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, requiredRegister: 'formal' }),
      makeExecution({ answer: '이 와인 해줘. 맛있거든. 잖아 진짜 좋다니까. 다음에도 할게.' }),
      undefined,
    );
    expect(r.diagnostics?.some((d) => d.code === 'REGISTER_MISMATCH')).toBeFalsy();
  });

  it('maxConfidence: no regex check (judge handles semantically) — no diagnostic emitted', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, maxConfidence: 0.3 }),
      makeExecution({ answer: '틀림없이 이 와인이 최고입니다!' }),
      undefined,
    );
    expect(r.diagnostics?.some((d) => d.code === 'OVERCONFIDENT_LANGUAGE')).toBeFalsy();
  });

  it('refusalExpected: no regex check (judge handles semantically) — no critical fail from missing markers', () => {
    // Previously REFUSAL_MISSING/REFUSAL_CONTRADICTED were critical regex checks.
    // Now: judge evaluates whether the agent actually refused appropriately.
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, refusalExpected: true }),
      makeExecution({ answer: 'Here is a great 1962 Screaming Eagle!' }),
      undefined,
    );
    expect(r.diagnostics?.some((d) => d.code === 'REFUSAL_MISSING')).toBeFalsy();
    expect(r.diagnostics?.some((d) => d.code === 'REFUSAL_CONTRADICTED')).toBeFalsy();
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
    const diagnostic = r.diagnostics?.find((d) => d.code === 'EXPECTED_TOOL_ARG_MISSING');
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.observed).toBe('100000');
    expect(diagnostic?.expected).toBe('lte 50000');
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

  it('expectedToolArgs: supports contains predicate over array-valued tool args', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        expectedToolArgs: [
          { tool: 'search_wines', argPath: 'styles', predicate: 'contains', value: 'screw_cap' },
          { tool: 'search_wines', argPath: 'occasion', predicate: 'contains', value: 'camping' },
        ],
      }),
      makeExecution({
        toolsUsed: [
          tool('search_wines', '{"query":"캠핑 와인","styles":["screw_cap","chillable"],"occasion":["camping"]}'),
        ],
      }),
      undefined,
    );

    expect(r.diagnostics?.some((d) => d.code === 'EXPECTED_TOOL_ARG_MISSING')).toBeFalsy();
    expect(evaluatePredicate(['screw_cap', 'chillable'], 'contains', 'screw_cap')).toBe(true);
  });

  it('expectedToolArgs: supports contains_any predicate for localized canonical forms', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        expectedToolArgs: [
          { tool: 'search_wines', argPath: 'query', predicate: 'contains_any', value: ['Almaviva', '알마비바'] },
        ],
      }),
      makeExecution({
        toolsUsed: [tool('search_wines', '{"query":"알마비바 2026 빈티지","retrieval_mode":"entity"}')],
      }),
      undefined,
    );

    expect(r.diagnostics?.some((d) => d.code === 'EXPECTED_TOOL_ARG_MISSING')).toBeFalsy();
    expect(evaluatePredicate('알마비바 2026 빈티지', 'contains_any', ['Almaviva', '알마비바'])).toBe(true);
  });

  it('expectedToolArgs: supports equals_any predicate for normalized anchor queries', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        expectedToolArgs: [
          { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['보졸레 누보', 'beaujolais nouveau'] },
        ],
      }),
      makeExecution({
        toolsUsed: [tool('search_wines', '{"query":"보졸레 누보"}')],
      }),
      undefined,
    );

    expect(r.diagnostics?.some((d) => d.code === 'EXPECTED_TOOL_ARG_MISSING')).toBeFalsy();
    expect(evaluatePredicate('보졸레 누보', 'equals_any', ['보졸레 누보', 'beaujolais nouveau'])).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// RAGAS dimensions
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

  it('requiredRegister regex check removed in v4 (judge handles semantically) — no diagnostic from this path', () => {
    // v4 STRUCTURAL FIX: requiredRegister regex check removed. Even on step-1+ fallback,
    // there is no REGISTER_MISMATCH diagnostic emitted from scorer — the judge alone evaluates this.
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
    const hasRegisterMismatch = (r.diagnostics ?? []).some((d) => d.code === 'REGISTER_MISMATCH');
    expect(hasRegisterMismatch).toBe(false);
  });
});

// v4: ANSWER_LENGTH_BONUS and ANSWER_TRIVIAL_PENALTY removed entirely.
// scoreAnswerQuality is now purely contract-based. See scorer.ts removal comment.
// The 8 tests below were deleted — they tested behavior that no longer exists.

// ─────────────────────────────────────────────────────────────────────
// Korean CLR (Correct Language Rate) diagnostics
// ─────────────────────────────────────────────────────────────────────


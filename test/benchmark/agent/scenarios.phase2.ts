/**
 * Phase 2 scenarios — multi-turn / session-history dependent.
 *
 * These are excluded from the main suite because they require features that
 * are not yet implemented:
 *   - session_history tool
 *   - multi-turn context propagation
 *   - relative reference resolution against past results
 *
 * Loaded only by `runner.ts --include-phase2`. Keeps the main suite's
 * skip rate near 0% so byTier averages aren't diluted.
 *
 * Each scenario is fully specified (SOTA++): rubric, budget constraints,
 * expected tools, answer contracts. Only the `skip` flag gates execution.
 */

import type { AgentBenchmarkScenario } from './scenario.js';

export const PHASE2_SCENARIOS: readonly AgentBenchmarkScenario[] = [
  {
    id: 11,
    tier: 'complex_reasoning',
    query: '작년에 마셨던 그 이탈리아 와인이랑 비슷한데 좀 더 저렴한 거',
    description: 'Session reference + similar + cheaper',
    expectation: {
      maxSteps: 4,
      maxDurationMs: 20_000,
      maxTotalTokens: 8_000,
      tools: [{ tool: 'search_wines', inputContains: ['italy', 'italian'] }],
      answerMustMatch: ['(이탈리아|italy|italian)', '(저렴|싸|cheap|less\\s+expensive)'],
      rubric:
        'Must resolve the session reference ("작년에 마셨던") to a specific wine from session history, '
        + 'then recommend similar Italian wines at a lower price point. '
        + 'Must NOT ignore the session context or recommend random wines.',
    },
    skip: 'Requires session_history tool (Phase 2)',
  },
  {
    id: 16,
    tier: 'conversational',
    query: '레드 와인 추천해줘',
    description: 'Multi-turn: initial → filter → similar',
    expectation: {
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      tools: [{ tool: 'search_wines' }],
      answerMustMatch: ['(레드|red)'],
      rubric:
        'First turn: recommend red wines. Subsequent turns should narrow based on '
        + 'user filters without re-asking already-answered constraints.',
    },
    skip: 'Multi-turn requires Phase 2',
  },
  {
    id: 17,
    tier: 'conversational',
    query: '10만원 이하 와인',
    description: 'Multi-turn: budget → adjust → check',
    expectation: {
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      tools: [{ tool: 'search_wines' }],
      priceBandKrw: { max: 100_000 },
      rubric:
        'First turn: recommend wines under 100,000 KRW. Must maintain budget '
        + 'constraint across follow-up turns when user adjusts preferences.',
    },
    skip: 'Multi-turn requires Phase 2',
  },
  {
    id: 18,
    tier: 'conversational',
    query: '치즈 페어링',
    description: 'Multi-turn: pairing chain',
    expectation: {
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      tools: [{ tool: 'get_food_pairings', inputContains: ['cheese'] }],
      answerMustMatch: ['(치즈|cheese)'],
      rubric:
        'First turn: recommend wines that pair with cheese. Follow-up turns should '
        + 'refine the pairing (specific cheese type, price, etc.) using prior context.',
    },
    skip: 'Multi-turn requires Phase 2',
  },
  {
    id: 36,
    tier: 'relative_reference',
    query: '아까 추천해준 거보다 더 드라이한 거',
    description: 'Session ref + drier',
    expectation: {
      maxSteps: 3,
      maxDurationMs: 15_000,
      maxTotalTokens: 6_000,
      tools: [{ tool: 'search_wines' }],
      answerMustMatch: ['(드라이|dry)'],
      rubric:
        'Must resolve "아까 추천해준 거" to a previously recommended wine from session, '
        + 'then find wines drier than that baseline. Must NOT ignore the comparative reference.',
    },
    skip: 'Requires session_history (Phase 2)',
  },
  {
    id: 37,
    tier: 'relative_reference',
    query: '이거보다 타닌 좀 더 있는 걸로',
    description: 'Relative tannin comparison',
    expectation: {
      maxSteps: 3,
      maxDurationMs: 15_000,
      maxTotalTokens: 6_000,
      tools: [{ tool: 'search_wines' }],
      answerMustMatch: ['(타닌|tannin)'],
      rubric:
        'Must resolve "이거" to the current context wine and recommend wines with '
        + 'higher tannin. The comparison must be relative, not absolute.',
    },
    skip: 'Requires session_history (Phase 2)',
  },
  {
    id: 38,
    tier: 'relative_reference',
    query: '저번에 산 거 다시 찾아줘, 이름이 뭐였더라... 라벨이 빨간색이었는데',
    description: 'Session fuzzy recall',
    expectation: {
      maxSteps: 3,
      maxDurationMs: 15_000,
      maxTotalTokens: 6_000,
      tools: [{ tool: 'search_wines' }],
      rubric:
        'Must attempt to resolve the fuzzy session reference using label color and '
        + 'purchase history. Should present candidates if exact match uncertain. '
        + 'Must NOT fabricate a wine name to satisfy the request.',
    },
    skip: 'Requires session_history (Phase 2)',
  },
  {
    id: 49,
    tier: 'negation',
    query: '어제 마신 거 빼고 비슷한 거 더 추천해줘',
    description: 'Exclude previous + similar',
    expectation: {
      maxSteps: 3,
      maxDurationMs: 15_000,
      maxTotalTokens: 6_000,
      tools: [{ tool: 'search_wines' }],
      rubric:
        'Must exclude the previously consumed wine(s) from session history and '
        + 'recommend similar alternatives. The excluded wine must NOT appear in recommendations.',
    },
    skip: 'Requires session_history (Phase 2)',
  },
  {
    id: 55,
    tier: 'extreme',
    query: '작년에 마셨던 이탈리아 와인이랑 비슷한 스타일인데, 가격은 좀 더 저렴하고, 타닌은 약하고, 지금 마시기 좋은 시기인 것만, 스테이크랑 어울리는 걸로',
    description: '5-condition chain with session reference',
    expectation: {
      maxSteps: 5,
      maxDurationMs: 30_000,
      maxTotalTokens: 12_000,
      tools: [{ tool: 'search_wines' }],
      drinkingWindowStatus: 'now',
      answerMustMatch: ['(이탈리아|italy|italian)', '(스테이크|steak)'],
      rubric:
        'Must satisfy ALL 5 conditions: (1) similar to session-reference Italian wine, '
        + '(2) cheaper, (3) low tannin, (4) currently at drinking peak, (5) pairs with steak. '
        + 'Each condition must be explicitly addressed in the answer.',
    },
    skip: 'Requires session_history (Phase 2)',
  },
  {
    id: 101,
    tier: 'adversarial',
    severity: 'minor',
    query: '아니 그거 말고 다른 거',
    description: 'Vague rejection without context — must ask clarification',
    expectation: {
      maxSteps: 2,
      maxDurationMs: 8_000,
      maxTotalTokens: 3_000,
      mustNotCallTools: ['search_wines', 'compare_wines', 'get_food_pairings', 'check_drinking_window'],
      requireHedging: true,
      answerMustMatch: ['(어떤|구체적|명확|which|specify|clarif|뭘|무엇)'],
      rubric:
        'Without session context, "그거" is unresolvable. Agent must ask for '
        + 'clarification rather than guessing or calling tools blindly. '
        + 'Must NOT fabricate a previous recommendation.',
    },
    skip: 'Requires multi-turn context (Phase 2)',
  },
];

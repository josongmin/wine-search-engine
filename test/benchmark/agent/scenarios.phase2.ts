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
 */

import type { AgentBenchmarkScenario } from './scenario.js';

export const PHASE2_SCENARIOS: readonly AgentBenchmarkScenario[] = [
  {
    id: 11,
    tier: 'complex_reasoning',
    query: '작년에 마셨던 그 이탈리아 와인이랑 비슷한데 좀 더 저렴한 거',
    description: 'Session reference + similar + cheaper',
    expectation: { maxSteps: 4 },
    skip: 'Requires session_history tool (Phase 2)',
  },
  {
    id: 16,
    tier: 'conversational',
    query: '레드 와인 추천해줘',
    description: 'Multi-turn: initial → filter → similar',
    expectation: { maxSteps: 2 },
    skip: 'Multi-turn requires Phase 2',
  },
  {
    id: 17,
    tier: 'conversational',
    query: '10만원 이하 와인',
    description: 'Multi-turn: budget → adjust → check',
    expectation: { maxSteps: 2 },
    skip: 'Multi-turn requires Phase 2',
  },
  {
    id: 18,
    tier: 'conversational',
    query: '치즈 페어링',
    description: 'Multi-turn: pairing chain',
    expectation: { maxSteps: 2 },
    skip: 'Multi-turn requires Phase 2',
  },
  {
    id: 36,
    tier: 'relative_reference',
    query: '아까 추천해준 거보다 더 드라이한 거',
    description: 'Session ref + drier',
    expectation: { maxSteps: 3 },
    skip: 'Requires session_history (Phase 2)',
  },
  {
    id: 37,
    tier: 'relative_reference',
    query: '이거보다 타닌 좀 더 있는 걸로',
    description: 'Relative tannin comparison',
    expectation: { maxSteps: 3 },
    skip: 'Requires session_history (Phase 2)',
  },
  {
    id: 38,
    tier: 'relative_reference',
    query: '저번에 산 거 다시 찾아줘, 이름이 뭐였더라... 라벨이 빨간색이었는데',
    description: 'Session fuzzy recall',
    expectation: { maxSteps: 3 },
    skip: 'Requires session_history (Phase 2)',
  },
  {
    id: 49,
    tier: 'negation',
    query: '어제 마신 거 빼고 비슷한 거 더 추천해줘',
    description: 'Exclude previous + similar',
    expectation: { maxSteps: 3 },
    skip: 'Requires session_history (Phase 2)',
  },
  {
    id: 55,
    tier: 'extreme',
    query: '작년에 마셨던 이탈리아 와인이랑 비슷한 스타일인데, 가격은 좀 더 저렴하고, 타닌은 약하고, 지금 마시기 좋은 시기인 것만, 스테이크랑 어울리는 걸로',
    description: '5-condition chain',
    expectation: { maxSteps: 5 },
    skip: 'Requires session_history (Phase 2)',
  },
  {
    id: 101,
    tier: 'adversarial',
    query: '아니 그거 말고 다른 거',
    description: 'Vague rejection without context',
    expectation: { maxSteps: 2 },
    skip: 'Requires multi-turn context (Phase 2)',
  },
];

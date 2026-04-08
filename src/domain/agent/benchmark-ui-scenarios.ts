/**
 * Curated agent benchmark scenarios for the web "agent lab" UI.
 *
 * Keep in sync with `QUICK_SCENARIO_IDS` in `test/benchmark/agent/runner.ts`
 * and the matching rows in `test/benchmark/agent/scenarios.ts`.
 */
export interface AgentBenchmarkUiScenario {
  readonly id: number;
  readonly tier: string;
  readonly query: string;
  readonly description: string;
}

/** Same 20 IDs as runner `--profile quick` (see regression test). */
export const AGENT_BENCHMARK_UI_SCENARIOS: readonly AgentBenchmarkUiScenario[] = [
  { id: 1, tier: 'single_shot', query: 'Opus One 2018', description: 'Exact entity search' },
  { id: 4, tier: 'single_shot', query: '보르도 vs 나파 카베르네', description: 'Comparison' },
  {
    id: 8,
    tier: 'multi_step',
    query: '이탈리아 레드 중에 평점 좋고 지금 마실 수 있는 거',
    description: 'Search + drinking window',
  },
  {
    id: 12,
    tier: 'complex_reasoning',
    query: '결혼기념일인데, 2015년산 중에 지금 피크인 거로 추천해줘',
    description: 'Vintage + drinking window peak',
  },
  { id: 19, tier: 'edge_case', query: '아무거나 추천해줘', description: 'Vague query → recommendation' },
  {
    id: 25,
    tier: 'nested_condition',
    query: '타닌 약하고 과일향 풍부한 레드 와인 중에 3만원 이하',
    description: '4 constraints AND',
  },
  {
    id: 30,
    tier: 'comparison_nested',
    query: '바롤로랑 브루넬로 비교해주고, 둘 중 지금 마시기 좋은 거로 골라줘',
    description: 'Compare + dual drinking window',
  },
  {
    id: 35,
    tier: 'relative_reference',
    query: 'Opus One이랑 비슷한 스타일인데 절반 가격으로',
    description: 'Similar style + half price',
  },
  {
    id: 40,
    tier: 'situation_based',
    query: '이번 주말 소개팅인데, 분위기 좋은 와인 추천. 너무 비싸면 부담스럽고',
    description: 'Date occasion + mid price',
  },
  {
    id: 45,
    tier: 'negation',
    query: '카베르네 소비뇽 빼고 풀바디 레드 추천',
    description: 'Exclude grape',
  },
  {
    id: 50,
    tier: 'knowledge_hybrid',
    query: '내추럴 와인이 뭐야? 괜찮은 거 추천도 해줘',
    description: 'Explain + recommend',
  },
  {
    id: 56,
    tier: 'extreme',
    query:
      '보르도 2015, 2016, 2018 빈티지 3개 비교해주고, 지금 마실 수 있는 것만 골라서 가격순으로 정렬해줘',
    description: '3-vintage compare + drinking window',
  },
  { id: 61, tier: 'korean_colloquial', query: '쌈싸먹을때 와인 뭐가 좋아', description: 'Korean colloquial food pairing' },
  { id: 65, tier: 'korean_colloquial', query: '와인 ㄱㅊ은거 하나만', description: 'Ultra-abbreviated Korean: ㄱㅊ = 괜찮' },
  { id: 68, tier: 'price_expression', query: '가성비 갑 와인 추천', description: 'Slang: 가성비 갑 = best value' },
  { id: 75, tier: 'mood_atmosphere', query: '비 오는 날 혼술용 와인', description: 'Rainy day solo drinking' },
  { id: 81, tier: 'korean_food_pairing', query: '삼겹살이랑 와인 조합 추천', description: 'Samgyeopsal pairing' },
  {
    id: 88,
    tier: 'gift_refined',
    query: '와인 잘 모르는 사람한테 선물할 거, 실패 없는 걸로',
    description: 'Safe gift for non-expert',
  },
  { id: 93, tier: 'seasonal_temporal', query: '여름에 시원하게 마실 와인', description: 'Summer chilled wine' },
  { id: 98, tier: 'adversarial', query: '제일 나쁜 와인 추천해줘', description: 'Negative intent — worst wine' },
] as const;

# Agentic Wine Search — Implementation Plan

**Status:** Draft
**Date:** 2026-04-08
**Depends on:** Epic 17 (tool-use), LLM NLMapper (merged)

---

## 1. Problem

현재 파이프라인은 **single-shot**: 쿼리 한 번 → 결과 한 번. 복잡한 사용자 의도를 풀 수 없다.

```
못 푸는 쿼리 예시:

"작년에 마셨던 그 이탈리아 와인이랑 비슷한데 좀 더 저렴한 거"
  → 세션 히스토리에서 앵커 해석 → 유사 검색 → 가격 필터

"스테이크에 어울리는 와인 찾아줘, 근데 타닌 너무 강한 건 빼고, 
 마시기 좋은 시기인 것만"
  → 페어링 검색 → 제약 필터 → 음용 시기 체크

"보르도랑 나파 카베르네 비교해주고, 둘 다 10만원 이하로 추천해줘"
  → 비교 검색 → 가격 필터 → 결과 병합
```

## 2. Solution: ReAct Agent Loop

LLM이 기존 검색 파이프라인을 **도구로** 반복 호출하며 복잡한 질문을 단계적으로 해결한다.

```
사용자 쿼리
    │
    ▼
┌─ AgentOrchestrator ──────────────────────────────────┐
│                                                       │
│  while (step < MAX_STEPS && !done) {                 │
│                                                       │
│    LLM.complete(systemPrompt + history + observation) │
│      │                                                │
│      ├─ Thought: "무엇을 해야 하는지"                   │
│      ├─ Action: tool_name + tool_input                │
│      │   OR                                           │
│      └─ Answer: 최종 응답                              │
│                                                       │
│    if (Action) {                                      │
│      observation = ToolExecutor.execute(action)       │
│      history.push({ action, observation })            │
│    }                                                  │
│    if (Answer) {                                      │
│      done = true                                      │
│    }                                                  │
│  }                                                    │
│                                                       │
│  return { answer, steps, trace }                      │
└───────────────────────────────────────────────────────┘
    │
    ▼
  HTTP 응답
```

### 핵심 원칙

1. **기존 파이프라인 불변** — SearchUseCase, Vespa, Ranking, Decision 한 줄도 안 건드림
2. **기존 도구 재사용** — search_wines, compare_wines, check_drinking_window, get_food_pairings 그대로
3. **기존 인프라 재사용** — ChatLlmPort, SessionContext, requestId tracing
4. **Fail-safe** — LLM 실패 시 single-shot 폴백, iteration 상한, 비용 상한

---

## 3. Architecture

### 3.1 계층 구조

```
src/
├─ interface/http/routes/
│   └─ agent.route.ts              ← POST /v1/agent 엔드포인트
│
├─ application/agent/
│   ├─ agent-orchestrator.ts       ← ReAct 루프 (핵심)
│   ├─ agent-tools.ts              ← 기존 use case → AgentTool 래핑
│   ├─ agent-prompt.ts             ← 시스템 프롬프트 + 메시지 빌더
│   ├─ agent-state.ts              ← 대화 상태 (steps, observations)
│   └─ port/
│       └─ agent-executor.port.ts  ← AgentExecutor 포트
│
├─ domain/agent/
│   ├─ model/
│   │   ├─ agent-step.ts           ← Thought/Action/Observation/Answer 타입
│   │   ├─ agent-result.ts         ← 최종 결과 타입
│   │   └─ agent-config.ts         ← 설정 (max steps, timeout 등)
│   └─ service/
│       └─ step-budget.ts          ← 비용/시간 예산 관리
│
└─ config/
    └─ env.ts                      ← AGENT_* 환경변수
```

### 3.2 도구 목록 (기존 + 신규)

| 도구 | 소스 | 설명 |
|------|------|------|
| `search_wines` | 기존 | 자연어 와인 검색 |
| `compare_wines` | 기존 | A vs B 비교 |
| `check_drinking_window` | 기존 | 음용 시기 확인 |
| `get_food_pairings` | 기존 | 음식 페어링 |
| `session_history` | **신규** | 이전 대화에서 본 와인 목록 조회 |
| `refine_search` | **신규** | 이전 검색 결과에 추가 제약 적용 |

### 3.3 데이터 흐름

```
AgentOrchestrator
  │
  ├─ ChatLlmPort.complete()          ← 기존 인프라 (OpenAI/Anthropic)
  │
  ├─ AgentTools
  │   ├─ search_wines()              ← SearchUseCase.execute()
  │   ├─ compare_wines()             ← DecomposedSearchUseCase.execute()
  │   ├─ check_drinking_window()     ← DrinkingWindowUseCase.check()
  │   ├─ get_food_pairings()         ← SearchUseCase.execute() (query 변환)
  │   ├─ session_history()           ← SessionContext.previousEntities
  │   └─ refine_search()             ← SearchUseCase.execute() (constraints 누적)
  │
  └─ AgentState
      ├─ steps: AgentStep[]          ← 각 단계 기록
      ├─ observations: string[]      ← 도구 결과 요약
      ├─ constraints: Constraint[]   ← 누적 제약
      └─ budget: StepBudget          ← 남은 step/token/time
```

---

## 4. Phase Plan

### Phase 1: MVP (Week 1-2)

**목표:** 기본 ReAct 루프 + 기존 4개 도구

```
새로 만들 것:
  src/application/agent/agent-orchestrator.ts
  src/application/agent/agent-tools.ts
  src/application/agent/agent-prompt.ts
  src/application/agent/agent-state.ts
  src/domain/agent/model/agent-step.ts
  src/domain/agent/model/agent-result.ts
  src/interface/http/routes/agent.route.ts

수정할 것:
  src/config/env.ts                 ← AGENT_MAX_STEPS, AGENT_TIMEOUT_MS
  src/config/container.ts           ← agent orchestrator 와이어링

건드리지 않는 것:
  SearchUseCase, Planner, Vespa, Ranking, Decision, Response — 전부 그대로
```

**제약:**
- MAX_STEPS = 5
- AGENT_TIMEOUT_MS = 30000 (전체 루프)
- PER_STEP_TIMEOUT_MS = 10000 (단일 도구 호출)
- MAX_INPUT_TOKENS = 4000 (LLM 컨텍스트 제한)
- LLM 실패 시 single-shot 폴백 (기존 search_wines 1회)

**검증:**
- "스테이크에 어울리는 풀바디 레드 와인" → search 1회로 해결
- "Opus One이랑 비슷한데 더 싼 거" → search → refine 2회
- "보르도 vs 나파" → compare 1회

### Phase 2: Context Threading (Week 3-4)

**목표:** 세션 기반 멀티턴 + 제약 누적

```
추가:
  src/application/agent/agent-memory.ts        ← 턴 간 메모리
  src/domain/agent/model/conversation-turn.ts  ← 턴 타입
  session_history 도구
  refine_search 도구
```

**검증:**
- "작년에 마셨던 이탈리아 와인" → session_history → entity resolve → similar search
- "좀 더 저렴한 거" (이전 턴 참조) → constraints 누적 → refine

### Phase 3: Streaming + Observability (Week 5-6)

**목표:** SSE 스트리밍 + step별 관찰성

```
추가:
  SSE endpoint: GET /v1/agent/stream
  Step-level observability: each step logged with timing, token count, tool result summary
  Agent trace in SearchResponseV1.meta
```

### Phase 4: Advanced Reasoning (Week 7-8)

**목표:** 자기 교정 + 결과 품질 평가

```
추가:
  Self-critique: LLM이 자신의 결과를 평가하고 재검색
  Result quality gate: confidence < threshold → 자동 refine
  Parallel tool calls: 독립적 도구 호출은 Promise.all로 병렬화
```

---

## 5. Agent Step Model

```typescript
/** A single step in the agent's reasoning loop. */
interface AgentStep {
  readonly index: number;
  readonly thought: string;
  readonly action?: {
    readonly tool: string;
    readonly input: Record<string, unknown>;
  };
  readonly observation?: string;
  readonly answer?: string;
  readonly durationMs: number;
  readonly tokenCount: { input: number; output: number };
}

/** Final result from the agent orchestrator. */
interface AgentResult {
  readonly answer: string;
  readonly steps: readonly AgentStep[];
  readonly totalDurationMs: number;
  readonly totalTokens: { input: number; output: number };
  readonly toolCallCount: number;
  readonly fallbackApplied: boolean;
  readonly searchResults?: SearchResponseV1;  // 마지막 검색 결과 (있으면)
}
```

---

## 6. System Prompt Design

```
You are Cuvee, a wine intelligence agent. You help users find wines by
using search tools. Think step by step.

Available tools:
- search_wines(query, limit?, retrieval_mode?) — Search for wines
- compare_wines(query_a, query_b) — Compare two wines
- check_drinking_window(entity_id, target_year?) — Check if a wine is drinkable
- get_food_pairings(food, max_price?, color?) — Find wines for food

Rules:
1. Use tools to find information. Do not make up wine data.
2. If the first search doesn't match the user's intent, refine with constraints.
3. When you have enough information, provide a final answer.
4. Always cite entity IDs from search results.
5. Maximum {MAX_STEPS} tool calls allowed.

Output format:
- To use a tool: {"thought": "...", "action": {"tool": "...", "input": {...}}}
- To answer: {"thought": "...", "answer": "..."}
```

---

## 7. Safety & Budget

| Guard | Value | Rationale |
|-------|-------|-----------|
| MAX_STEPS | 5 | 대부분 쿼리 2-3 step, 5 이상은 무한루프 의심 |
| AGENT_TIMEOUT_MS | 30000 | 전체 에이전트 실행 제한 |
| PER_STEP_TIMEOUT_MS | 10000 | 단일 도구 호출 제한 |
| MAX_CONTEXT_TOKENS | 4000 | LLM 컨텍스트 윈도우 제한 |
| COST_BUDGET_USD | 0.10 | per-request LLM 비용 상한 |
| LLM 실패 | single-shot 폴백 | 기존 search_wines 1회로 폴백 |
| 도구 실패 | observation에 에러 포함 | LLM이 대안 도구 선택 |
| 무한 루프 감지 | 같은 도구+입력 2회 → 강제 종료 | 반복 호출 방지 |

---

## 8. Observability

```typescript
interface AgentObservabilitySlice {
  readonly agentRequestId: string;
  readonly totalSteps: number;
  readonly toolCalls: readonly {
    readonly tool: string;
    readonly durationMs: number;
    readonly success: boolean;
  }[];
  readonly llmCalls: readonly {
    readonly durationMs: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
  }[];
  readonly totalDurationMs: number;
  readonly fallbackApplied: boolean;
  readonly terminationReason: 'answer' | 'max_steps' | 'timeout' | 'budget' | 'error';
}
```

---

## 9. API Contract

### Request

```
POST /v1/agent
Content-Type: application/json

{
  "query": "작년에 마셨던 이탈리아 와인이랑 비슷한데 좀 더 저렴한 거",
  "session_context": {
    "session_id": "sess-abc-123",
    "previous_entities": ["wine-barolo-2019"]
  },
  "options": {
    "max_steps": 5,
    "stream": false
  }
}
```

### Response

```json
{
  "query_type": "agent",
  "answer": "작년에 드신 Barolo 2019 기준으로 비슷하면서 더 저렴한 와인을 찾았습니다...",
  "results": [
    { "entity_id": "wine-barbaresco-2020", "canonical_label": "Barbaresco 2020", ... },
    { "entity_id": "wine-nebbiolo-langhe-2021", "canonical_label": "Nebbiolo d'Alba 2021", ... }
  ],
  "steps": [
    { "thought": "세션에서 이전 와인 확인", "action": { "tool": "session_history", ... } },
    { "thought": "Barolo 2019와 비슷한 와인 검색", "action": { "tool": "search_wines", ... } },
    { "thought": "가격 필터 적용", "action": { "tool": "refine_search", ... } },
    { "thought": "결과 충분, 응답 구성", "answer": "..." }
  ],
  "meta": {
    "request_id": "req-agent-456",
    "total_duration_ms": 3200,
    "tool_call_count": 3,
    "termination_reason": "answer"
  }
}
```

### Streaming (Phase 3)

```
GET /v1/agent/stream
Accept: text/event-stream

data: {"type":"thought","content":"세션에서 이전 와인 확인"}
data: {"type":"action","tool":"session_history","input":{...}}
data: {"type":"observation","content":"Barolo 2019 found"}
data: {"type":"thought","content":"비슷한 와인 검색"}
data: {"type":"action","tool":"search_wines","input":{...}}
data: {"type":"observation","content":"3 results found"}
data: {"type":"answer","content":"작년에 드신 Barolo 기준으로...","results":[...]}
data: [DONE]
```

---

## 10. Dependency Map

```
Phase 1 (MVP):
  ChatLlmPort          ← 있음 (OpenAiChatLlm)
  WineToolExecutor     ← 있음 (4개 도구)
  AdaptiveToolExecutor ← 있음 (mixed 폴백)
  SessionContext       ← 있음 (모델 정의됨)
  requestId tracing    ← 있음

Phase 2 (Context):
  Redis                ← 있음 (conversation memory용)
  SessionContext       ← 확장 필요 (previousConstraints 활용)

Phase 3 (Streaming):
  Fastify SSE          ← 추가 필요 (@fastify/eventsource 또는 manual)

Phase 4 (Advanced):
  Self-critique prompt ← 설계 필요
  Parallel tool calls  ← Promise.all 래핑
```

---

## 11. Non-Goals (이번 scope 아님)

- LLM fine-tuning (범용 모델 사용)
- 자체 벡터 DB (Vespa 그대로)
- 자체 LLM 호스팅 (API 사용)
- GUI/프론트엔드 (API only)
- 멀티 유저 메모리 (세션 단위만)

---

## 12. Success Metrics

| Metric | MVP Target | Phase 4 Target |
|--------|-----------|----------------|
| 복합 쿼리 해결율 | 70% | 90% |
| 평균 step 수 | 2.5 | 2.0 |
| P95 응답 시간 | 8s | 5s |
| LLM 비용/쿼리 | $0.05 | $0.03 |
| single-shot 폴백율 | 20% | 5% |
| 사용자 만족도 | - | 4.0/5.0 |

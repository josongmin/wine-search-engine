# EPIC-7: Agent Contract Executor 승격

> 상태: 계획  
> 의존: EPIC-2 (ConstraintAtom → precondition 정의), EPIC-4 (공통 provenance / trace vocabulary 참고)  
> 후속: EPIC-8 (fallback_trace, tool invocation plan → Audit Record)

---

## 현재 문제

`AgentOrchestrator`는 예산, 배치 정책, loop detection, synthesis fallback, blocked/error/aborted를 꽤 잘 다루지만 아직은 "강한 ReAct wrapper"에 가깝다:
- `validateParallelBatchPolicy()`가 typed graph가 아닌 코드 흐름으로 배치 제약을 표현
- tool failure, empty result, partial result가 observation 문자열로만 기록 — typed outcome 없음
- fallback search가 reasoning failure를 가리는 경우 발생 (Layer 2가 실패한 것처럼 보이지 않음)
- 같은 질문에 agent step trace가 비결정적 (prompt engineering 의존)

---

## 현재 코드 상태 (직접 확인)

| 항목 | 파일 | 현재 상태 |
|------|------|---------|
| `validateParallelBatchPolicy()` | `agent-orchestrator.ts` | 코드 흐름 기반 — typed graph 아님. 새 도구 추가 시 함수 수정 필요 |
| `AgentStep` / `actionPairs` | `src/domain/agent/model/agent-step.ts` | 단일 액션 / 병렬 액션 / final answer 표현 이미 존재 |
| `PlanStep` IR | — | **별도 타입 없음** — 그러나 `AgentStep`가 부분 substrate 역할 |
| `ToolOutcome` typed | — | **없음** — 도구 결과가 `observation: string`으로만 저장됨 |
| batch 결과 순서 | `agent-orchestrator.ts:787` | index 기준 정렬 — **결정적. 완료** |
| `AgentToolResult` 타입 | `agent-orchestrator.ts:36` | `observation`, `rawResult` 포함. 그러나 `kind` (success/empty/error 등) 없음 |
| `fallbackApplied` 기록 | `agent-orchestrator.ts`, `agent.route.ts` | boolean surface는 이미 응답 schema까지 노출됨. 다만 Layer 2/3/4, reasoningFailure, synthesis failure count는 없음 |
| Synthesis LLM 실패 기록 | — | log에만 남고 response에 없음 |

**핵심 갭:** `validateParallelBatchPolicy()`가 코드 흐름으로 구현되어 있어 새 도구 추가 시 버그 유발 가능.  
`ToolOutcome.kind`가 없어서 "도구가 실행됐지만 결과가 없는 것"과 "도구 자체가 실패한 것"이 같은 observation 문자열로 처리됨.

---

## 목표

agent를 **자유 추론기**에서 **contract executor**로 바꾼다.  
단, 이미 있는 `AgentStep` substrate를 버리고 새 trace 모델을 병렬로 만들지 않는다. incremental하게:

**기존 AgentStep 유지 → typed ToolOutcome 추가 → postcondition 검증 레이어 추가 → 필요한 경우 compatibility PlanStep projection 도입**

---

## 설계

### PlanStep IR (선택: AgentStep compatibility projection)

```typescript
interface PlanStep {
  stepId: string                   // 결정론적 ID (query hash + step index)
  goal: string                     // 이 step이 달성해야 하는 것 (자연어)
  requiredInputs: string[]         // 이전 step 결과 중 필요한 것 (stepId 참조)
  tool: AgentToolName
  toolInput: Record<string, unknown>

  expectedOutputSchema: {
    minResults?: number            // search_wines: 최소 결과 수
    requiredFields?: string[]      // 결과에 반드시 있어야 하는 필드
  }

  fallbackPolicy:
    | { kind: 'retry'; maxAttempts: number }
    | { kind: 'relax_constraints'; hint: string }
    | { kind: 'skip'; reason: string }
    | { kind: 'fail' }
}
```

`PlanStep`이 필요하더라도 이는 **기존 AgentStep을 대체하는 새 truth**가 아니라,
batch policy / postcondition 검증을 위한 compatibility projection이어야 한다.

### ToolOutcome (typed observation 대체)

```typescript
type ToolOutcomeKind =
  | 'success'
  | 'empty_result'         // 검색했지만 결과 0건
  | 'partial_result'       // 결과 있지만 expectedOutputSchema 미충족
  | 'tool_error'           // 도구 실행 자체 실패
  | 'timeout'
  | 'policy_violation'     // validateParallelBatchPolicy 위반

interface ToolOutcome {
  stepId: string
  kind: ToolOutcomeKind
  result?: unknown
  errorMessage?: string
  postconditionViolations?: string[]   // expectedOutputSchema 미충족 항목
  durationMs: number
}
```

### 배치 정책을 typed graph로 표현

```typescript
// 기존: validateParallelBatchPolicy() 코드 흐름
// 변경: BatchPolicy graph

const TOOL_BATCH_POLICY: Record<AgentToolName, {
  canRunWith: AgentToolName[]
  mustRunAlone: boolean
  maxPerBatch: number
}> = {
  search_wines:         { canRunWith: ['get_food_pairings'], mustRunAlone: false, maxPerBatch: 1 },
  compare_wines:        { canRunWith: [], mustRunAlone: true, maxPerBatch: 1 },
  check_drinking_window:{ canRunWith: ['check_drinking_window'], mustRunAlone: false, maxPerBatch: 4 },
  get_food_pairings:    { canRunWith: ['search_wines'], mustRunAlone: false, maxPerBatch: 1 },
}
```

### 루프 수정 계획

```
// 기존 루프 구조 유지하되:

1. LLM 응답 파싱 후 (parseLlmOutput)
   → 기존 `AgentStep` 유지
   → 필요 시 action/actions를 PlanStep projection으로 변환 (신규, 선택)
   → TOOL_BATCH_POLICY graph로 배치 검증 (기존 validateParallelBatchPolicy 대체)

2. 도구 실행 후 (executeAgentTool / executeAgentToolsBatch)
   → ToolOutcome 생성 (신규)
   → postcondition 검증 (신규)
   → fallbackPolicy 평가 (신규)
   → observation 생성은 기존대로 (ToolOutcome 기반)

3. synthesis 단계
   → obsSteps: ToolOutcome[] 기반으로 structured answer composer 호출 (기존 LLM prompt 대체 또는 보강)
```

### Structured Answer Composer

현재 합성은 "observation 문자열 → LLM → answer"인데,  
ToolOutcome이 typed이면 합성 프롬프트를 구조화할 수 있음:

```typescript
interface SynthesisContext {
  query: string
  steps: ToolOutcome[]
  failedSteps: ToolOutcome[]           // kind !== 'success'
  reasoningFailure: boolean            // synthesis LLM 실패 여부
  fallbackApplied: 'layer2' | 'layer3' | 'layer4' | null
}
```

`fallbackApplied`가 더 구조적으로 노출되면 "fallback search가 reasoning failure를 가리는" 문제가 투명해짐.

단, 현재도 boolean `fallbackApplied`는 이미 agent response surface에 있으므로,
EPIC-7의 목표는 이를 새로 추가하는 것이 아니라 **layer/kind/reasoningFailure까지 세분화하는 것**이다.

---

## 완료 조건

- 같은 질문에 `PlanStep[]`이 안정적으로 생성됨 (step trace 결정론성 향상)
- 기존 `AgentStep`과 새 contract layer가 이원화되지 않음
- `ToolOutcome.kind`로 tool failure / empty result / partial result 구별 가능
- `validateParallelBatchPolicy()` 로직이 `TOOL_BATCH_POLICY` graph로 이전됨 — 새 도구 추가 시 코드 흐름이 아닌 graph만 수정
- 기존 `fallbackApplied` boolean 위에 layer/reasoningFailure/severity가 추가되어 fallback 종류를 구별 가능
- `postconditionViolations`가 있는 step은 `fallbackPolicy` 기준으로 처리됨

---

## 영향 받는 파일

| 파일 | 변경 종류 |
|------|---------|
| `src/application/agent/agent-orchestrator.ts` | PlanStep 변환, ToolOutcome 생성, postcondition 검증 |
| `src/domain/agent/model/agent-step.ts` | compatibility projection 또는 typed outcome 연결점 추가 |
| `src/application/agent/plan-step.ts` | **신규 가능** — 단, compatibility projection이어야 함 |
| `src/application/agent/tool-outcome.ts` | **신규** ToolOutcome 타입 |
| `src/application/agent/tool-batch-policy.ts` | **신규** TOOL_BATCH_POLICY graph (validateParallelBatchPolicy 대체) |
| `src/application/agent/synthesis-composer.ts` | **신규** SynthesisContext 기반 structured composer |

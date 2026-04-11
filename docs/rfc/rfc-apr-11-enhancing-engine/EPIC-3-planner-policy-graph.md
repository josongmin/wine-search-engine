# EPIC-3: Planner Policy Trace Instrumentation

> 상태: 계획  
> 의존: EPIC-2 (ConstraintAtom이 Planner에 올라와야 trace가 의미 있음)  
> 후속: EPIC-8 (PolicyDecisionRecord → plannerTrace → Audit Record)

---

## 현재 문제

Planner traceability는 부족하지만, planner substrate 자체는 이미 한 번 분해되어 있다.

- `QueryPlanV2`가 planner understanding을 담고
- `ExecutionCompiler`가 route / retrieval mode / budget을 execution contract로 컴파일하며
- `QueryPlanV2.retrievalPlan`, `constraintExtraction`, `suggestedRoute`, `suggestedRetrievalMode`까지 이미 존재한다

문제는 여기에 **정책 trace만 빠져 있다는 점**이다.

현재는 `materializeQueryPlan()`이 여전히 길고 stage trace를 남기지 않아서:
- 왜 `mixed_query`가 됐는지 역추적 불가
- 왜 `producer_browse`가 아닌 `similar_items`인지 설명 불가
- `decision_trace_ref`, `authority_trace_ref`가 스키마에 있지만 실제 정책 그래프와 연결되지 않음

---

## 현재 코드 상태 (직접 확인)

| 항목 | 파일 | 현재 상태 |
|------|------|---------|
| `QueryPlanV2` | `query-plan.ts` | `constraintExtraction`, `retrievalPlan`, `suggestedRoute`, `suggestedRetrievalMode`까지 이미 존재 |
| `ExecutionCompiler` | `execution-compiler.ts` | planner suggestion → execution contract 분리 구현됨 |
| `materializeQueryPlan()` | `planner.ts` | 10단계 직렬 파이프라인. 각 단계 함수 분리됨 (`detectQueryIntent`, `resolveRoute` 등) |
| `PolicyDecisionRecord` | — | **없음** |
| `plannerTrace` | `QueryPlanV2` | **없음** — `decision_trace_ref`, `authority_trace_ref` 필드는 스키마에 있지만 실제 trace가 연결 안 됨 |
| 각 Stage 반환값 | `planner-intent-detection.ts` 등 | 결과값만 반환. "왜 그 결과인지" 기록 없음 |
| `detectQueryIntent()` | `planner-intent-detection.ts:91–134` | 12개 우선순위 if-else. 첫 hit에서 반환 — 어떤 규칙이 평가됐는지 추적 불가 |

**핵심 갭:** planner graph가 없는 것이 아니라, **기존 planner/compiler 경계에 trace가 없다.**  
`decision_trace_ref`가 있지만 실제로 가리키는 trace 데이터가 없음.

---

## 목표

각 단계가 **왜** 그 결정을 내렸는지 machine-readable trace를 남긴다.  
단, 새 planner graph를 병렬로 만들지 않는다. 기존 `QueryPlanV2` + `ExecutionCompiler`를 SSOT로 유지한 채 각 단계가 `PolicyDecisionRecord`를 뱉는 구조로 간다.

---

## 설계

### PolicyDecisionRecord

```typescript
interface RuleMatch {
  ruleId: string
  description: string
  inputsMatched: Record<string, unknown>
  outcome: string
}

interface RuleMiss {
  ruleId: string
  description: string
  failedCondition: string
}

interface PolicyDecisionRecord {
  stage:
    | 'intent_classification'
    | 'route_resolution'
    | 'retrieval_mode_selection'
    | 'query_class_classification'
    | 'uncertainty_estimation'
    | 'target_entity_inference'
  inputFacts: Record<string, unknown>   // hasStrongAnchor, hasConstraintKeyword 등
  rulesEvaluated: RuleMatch[]           // 평가된 모든 규칙 (순서대로)
  rejectedBranches: RuleMiss[]          // 해당하지 않은 분기와 이유
  decision: string                      // 최종 결정값
  confidence: number
  durationMs?: number
}
```

### QueryPlanV2 확장

```typescript
// 기존 QueryPlanV2에 신규 필드 추가
{
  ...existing,
  plannerTrace?: PolicyDecisionRecord[]   // 각 stage별 결정 기록
}
```

### 각 Stage별 trace 예시

**Intent Classification (Stage 3)**
```
inputFacts:
  hasComparisonMarker: false
  hasAnyAnchor: true          (앵커 신뢰도 0.95)
  hasStrongAnchor: true       (0.95 ≥ 0.85)
  hasConstraintKeyword: true  ("레드", "묵직한")
  hasPriceKeyword: false

rulesEvaluated:
  [Priority 1] comparison_search: hasComparisonMarker && hasAnyAnchor → MISS (hasComparisonMarker=false)
  [Priority 2] comparison_search: anchors.length>=2 → MISS (anchors=1)
  [Priority 3] mixed_query: hasKoreanMixed && hasAnyAnchor → MISS (hasKoreanMixed=false)
  [Priority 4] mixed_query: hasStrongAnchor && hasConstraintKeyword → HIT

decision: 'mixed_query'
```

**Retrieval Mode Selection (Stage 5)**
```
inputFacts:
  intent: 'mixed_query'
  hasAnyAnchor: true
  suggestedRoute: 'mixed'

rulesEvaluated:
  compare_candidates: comparison_search → MISS
  producer_browse: entity_exact|mixed_query + high_confidence + "best wines" → MISS (no "best wines" pattern)
  region_browse: facet|semantic|budget + slash_count>=2 → MISS
  entity_resolution: entity_fuzzy + hasMultipleCandidates → MISS
  entity_lookup: entity_exact + hasStrongAnchor → MISS
  similar_items: mixed_query + hasAnyAnchor → HIT

decision: 'similar_items'
```

### 삽입 위치

```
Planner.materializeQueryPlan() 내부에서
각 Stage 함수(detectQueryIntent, determineRoute, determineRetrievalMode, ...)
호출 후 반환값과 함께 PolicyDecisionRecord를 누적
→ QueryPlanV2.plannerTrace에 배열로 추가

ExecutionCompiler.compile() 에서는
plannerTrace를 복제하지 않고
execution-level override만 별도 decision record로 남김
```

plannerTrace는 기본적으로 `undefined` (생략). `explain=true` 또는 `HTTP_DEBUG_SECRET` 헤더가 있을 때만 포함.

---

## 비목표

- 새 planner graph 레이어를 기존 planner와 병렬로 도입하지 않는다
- `QueryPlanV2` 밖에서 route/mode truth를 다시 계산하지 않는다
- planner와 compiler 각각이 서로 다른 trace truth를 갖지 않는다

## 완료 조건

- "왜 `mixed_query`가 됐는지"를 `plannerTrace[intent_classification].rulesEvaluated`로 재현 가능
- "왜 `entity`가 아니라 `hybrid`인지"를 `plannerTrace[route_resolution]`으로 재현 가능
- "왜 `producer_browse`가 아니라 `similar_items`인지"를 `plannerTrace[retrieval_mode_selection]`으로 재현 가능
- planner trace가 기존 `QueryPlanV2`/`ExecutionCompiler` 계약과 충돌하지 않음

---

## 영향 받는 파일

| 파일 | 변경 종류 |
|------|---------|
| `src/domain/query/service/planner.ts` | 각 Stage에 PolicyDecisionRecord 생성 추가 |
| `src/domain/query/service/execution-compiler.ts` | compiler-level override decision trace 추가 |
| `src/domain/query/service/planner-intent-detection.ts` | 분기 평가 시 RuleMatch/RuleMiss 생성 |
| `src/domain/query/model/query-plan.ts` | `plannerTrace?: PolicyDecisionRecord[]` 추가 |
| `src/domain/query/model/policy-decision-record.ts` | **신규** 타입 정의 |
| `src/application/search/search-usecase-post-route-phase.ts` | explain/debug 게이팅 후 trace 조립 |

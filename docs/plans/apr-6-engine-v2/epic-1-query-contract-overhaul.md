# Epic 1: Query Contract Overhaul

**성격:** must  
**목표:** `QueryPlanV1` 중심 결합을 끊고, planner output과 engine execution contract를 재정의한다.  
**선행조건:** 없음. 단, observability/eval baseline은 유지한다.

---

## 왜 필요한가

현재 레포에서 `QueryPlanV1`은 planner 산출물이라기보다 검색 엔진 전체 공용 IR처럼 쓰이고 있다.  
이 상태에서는 planner를 조금만 바꿔도 resolver, candidate pool, ranking, replay, snapshots가 함께 흔들린다.

이 epic의 목적은 새 필드를 더하는 것이 아니라, **query planning contract의 역할을 다시 정의하는 것**이다.

---

## 목표 상태

```text
HTTP Request
  -> Existing V1 route contract (adapter-compatible)
  -> Internal Request DTO / compiler input V2
  -> Planner Output V2
  -> Engine Execution Contract V2
  -> Route-specific execution inputs
```

핵심은 planner output과 execution input을 같은 타입으로 두지 않는 것이다.

### Public surface rule

Epics 1–5 동안 기존 HTTP route contract는 adapter-compatible하게 유지한다.  
이 epic의 request 작업은 **internal DTO normalization only**이며, public request breaking change는 Epic 6으로 미룬다.

---

## 설계 원칙

1. planner는 “해석 결과”를 낸다.
2. engine은 planner 결과를 “실행 계약”으로 컴파일한다.
3. route, retrieval mode, budget, provenance policy는 execution contract에 속한다.
4. public request contract는 planner 내부 구현 세부를 직접 노출하지 않는다.
5. replay/snapshot도 execution contract 기준으로 비교한다.

### Wave 1 compatibility rule

Wave 1 동안 [interpret.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/interpret.usecase.ts)와 [resolve.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/resolve.usecase.ts)는 public V1 transport를 유지한다.  
즉 planner output 변경은 허용되지만, compatibility adapter 없이 public interpret/resolve transport를 조용히 바꾸면 안 된다.

### Decision/cache narrowing rule

현재 [decision-input.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/decision-input.ts), [authority-trace.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/authority-trace.ts), [cache-service.ts](/Users/songmin/wine-search-engine/src/domain/performance/service/cache-service.ts)는 raw `QueryPlanV1`에 직접 묶여 있다.  
Wave 1의 명시 목표는 이 직접 결합을 줄이는 것이며, 한 번에 제거하지 못하더라도 adapter는 application builder 한 곳에만 허용한다.

---

## 레포에서 건드리는 축

- [query-plan.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-plan.ts)
- [search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/search.usecase.ts)
- [container-usecases.ts](/Users/songmin/wine-search-engine/src/config/container-usecases.ts)
- [search-usecase-pre-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-pre-route-phase.ts)
- [search-usecase-route-resolution.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-route-resolution.ts)
- [search-pipeline-deps.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-pipeline-deps.port.ts)
- [search-request.dto.ts](/Users/songmin/wine-search-engine/src/application/search/search-request.dto.ts)
- [search-usecase-post-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts)
- [search-usecase-decision-input.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-decision-input.ts)
- [search-usecase-decision-snapshot.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-decision-snapshot.ts)
- [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts)
- [decision-input.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/decision-input.ts)
- [authority-trace.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/authority-trace.ts)
- [interpret.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/interpret.usecase.ts)
- [resolve.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/resolve.usecase.ts)
- [search-response-cache.port.ts](/Users/songmin/wine-search-engine/src/domain/performance/port/search-response-cache.port.ts)
- [cache-service.ts](/Users/songmin/wine-search-engine/src/domain/performance/service/cache-service.ts)
- [cache-eligibility.ts](/Users/songmin/wine-search-engine/src/domain/performance/service/cache-eligibility.ts)
- [retrieval-input.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-input.ts)
- [mixed-solver.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/mixed-solver.ts)

---

## In Scope

- planner output 타입 재정의
- execution contract compiler 도입
- route/mode/budget/policy 책임 재배치
- decomposition/search cycle break
- application/runtime boundary migration
- replay / snapshot / cache key alignment
- interpret/resolve/hybrid/search route input 재편
- internal DTO normalization only

## Out Of Scope

- learned sparse 도입
- ranking stage redesign
- Vespa projection migration
- public response family의 최종 분리
- public HTTP request breaking change

---

## 핵심 작업

### Step 1. Execution Contract V2 정의

planner output과 downstream execution input을 분리한다.

예시:

```ts
interface CompiledWineQueryV2 {
  readonly query: QueryUnderstandingSnapshot;
  readonly execution: EngineExecutionContract;
  readonly policy: ExecutionPolicyContract;
}
```

### Step 2. Route/mode 결정 책임 정리

현재 `route`, `retrievalMode`, API override가 여러 단계에 분산되어 있다.  
이를 “planner suggestion”과 “engine effective execution mode”로 분리한다.

### Step 3. Decomposition / search cycle break

[container-usecases.ts](/Users/songmin/wine-search-engine/src/config/container-usecases.ts)의 deferred cycle을 formal adapter boundary로 끊는다.  
`SearchUseCase`와 `DecomposedSearchUseCase`의 mutual dependency는 execution contract migration 전에 정리해야 한다.

### Step 4. Replay / snapshot contract prep

replay/snapshot이 planner raw output이 아니라 execution contract를 기준으로 비교하도록 snapshot contract를 먼저 정리한다.

### Step 5. Application / runtime boundary migration

이 단계는 한 PR로 끝내지 않는다. 아래 세 task로 쪼개는 것이 기본이다.

- `T1.5a` port contract / execute builder migration
- `T1.5b` post-route / decision boundary migration
- `T1.5c` retrieval / mixed runtime boundary migration

container wiring뿐 아니라 application use case orchestration, route execution adapter, mixed/decomposed 경로를 execution contract 기준으로 전환한다.

### Step 6. Replay / snapshot runtime switchover

replay는 planner raw output이 아니라 execution contract를 replay해야 한다.  
이 전환은 snapshot SSOT 준비(`search-usecase-decision-snapshot.ts`, post-route snapshot writer, snapshot store) 이후에만 진행한다.

### Step 7. Route-specific input compiler 도입

entity / hybrid / mixed / compare / browse 류의 입력은 execution contract에서 각 route input으로 컴파일되게 한다.

### Step 8. Internal DTO normalization only

request DTO와 mapper를 execution compiler 기준으로 정리한다.  
이 단계에서는 public route schema를 깨지 않는다.  
특히 [search-request-mappers.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/search-request-mappers.ts)와 request/response schema는 Epic 6 전까지 변경 대상이 아니다.

---

## 브레이킹 허용 시 가능한 것

- `QueryPlanV1`를 deprecated bridge 없이 `V2`로 교체 가능
- internal DTO에서 중복되거나 planner leakage 성격의 필드 정리 가능
- `interpret` 응답도 planner internals dump가 아니라 명시된 explain contract로 재정의 가능

### 브레이킹 표면

- internal TypeScript contracts 전반
- replay fixture / snapshot fixture
- use case orchestration / decomposition adapter boundary
- downstream test helpers
- **public HTTP request contract는 Epic 6 전까지 adapter-compatible 유지**

---

## 검증 전략

- planner/compiler unit tests
- port contract / runtime builder migration tests
- decomposition/search cycle regression tests
- route resolution regression tests
- replay determinism tests
- snapshot parity tests
- interpret / resolve / hybrid contract tests
- cache contract / cache eligibility regression tests

---

## 완료 기준

- planner output과 engine execution input이 타입으로 분리된다.
- route resolution이 단일 compiler stage로 수렴한다.
- replay / snapshot / cache key가 execution contract 기준으로 동작한다.
- `QueryPlanV1` 전역 직접 참조가 대폭 줄고, execution contract boundary가 생긴다.
- container wiring과 route use case port가 새 contract를 기준으로 연결된다.
- 기존 public request surface는 Epic 6 전까지 adapter-compatible하게 유지된다.

---

## 리스크

- refactor 반경이 넓다.
- route별 use case가 모두 영향을 받는다.
- replay와 interpret 계약이 동시에 흔들릴 수 있다.
- decomposition/search cycle이 명시적으로 드러나지 않으면 DAG 전체가 불안정해진다.
- post-route / decision / response helper가 같이 흔들리므로 `T1.5a/T1.5b/T1.5c`를 다시 하나의 과대 PR로 합치면 회귀 원인 분리가 어려워진다.
- decision / authority trace / cache service가 `QueryPlanV1` 직접 의존을 유지한 채 주변만 리팩터링하면 “겉보기 분리, 실제 결합 유지” 상태가 될 수 있다.

이 때문에 다음 epic 전에 먼저 안정화가 필요하다.

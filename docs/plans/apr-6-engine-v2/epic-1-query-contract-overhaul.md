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
  -> Request DTO V2
  -> Planner Output V2
  -> Engine Execution Contract V2
  -> Route-specific execution inputs
```

핵심은 planner output과 execution input을 같은 타입으로 두지 않는 것이다.

---

## 설계 원칙

1. planner는 “해석 결과”를 낸다.
2. engine은 planner 결과를 “실행 계약”으로 컴파일한다.
3. route, retrieval mode, budget, provenance policy는 execution contract에 속한다.
4. public request contract는 planner 내부 구현 세부를 직접 노출하지 않는다.
5. replay/snapshot도 execution contract 기준으로 비교한다.

---

## 레포에서 건드리는 축

- [query-plan.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-plan.ts)
- [search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/search.usecase.ts)
- [search-usecase-pre-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-pre-route-phase.ts)
- [search-usecase-route-resolution.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-route-resolution.ts)
- [search-pipeline-deps.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-pipeline-deps.port.ts)
- [search-request.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-request.schema.ts)

---

## In Scope

- planner output 타입 재정의
- execution contract compiler 도입
- route/mode/budget/policy 책임 재배치
- replay / snapshot / cache key alignment
- interpret/resolve/hybrid/search route input 재편

## Out Of Scope

- learned sparse 도입
- ranking stage redesign
- Vespa projection migration
- public response family의 최종 분리

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

### Step 3. Replay / snapshot 기준 타입 전환

replay는 planner raw output이 아니라 execution contract를 replay해야 한다.

### Step 4. Route-specific input compiler 도입

entity / hybrid / mixed / compare / browse 류의 입력은 execution contract에서 각 route input으로 컴파일되게 한다.

### Step 5. Container / port boundary 정렬

container wiring과 application ports가 planner 결과 대신 execution contract를 기준으로 연결되게 맞춘다.

---

## 브레이킹 허용 시 가능한 것

- `QueryPlanV1`를 deprecated bridge 없이 `V2`로 교체 가능
- request DTO에서 중복되거나 planner leakage 성격의 필드 정리 가능
- `interpret` 응답도 planner internals dump가 아니라 명시된 explain contract로 재정의 가능

### 브레이킹 표면

- internal TypeScript contracts 전반
- replay fixture / snapshot fixture
- search/interpret/resolve request transport 일부
- downstream test helpers

---

## 검증 전략

- planner/compiler unit tests
- route resolution regression tests
- replay determinism tests
- snapshot parity tests
- interpret / resolve / hybrid contract tests

---

## 완료 기준

- planner output과 engine execution input이 타입으로 분리된다.
- route resolution이 단일 compiler stage로 수렴한다.
- replay / snapshot / cache key가 execution contract 기준으로 동작한다.
- `QueryPlanV1` 전역 직접 참조가 대폭 줄고, execution contract boundary가 생긴다.
- container wiring과 route use case port가 새 contract를 기준으로 연결된다.

---

## 리스크

- refactor 반경이 넓다.
- route별 use case가 모두 영향을 받는다.
- replay와 interpret 계약이 동시에 흔들릴 수 있다.

이 때문에 다음 epic 전에 먼저 안정화가 필요하다.

# T-PSA-03 Public Search Path Authority And Planner Scope Reduction

## 목표

public primitive search route의 lane authority를 end-to-end로 고정하고, planner가 similarity heuristic으로 public search semantics를 덮어쓰지 못하게 만든다.

## 현재 근거

- HTTP primitive route는 path-authoritative라고 선언돼 있다: [src/interface/http/routes/primitive-search.route.ts](../../../../src/interface/http/routes/primitive-search.route.ts#L1-L20)
- 하지만 planner는 한국어 similarity marker를 early `mixed_query`로 본다: [src/domain/query/service/planner-intent-detection.ts](../../../../src/domain/query/service/planner-intent-detection.ts#L141-L200)
- current routing은 `mixed_query + anchor -> similar_items`를 강제한다: [src/domain/query/service/planner-routing.ts](../../../../src/domain/query/service/planner-routing.ts#L64-L124)
- constraint parsing 단계는 similarity anchor를 strip한다: [src/domain/query/service/planner.ts](../../../../src/domain/query/service/planner.ts#L1050-L1084)

## 선행 티켓

- [T-PSA-01](./T-PSA-01-deterministic-reference-similarity-primitive.md)

## 정확한 산출물

1. `POST /v1/search/hybrid`
2. `POST /v1/search/semantic`
3. `POST /v1/search/lexical`

위 3개 primitive route가 **caller/path-selected lane**으로 실행된다.

추가 출력:

4. primitive route에서는 planner가 constraint/preference compile 보조만 담당
5. primitive route에서 `mixed_query -> similar_items` 같은 heuristic lane override 금지
6. public route regression rail

## 예상 수정 파일

```text
src/interface/http/routes/search-request-mappers.ts
src/application/search/search-usecase-caller-controlled-plan.ts
src/application/search/search-usecase-pre-route-phase.ts
src/application/search/search-usecase-route-resolution.ts

src/domain/query/service/planner-intent-detection.ts
src/domain/query/service/planner-routing.ts
src/domain/query/service/planner.ts

src/application/search/__tests__/search-usecase-pre-route-phase.test.ts
src/domain/query/service/__tests__/planner-v2.test.ts
test/integration/http/routes/search.route.test.ts
```

## 구현 범위

1. discovery primitive caller-authority hardening
2. planner scope reduction
3. primitive-route regression tests
4. direct/public path observability naming 정리

## 구현 제외 범위

1. agent runtime tool 변경
2. similarity primitive 구현
3. learned retrieval/ranking 개선

## 구조 규칙

1. primitive route lane authority는 path 또는 explicit primitive contract에서만 온다.
2. planner는 primitive route에서 lane을 `mixed`/`similar_items`로 승격시키지 못한다.
3. public search는 non-agentic이어야 하며, composition semantics를 암묵 수행하는 척하면 안 된다.
4. generic public search 품질 개선이 필요하면 retrieval/rerank로 해결하지, heuristic route-magic으로 해결하지 않는다.

## 구현 순서

1. discovery primitive request authority 표면 정리
2. pre-route / route-resolution에서 override 제거
3. planner tests 갱신
4. integration rail 갱신

## 금지사항

1. `"오푸스원 비슷한 와인"`을 public primitive route에서 hidden mixed solver로 우회시키는 것 금지
2. path-authoritative라고 문서만 쓰고 실제 plan은 planner가 다시 결정하게 두는 것 금지
3. agent-only composition semantics를 public primitive route에 몰래 넣는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm exec vitest run src/application/search/__tests__/search-usecase-pre-route-phase.test.ts src/domain/query/service/__tests__/planner-v2.test.ts
pnpm run test:integration:file -- test/integration/http/routes/search.route.test.ts
```

## DoD

1. discovery primitive route는 end-to-end lane authority를 유지한다.
2. planner similarity heuristic이 public primitive route semantics를 override하지 못한다.
3. public-search seam이 non-agentic이라는 계약이 테스트로 고정된다.
4. owner-local proof rail이 green이다.

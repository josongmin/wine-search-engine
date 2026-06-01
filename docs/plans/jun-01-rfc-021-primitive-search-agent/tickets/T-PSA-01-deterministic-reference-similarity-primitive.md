# T-PSA-01 Deterministic Reference-Similarity Primitive

## 목표

free-text heuristic `mixed_query`에 기대지 않고, `entity_id`를 authority로 받는 deterministic `similar_to_entity` primitive를 search core에 추가한다.

## 현재 근거

- anchor similarity는 현재 planner가 `mixed_query -> similar_items`로 암묵 분기한다: [src/domain/query/service/planner-routing.ts](../../../../src/domain/query/service/planner-routing.ts#L64-L124)
- constraint parsing 단계에서 similarity anchor를 strip한다: [src/domain/query/service/planner.ts](../../../../src/domain/query/service/planner.ts#L1030-L1089)
- current anchor-similarity 실행은 `mixed-solver`에 묶여 있다: [src/domain/mixed/service/mixed-solver.ts](../../../../src/domain/mixed/service/mixed-solver.ts#L98-L254)
- exact primitive의 선행 패턴은 이미 있다: [src/application/search/lookup-wine-execution.ts](../../../../src/application/search/lookup-wine-execution.ts#L1-L98)

## 선행 티켓

- 없음

## 정확한 산출물

1. internal primitive `similar_to_entity(entity_id, limit?, filters?, preferences?)`
2. primitive input contract:
   - free-text anchor 금지
   - `entity_id` 필수
   - optional structured filters만 허용
3. `lookup_wine`와 같은 caller/path-authoritative execution plan
4. deterministic ranking invariants:
   - same entity exclusion
   - near-duplicate suppression
   - anchor provenance trace
5. owner-local unit rail

## 예상 수정 파일

```text
src/application/search/reference-similarity-execution.ts
src/application/search/search-tool-contract.ts
src/application/search/agent-tool-request-adapter.ts
src/application/search/search-usecase-caller-controlled-plan.ts
src/application/search/search-request.dto.ts

src/domain/query/model/retrieval-mode.ts
src/domain/retrieval/service/candidate-pool.ts
src/domain/retrieval/service/live-retrieval-policy-registry.ts
src/domain/ranking/service/signal-computer.ts

src/interface/claude-tools/tool-executor.ts

src/application/search/__tests__/reference-similarity-execution.test.ts
src/domain/retrieval/service/__tests__/candidate-pool-reference-similarity.test.ts
src/interface/claude-tools/__tests__/tool-executor.test.ts
```

## 구현 범위

1. `similar_to_entity` input schema / DTO
2. caller-authoritative execution-plan builder
3. candidate-pool / ranking / provenance wiring
4. tool executor dispatch
5. owner-local regression tests

## 구현 제외 범위

1. public HTTP `/v1/search/similar` 공개
2. agent prompt/tool selection 변경
3. planner heuristic 제거

## 구조 규칙

1. primitive anchor authority는 항상 `entity_id`다.
2. primitive 내부에서 query string을 다시 entity-resolve하는 것 금지.
3. `similar_to_entity`는 `mixed` alias wrapper가 아니라 독립 primitive여야 한다.
4. same entity exclusion은 prompt가 아니라 search core가 보장해야 한다.

## 구현 순서

1. input contract / DTO 추가
2. caller-authoritative plan builder 추가
3. retrieval/ranking/provenance wiring
4. tool executor dispatch 연결
5. unit rail 추가

## 금지사항

1. `similar_to_entity(entity_name: string)` 류 free-text contract 금지
2. `lookup_wine -> query 재조립 -> search_hybrid`를 primitive 구현이라고 포장하는 것 금지
3. same-entity exclusion을 post-hoc prompt filtering으로 처리하는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm exec vitest run src/application/search/__tests__/reference-similarity-execution.test.ts src/domain/retrieval/service/__tests__/candidate-pool-reference-similarity.test.ts src/interface/claude-tools/__tests__/tool-executor.test.ts
```

## DoD

1. `entity_id` authority를 받는 deterministic similarity primitive가 존재한다.
2. primitive 실행이 planner heuristic에 의존하지 않는다.
3. same entity exclusion과 anchor provenance가 search core에서 보장된다.
4. owner-local proof rail이 green이다.

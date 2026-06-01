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

## 반드시 건드릴 파일

1. `src/application/search/search-tool-contract.ts`
2. `src/application/search/search-usecase-caller-controlled-plan.ts`
3. `src/application/search/search-request.dto.ts`
4. `src/domain/retrieval/service/candidate-pool.ts`
5. `src/interface/claude-tools/tool-executor.ts`

## 가능하면 건드리지 말아야 할 파일 / 레이어

1. `src/interface/http/routes/**`
2. `src/application/wine-search/**`
3. `src/domain/query/service/planner-intent-detection.ts`
4. `src/domain/query/service/planner-routing.ts`
5. `data/**`

이 티켓은 primitive 추가 티켓이지, public route/agent/planner cleanup 티켓이 아니다.

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

## 절대 하지 말아야 할 구현

1. `similar_to_entity` 내부에서 `lookup_wine`를 다시 호출하는 구현
2. `similar_to_entity`를 사실상 `search_hybrid` thin wrapper로 만드는 구현
3. primitive 입력에 `query`, `anchor_query`, `anchor_name` 같은 free-text anchor를 다시 노출하는 구현
4. exclusion/diversification을 response post-processing에서만 처리하는 구현

## 실패 패턴

1. 테스트는 통과하지만 실제로는 planner fallback을 타는 경우
2. tool executor는 추가됐는데 candidate-pool/ranking provenance는 기존 `similar_items` 경로를 암묵 공유하는 경우
3. same-entity exclusion이 top-level response projection에서만 일어나는 경우

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

## 리뷰어 체크포인트

1. primitive contract가 `entity_id` 필수인지
2. planner heuristic 없이도 실행 가능한지
3. search core trace에 anchor provenance가 남는지
4. HTTP route/agent runtime을 불필요하게 건드리지 않았는지

## DoD

1. `entity_id` authority를 받는 deterministic similarity primitive가 존재한다.
2. primitive 실행이 planner heuristic에 의존하지 않는다.
3. same entity exclusion과 anchor provenance가 search core에서 보장된다.
4. owner-local proof rail이 green이다.

# T-E2-02 Compiled-Required Post-Route And Ranking Contract

## 목표

`post-route`, `ranking`, `response` 계층의 타입 계약을 `compiled required` 기준으로 재정렬한다.

## 현재 근거

- route resolution은 이미 compiled required다: [search-usecase-route-resolution.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-route-resolution.ts:37>)
- response engine decision은 typed route/mode를 쓴다: [engine-decision.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/response/model/engine-decision.ts:22>), [engine-decision.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/response/model/engine-decision.ts:76>)
- response builder는 execution contract projection을 받는다: [response-builder.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/response/service/response-builder.ts:99>)

## 선행 티켓

- [T-E2-01 remove-residual-compiled-fallback-reads](./T-E2-01-remove-residual-compiled-fallback-reads.md)

## 정확한 산출물

1. post-route/ranking helper 시그니처의 `compiled required` 타입 변경
2. nullable `compiled`를 넘기던 호출부 정리
3. compiled 부재를 explicit test seam으로만 허용하는 테스트

## 구현 범위

1. `SearchRouteExecutionResult`와 관련 helper가 compiled-derived execution facts를 항상 포함하도록 타입을 좁힌다.
2. post-route 입력 타입에서 `compiled optional`을 제거하거나 explicit deprecated seam으로 분리한다.
3. explain/audit/meta 모두 compiled execution contract를 canonical source로 문서화한다.

## 수정 대상 파일

- [search-usecase-route-dispatch.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-route-dispatch.ts:23>)
- [search-usecase-post-route-phase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts:1081>)
- [response-builder.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/response/service/response-builder.ts:99>)
- [engine-decision.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/response/model/engine-decision.ts:14>)
- 테스트: [search-usecase-post-route-phase.test.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/unit/application/search/search-usecase-post-route-phase.test.ts:991>)

## 수정 금지 범위

- `CompiledWineQuery` shape 자체 변경
- decision vocabulary rename
- fixture schema overhaul

## 예상 충돌 파일

- [search-usecase-route-dispatch.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-route-dispatch.ts:23>)
- [search-usecase-post-route-phase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts:1081>)
- [response-builder.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/response/service/response-builder.ts:99>)

## 착수 전 확인

```bash
rg -n "effectiveRetrievalMode|retrievalKind|usedCompiledExecution|sparseExecuted" \
  src/application/search src/domain/response src/domain/audit
```

확인할 것:
- execution facts가 여러 surface에 흩어져 있음
- 이번 티켓은 optionality와 source-of-truth를 통일하는 작업임

## 구현 단계

1. `SearchRouteExecutionResult`에서 execution facts를 optional이 아니라 route-specific required shape로 재정의한다.
2. entity/hybrid/mixed 각각 어떤 facts를 반드시 제공해야 하는지 타입으로 못 박는다.
3. response builder와 engine decision projection이 그 타입을 그대로 소비하게 맞춘다.
4. audit/meta projection 문서와 tests를 같은 vocabulary로 정리한다.

## 작업 중단 조건

1. production search path 밖의 tooling/seeding 코드가 이 helper를 공유하면서 compiled-less를 강하게 요구함
2. `compiled required`로 바꾸면 하나의 티켓으로 닫기 어려운 대규모 fixture format 변경이 연쇄적으로 발생함

## 롤백 기준

- nullable signature를 없애는 대신 `undefined`를 계속 허용하는 우회형 overloading만 남게 될 때
- production path와 test seam 분리가 실패해서 조건 분기가 더 늘어날 때

## 금지사항

- response layer에서 execution facts를 다시 추론하지 말 것
- route별 ad hoc string field를 새로 만들지 말 것

## 수용 예시

- 수용:
  - `SearchRouteExecutionResult`를 받으면 response layer는 projection만 함
- 비수용:
  - response builder가 `route`만 보고 retrieval kind를 다시 계산함

## 테스트

- type-level contract tests
- response builder integration tests
- post-route route/mode provenance snapshot tests

## 검증 명령

```bash
pnpm exec tsc --noEmit --pretty false --incremental false
pnpm exec vitest run --config config/vitest/dev.config.ts \
  test/unit/application/search/search-usecase-post-route-phase.test.ts \
  test/unit/response/response-builder.test.ts \
  src/interface/http/schemas/__tests__/search-response-v1.schema.test.ts
```

## 머지 전 체크리스트

- [ ] execution fact optionality가 route별 타입으로 고정됨
- [ ] response/meta/audit가 같은 vocabulary를 사용함
- [ ] 추론 로직이 projection 로직으로 바뀜

## 완료 조건

- ranking/post-route/response layer에서 compiled optional access가 production signature에서 사라진다.

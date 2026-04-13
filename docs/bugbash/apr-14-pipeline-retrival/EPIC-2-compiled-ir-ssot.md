# EPIC-2 Compiled IR SSOT

## 문제 정의

search runtime은 이미 compiled-first로 이동했지만, 아직 `plan`과 `compiled`가 동시에 execution truth처럼 남아 있는 seam이 있다. 이 split-brain은 route, retrieval mode, provenance policy, structured filters 해석을 다시 어긋나게 만든다.

## 현재 코드 근거

- structured filters 병합 후 `plan.constraints`와 `compiled.query.constraints/retrievalPlan`를 같이 만지는 흐름이 존재한다: [search-usecase-pre-route-phase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-pre-route-phase.ts:181>), [search-usecase-pre-route-phase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-pre-route-phase.ts:229>)
- route resolution은 compiled execution contract를 요구한다: [search-usecase-route-resolution.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-route-resolution.ts:7>)
- response layer는 execution contract를 이미 meta로 받는다: [response-builder.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/response/service/response-builder.ts:99>)
- engine decision은 plannerSuggestedMode를 retrieval mode vocabulary로 표면화한다: [engine-decision.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/response/model/engine-decision.ts:76>)

## 목표 불변식

1. production runtime은 `CompiledWineQuery` 없이는 search를 실행하지 않는다.
2. `plan.constraints`와 `compiled.query.constraints/retrievalPlan`은 한 요청 안에서 항상 동기화된다.
3. `plannerSuggestedMode`는 route 문자열이 아니라 execution retrieval mode만 담는다.
4. `QueryPlanV1`는 설명/observability 입력으로만 남고 execution meaning은 compiled로 수렴한다.
5. response / audit / logs / OpenAPI는 동일 execution vocabulary만 표면화한다.

## breaking changes

- production search path에서 `compileFromLegacyPlan()` 제거
- compiled-less route resolution 제거
- execution contract vocabulary를 response/meta/audit/log 전부 동일 타입으로 좁힘
- `QueryPlanV1` route/mode를 execution 의미로 읽는 경로는 전부 금지한다.

## 구현 작업 목록

1. structured filter merge를 pre-route SSOT 단계로 명확히 올리고, 이후는 compiled만 execution source로 사용한다.
2. `buildSearchRouteResolutionContext()` 이하의 helpers에서 `plan.route`/`plan.retrievalMode` 재유도 코드를 없앤다.
3. response/audit/meta에 남은 route string / retrieval mode string drift를 execution contract enum으로 통일한다.
4. compiled 부재는 test seam이나 explicit fixture seam에서만 허용한다.
5. OpenAPI / schema / audit extension까지 `QueryRoute`, `ExecutionRetrievalMode`, execution trace block을 동일 vocabulary로 고정한다.

## 테스트 / 게이트

- structured filters가 plan / compiled / retrievalPlan에 동일 반영
- compiled 없는 production path 실패
- `plannerSuggestedMode`가 route 문자열을 반환하지 않음
- response/meta/audit execution contract type snapshot
- OpenAPI/schema execution contract snapshot

## merge 조건

- production search runtime에서 compiled-less path가 제거된다.
- execution contract를 읽을 때 더 이상 V1 route/mode fallback이 없다.
- public surface에 자유 문자열 route/mode vocabulary가 남아 있지 않다.

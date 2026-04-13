# EPIC-9 Public Surface / Client Contract Discipline

## 문제 정의

server 내부 contract를 정리해도, API response / audit / web client가 서로 다른 happy-path 가정과 debug 기본값을 품으면 사용자 surface에서 다시 의미가 틀어진다. 특히 comparison/search union, explain 기본 on, URL/input state drift 같은 문제는 runtime invariant를 직접 깨지는 않더라도 public contract를 지속적으로 오염시킨다.

## 현재 코드 근거

- web search results view는 `comparison`을 보지만, 그 전에 `results.length`와 `engine_decision`을 search happy-path로 가정한다: [search-results-view.tsx](</Users/songmin/Documents/code-wine/wine-search-engine/web/src/widgets/search-results/ui/search-results-view.tsx:84>)
- search input은 URL을 초기값으로만 사용해 back/forward나 chip navigation과 drift할 수 있다: [search-input.tsx](</Users/songmin/Documents/code-wine/wine-search-engine/web/src/features/search-bar/ui/search-input.tsx:23>)
- client query hook은 1글자 query를 차단하고 explain을 기본 on으로 보낸다: [use-search.ts](</Users/songmin/Documents/code-wine/wine-search-engine/web/src/features/search-bar/model/use-search.ts:31>), [use-search.ts](</Users/songmin/Documents/code-wine/wine-search-engine/web/src/features/search-bar/model/use-search.ts:35>)
- response surface는 `plannerSuggestedMode`, `route`, `engine_decision`, `audit_extension`의 경계가 여전히 해석 비용을 요구한다: [response-builder.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/response/service/response-builder.ts:244>), [audit-extension.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/audit/model/audit-extension.ts:67>)

## 목표 불변식

1. public API는 comparison/search union을 타입 수준에서 명확히 구분한다.
2. web client는 URL/query/result contract를 server와 동일 semantics로 유지한다.
3. explain/debug payload는 opt-in이며 일반 사용자 기본 경로를 오염시키지 않는다.
4. stable public contract와 debug/audit sidecar contract는 책임이 분리된다.

## breaking changes

- client는 search/comparison union을 별도 분기 타입으로 처리한다.
- `explain` 기본값은 off가 되며 debug opt-in 경로에서만 활성화된다.
- 1글자 query 허용 여부는 server contract와 동일 기준으로 통일된다.
- response meta와 audit/debug 확장 surface의 책임을 명시적으로 분리한다.

## 구현 작업 목록

1. comparison/search response union을 OpenAPI, shared client types, web rendering에서 동일 discriminant로 고정한다.
2. web search input state를 URL source-of-truth 또는 동기화된 state machine으로 재구성한다.
3. `use-search`의 `explain: true` 기본값과 `safeQuery.length >= 2` 같은 client-only gating을 제거하고 server contract로 수렴시킨다.
4. `response.meta`는 stable public execution facts만 담고, `audit_extension`은 debug/observability sidecar로 역할을 축소한다.
5. comparison/search 각 route의 rendering assumptions를 분리해 `results.length`, `engine_decision` 접근이 union-safe 하게 동작하도록 정리한다.

## 테스트 / 게이트

- comparison/search union 타입 회귀 테스트
- URL/input/back-forward 동기화 테스트
- explain opt-in 기본값 테스트
- 1글자 query client/server contract parity 테스트
- response meta vs audit_extension schema responsibility 테스트

## merge 조건

- public API와 web client가 더 이상 서로 다른 query/result semantics를 독자 해석하지 않는다.
- debug/audit surface가 stable public contract를 다시 정의하지 않는다.

# T-E9-01 Comparison/Search Union-Safe Client

## 목표

web client가 comparison/search union을 타입 안전하게 처리하도록 고친다.

## 현재 근거

- client는 comparison 여부를 보지만 그 전에 `results.length`, `engine_decision`을 search happy-path로 읽는다: [search-results-view.tsx](</Users/songmin/Documents/code-wine/wine-search-engine/web/src/widgets/search-results/ui/search-results-view.tsx:84>)

## 선행 티켓

- 없음. 독립 착수 가능

## 정확한 산출물

1. comparison/search union-safe client 타입
2. unsafe render path 제거 코드
3. comparison 응답 회귀 테스트

## 구현 범위

1. shared client response type를 discriminated union으로 재정의한다.
2. `SearchResultsView`를 union-safe rendering으로 재구성한다.
3. `engine_decision`, `results`, `clarification` 접근을 branch-safe 하게 만든다.

## 수정 대상 파일

- [search-results-view.tsx](</Users/songmin/Documents/code-wine/wine-search-engine/web/src/widgets/search-results/ui/search-results-view.tsx:84>)
- web shared API/result types
- 필요 시 comparison table/search result card components

## 수정 금지 범위

- API response envelope 변경
- search results UI 전면 재디자인
- explain/debug surface 변경

## 예상 충돌 파일

- [search-results-view.tsx](</Users/songmin/Documents/code-wine/wine-search-engine/web/src/widgets/search-results/ui/search-results-view.tsx:84>)
- client response types
- web search integration tests

## 착수 전 확인

```bash
rg -n "result_type|engine_decision|results.length|comparison" web/src
```

## 구현 단계

1. server response discriminant를 먼저 확인하고 shared type을 정리한다.
2. render entrypoint에서 union narrowing을 먼저 수행한다.
3. search-only assumptions는 search branch로 이동한다.

## 작업 중단 조건

1. union-safe 처리를 하려면 API contract 자체를 바꿔야 함
2. client 타입 생성 체계가 현재 수동 선언이 아니라 별도 codegen 파이프라인을 요구함

## 롤백 기준

- comparison payload를 여전히 search happy-path에서 읽는 분기가 남는 경우
- 런타임 `if ('results' in data)` 같은 ad hoc 방어만 쌓고 타입은 그대로 두는 경우

## 금지사항

- `as any` / 강제 캐스팅으로 union 문제를 덮지 말 것
- comparison 응답에 fake `engine_decision`을 주입하는 방식 금지

## 수용 예시

- 수용:
  - comparison 응답에서 `MetaBar`가 search-only field를 읽지 않음
- 비수용:
  - optional chaining만 덕지덕지 붙여서 union 문제를 무시

## 테스트

- comparison response render test
- search response render test
- union narrowing type tests

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts \
  test/e2e/server-protocol.test.ts
pnpm run verify:http-contracts
```

## 머지 전 체크리스트

- [ ] union discriminant가 렌더 진입점에서 먼저 처리됨
- [ ] comparison branch는 search-only field 접근 없음
- [ ] shared types가 any-cast 없이 컴파일됨

## 완료 조건

- comparison response가 search happy-path assumption 때문에 깨지지 않는다.

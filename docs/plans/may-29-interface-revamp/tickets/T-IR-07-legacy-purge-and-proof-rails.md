# T-IR-07 Legacy Purge And Proof Rails

## 목표

old route/command/schema/tool surface를 구조적으로 제거하고, 같은 drift가 다시 못 들어오게 proof rail과 banned-surface guard를 추가한다.

## 현재 근거

- current repo에는 old naming과 transitional surface가 여러 레이어에 퍼져 있다.
- route catalog, CLI commands, tool bundle, fixtures, docs가 한 번에 안 닫히면 쉽게 drift가 재발한다.

## 선행 티켓

- [T-IR-01](./T-IR-01-primitive-search-and-lookup-contract-split.md)
- [T-IR-02](./T-IR-02-agent-run-and-turn-contract-split.md)
- [T-IR-03](./T-IR-03-agent-session-store-and-history-custody.md)
- [T-IR-04](./T-IR-04-cli-taxonomy-cutover.md)
- [T-IR-05](./T-IR-05-agent-runtime-tool-taxonomy-realignment.md)
- [T-IR-06](./T-IR-06-client-openapi-eval-and-fixture-cutover.md)

## 정확한 산출물

1. old public surface 삭제
   - `/v1/search`
   - `/v1/search/lookup`
   - `/v1/agent`
   - `search run`
   - `wine-search run`
2. old field 삭제
   - `mode`
   - `retrieval_mode`
   - primitive search의 `sessionContext`
   - primitive search의 `clarification`
3. old tool surface 삭제
   - `search_wines`
   - `get_food_pairings`
   - `check_drinking_window`
   - `compare_wines`
4. banned-surface regression rail
5. closeout verification matrix

## 예상 수정 파일

```text
src/interface/http/**
src/interface/cli/**
src/application/cli/**
src/application/wine-search/**
src/interface/claude-tools/**
web/**
scripts/**
test/**
docs/**
```

## 구현 범위

1. dead file 삭제
2. grep-based banned surface guard 추가
3. contract parity rail 보강
4. docs/help/examples 최종 정리

## 구현 제외 범위

1. 새 기능 추가
2. ranking/eval 알고리즘 개선

## 권장 banned surface 목록

```text
/v1/search"
/v1/search/lookup
/v1/agent"
retrieval_mode
options.mode
search run
wine-search run
search_wines
get_food_pairings
check_drinking_window
compare_wines
auto|entity|mixed
```

검사 시 false positive를 피하려면, expected allowlist를 문서화하고 test에서 path/token 단위로 검사한다.

## 구현 순서

1. dead surface grep 목록 고정
2. code/docs/tests에서 삭제
3. banned-surface rail 추가
4. final verification matrix 실행
5. closeout note 작성

## 금지사항

1. docs만 지우고 코드 surface를 남기는 것 금지
2. 코드만 지우고 fixture/help/OpenAPI를 안 지우는 것 금지
3. legacy string을 compatibility note 명목으로 product docs에 남기는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm run test:integration:file -- test/integration/http/routes/contract-route-discipline.test.ts test/integration/http/routes/public-query-contracts.test.ts test/integration/http/routes/route-contract-registry.test.ts
pnpm exec vitest run src/interface/cli/__tests__/command-registry.test.ts src/interface/http/routes/__tests__/http-contract-openapi-parity.test.ts
pnpm exec vitest run test/e2e/cli-process.test.ts test/e2e/search-api.search.test.ts test/e2e/wine-search-api.test.ts test/e2e/server-protocol.test.ts
rg -n '/v1/search\"|/v1/search/lookup|/v1/agent\"|retrieval_mode|search_wines|wine-search run|search run' src web scripts test docs
```

## DoD

1. old route/command/tool/field surface가 삭제된다.
2. banned-surface rail이 재도입을 막는다.
3. docs/OpenAPI/help/fixtures/tests가 새 taxonomy로만 말한다.
4. targeted proof rail이 green이다.

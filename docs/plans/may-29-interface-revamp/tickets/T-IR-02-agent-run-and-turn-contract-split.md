# T-IR-02 Agent Run And Turn Contract Split

## 목표

`agent` surface를 `single-shot run`과 `turnful session turn`으로 분리하되, 둘의 차이를 history custody 계약으로 고정한다.

## 현재 근거

- current request schema는 `query`와 timeout/budget만 받는다: [src/interface/http/schemas/wine-search.schema.ts](../../../../src/interface/http/schemas/wine-search.schema.ts#L196-L243)
- current route는 `POST /v1/agent` 하나만 등록한다: [src/interface/http/routes/wine-search.route.ts](../../../../src/interface/http/routes/wine-search.route.ts#L59-L77)
- orchestrator input도 `query`, timeout, budget 위주다: [src/application/wine-search/wine-search-orchestrator.ts](../../../../src/application/wine-search/wine-search-orchestrator.ts#L204-L243)

## 선행 티켓

없음

## 정확한 산출물

1. `POST /v1/agent/run`
2. `POST /v1/agent/sessions`
3. `POST /v1/agent/sessions/:sessionId/turns`
4. canonical request model:
   - `messages[]`
   - `context?`
   - `options?`
5. turn response model:
   - `answer`
   - `steps`
   - `tool_calls`
   - `history_applied`
   - `token_usage`
   - `session`
6. existing `POST /v1/agent` 제거

## 예상 수정 파일

```text
src/interface/http/schemas/wine-search.schema.ts
src/interface/http/routes/wine-search.contract.ts
src/interface/http/routes/wine-search.route.ts
src/interface/http/routes/wine-search-route-support.ts
src/interface/http/routes/http-route-contract-catalog.ts

src/application/wine-search/wine-search-orchestrator.ts
src/application/wine-search/wine-search-schemas.ts
src/application/wine-search/wine-search-result-schemas.ts

test/integration/http/routes/wine-search.route.test.ts
test/integration/http/routes/wine-search-timeout-consistency.test.ts
test/integration/http/routes/route-contract-registry.test.ts
test/e2e/wine-search-api.test.ts
test/e2e/wine-search-api-hell-http.test.ts
```

## 구현 범위

1. HTTP path split
2. request/response schema 재정의
3. route-support mapping 갱신
4. orchestrator input contract를 `messages[]` 중심으로 재설계
5. contract/OpenAPI 반영

## 구현 제외 범위

1. session persistence 구현
2. CLI cutover
3. primitive search split

## 구조 규칙

1. `run`과 `session turn`은 같은 runtime을 사용한다.
2. single-shot도 history를 받을 수 있다.
3. history 주입은 explicit field로만 한다.
4. `query` 단일 필드는 canonical contract에서 제거한다.

## 구현 순서

1. 새 request/response shape 고정
2. route contract와 catalog 갱신
3. route handler 분리
4. orchestrator input adaptation layer 추가
5. old `/v1/agent` 제거

## 금지사항

1. `run`과 `turn`에 서로 다른 planner를 두는 것 금지
2. turnful history를 hidden prompt stitching으로만 처리하는 것 금지
3. `/v1/agent`를 alias redirect로 남기는 것 금지
4. session endpoint가 history 적용 내용을 trace 없이 숨기는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm run test:integration:file -- test/integration/http/routes/wine-search.route.test.ts test/integration/http/routes/wine-search-timeout-consistency.test.ts test/integration/http/routes/route-contract-registry.test.ts
pnpm exec vitest run src/application/wine-search/__tests__/wine-search-orchestrator.test.ts src/application/wine-search/__tests__/wine-search-result-schemas.test.ts test/e2e/wine-search-api.test.ts test/e2e/wine-search-api-hell-http.test.ts
```

## DoD

1. `/v1/agent/run`과 `/v1/agent/sessions/:id/turns`가 구분된 public contract를 가진다.
2. request canonical field가 `messages[]`다.
3. run과 turn이 같은 runtime을 공유한다.
4. old `/v1/agent` surface가 제거된다.

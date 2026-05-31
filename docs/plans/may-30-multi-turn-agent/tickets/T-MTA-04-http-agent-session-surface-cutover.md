# T-MTA-04 HTTP Agent Session Surface Cutover

## 목표

HTTP agent surface를 `run`과 `sessions*`로 완성하고, legacy `/v1/agent`를 제거한다.

## 현재 근거

- current server는 `/v1/agent`와 `/v1/agent/run`을 둘 다 등록한다: [src/interface/http/server.ts](../../../../src/interface/http/server.ts)
- session schema는 있으나 session route registration은 없다: [src/interface/http/schemas/agent.schema.ts](../../../../src/interface/http/schemas/agent.schema.ts)
- remote CLI run path도 아직 `/v1/agent`를 호출한다: [src/infrastructure/cli/remote/remote-wine-search-facade.ts](../../../../src/infrastructure/cli/remote/remote-wine-search-facade.ts)

## 선행 티켓

- [T-MTA-01](./T-MTA-01-messages-native-agent-core-and-history-applied-trace.md)
- [T-MTA-02](./T-MTA-02-session-domain-and-history-custody-service.md)
- [T-MTA-03](./T-MTA-03-persistent-session-store-and-container-wiring.md)

## 정확한 산출물

1. `POST /v1/agent/run`
2. `POST /v1/agent/sessions`
3. `POST /v1/agent/sessions/:sessionId/turns`
4. response session block
   - `session_id`
   - `session_version`
   - `turn_index`
5. legacy `POST /v1/agent` 제거
6. remote client `/v1/agent/run` cutover

## 예상 수정 파일

```text
src/interface/http/routes/agent.contract.ts
src/interface/http/routes/agent.route.ts
src/interface/http/routes/agent-session.route.ts
src/interface/http/routes/http-route-contract-catalog.ts
src/interface/http/routes/wine-search.route.ts
src/interface/http/routes/wine-search-route-support.ts
src/interface/http/server.ts
src/interface/http/schemas/agent.schema.ts

src/infrastructure/cli/remote/remote-wine-search-facade.ts
web/src/shared/api/client.ts
web/src/shared/api/types.ts

test/integration/http/routes/agent.route.test.ts
test/integration/http/routes/route-contract-registry.test.ts
test/e2e/wine-search-api.test.ts
test/e2e/wine-search-api-hell-http.test.ts
test/regression/openapi-export-properties.regression.test.ts
```

## 구현 범위

1. HTTP route registration
2. request/response contract 완성
3. route contract catalog/openapi 반영
4. remote client path cutover
5. legacy route 제거

## 구현 제외 범위

1. CLI naming purge
2. provider-edge runtime state seam

## 구조 규칙

1. `/v1/agent/run`만 single-shot canonical path다.
2. session turn route는 store/service 없이는 열지 않는다.
3. response에 `history_applied`와 session meta가 같이 살아야 한다.

## 구현 순서

1. session route contract 추가
2. route registration
3. remote client path correction
4. legacy `/v1/agent` 제거
5. openapi/registry rail 정리

## 금지사항

1. `/v1/agent`를 alias로 남기는 것 금지
2. `/v1/agent/sessions*`를 dummy success로 열어두는 것 금지
3. route가 service/store 규칙을 우회해 자체적으로 version 판단하는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm run test:integration:file -- test/integration/http/routes/agent.route.test.ts test/integration/http/routes/route-contract-registry.test.ts
pnpm exec vitest run test/e2e/wine-search-api.test.ts test/e2e/wine-search-api-hell-http.test.ts test/regression/openapi-export-properties.regression.test.ts
```

## DoD

1. public HTTP surface가 `run`과 `sessions*`만 남는다.
2. legacy `/v1/agent`가 제거된다.
3. remote run path가 `/v1/agent/run`으로 정렬된다.
4. session response meta와 `history_applied`가 contract에 포함된다.

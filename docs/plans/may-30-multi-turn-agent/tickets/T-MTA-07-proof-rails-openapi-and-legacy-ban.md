# T-MTA-07 Proof Rails OpenAPI And Legacy Ban

## 목표

멀티턴 agent cutover를 proof rail, OpenAPI/client parity, banned legacy surface까지 닫는다.

## 현재 근거

- current route tree와 CLI는 partial cutover 상태라 legacy residue가 남아 있다.
- agent run/session 변화는 HTTP, CLI, web client, regression rails를 같이 닫지 않으면 쉽게 drift한다.

## 선행 티켓

- [T-MTA-01](./T-MTA-01-messages-native-agent-core-and-history-applied-trace.md)
- [T-MTA-02](./T-MTA-02-session-domain-and-history-custody-service.md)
- [T-MTA-03](./T-MTA-03-persistent-session-store-and-container-wiring.md)
- [T-MTA-04](./T-MTA-04-http-agent-session-surface-cutover.md)
- [T-MTA-05](./T-MTA-05-cli-agent-parity-and-naming-purge.md)
- [T-MTA-06](./T-MTA-06-session-scoped-runtime-state-and-provider-edge-ownership.md)

## 정확한 산출물

1. unit/integration/e2e/CLI parity rail
2. OpenAPI export parity
3. web client/types parity
4. banned surface grep rail
5. final legacy purge list

## 예상 수정 파일

```text
test/integration/http/routes/agent.route.test.ts
test/integration/http/routes/route-contract-registry.test.ts
test/e2e/wine-search-api.test.ts
test/e2e/wine-search-api-hell-http.test.ts
test/e2e/user-journeys.test.ts
test/regression/openapi-export-properties.regression.test.ts
test/regression/
test/infrastructure/cli/
web/src/shared/api/client.ts
web/src/shared/api/types.ts
web/src/shared/api/__tests__/client.test.ts
test/unit/interface/http/http-route-catalog-openapi-parity.test.ts
```

## 구현 범위

1. agent run/session proof rail
2. local/remote CLI parity rail
3. openapi/client drift closure
4. banned surface grep
   - `/v1/agent` legacy route
   - route/local facade query adapter
   - process-local production store
   - `wine-search` external CLI facade naming

## 구현 제외 범위

1. new feature addition
2. benchmark framework overhaul

## 구조 규칙

1. targeted green과 ambient red를 분리해서 보고한다.
2. proof rail은 owner-local closure를 먼저 증명한다.
3. banned surface rail은 문자열 grep만이 아니라 live registration/behavior도 같이 본다.

## 구현 순서

1. route/openapi tests 정리
2. CLI parity tests 정리
3. web client/types 갱신
4. banned surface rail 추가
5. final closeout matrix 작성

## 금지사항

1. docs만 바꾸고 rail을 안 닫은 채 완료로 선언하는 것 금지
2. legacy surface가 동작하는데 grep만 지워서 통과시키는 것 금지
3. repo-wide red를 targeted green으로 덮는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm run test:integration:file -- test/integration/http/routes/agent.route.test.ts test/integration/http/routes/route-contract-registry.test.ts
pnpm exec vitest run test/e2e/wine-search-api.test.ts test/e2e/wine-search-api-hell-http.test.ts test/e2e/user-journeys.test.ts
pnpm exec vitest run test/unit/interface/http/http-route-catalog-openapi-parity.test.ts test/regression/openapi-export-properties.regression.test.ts
pnpm --dir web test -- src/shared/api/__tests__/client.test.ts
```

## DoD

1. owner-local proof rail이 green이다.
2. OpenAPI/client/CLI parity가 닫힌다.
3. banned legacy surface가 code와 registration 둘 다에서 제거된다.
4. closeout 시 residue가 무엇인지 owner별로 분리 보고할 수 있다.

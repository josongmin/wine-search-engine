# T-IR-06 Client OpenAPI Eval And Fixture Cutover

## 목표

새 `agent/search/lookup` taxonomy를 web client, OpenAPI, eval script, replay fixture, e2e rails까지 전파한다.

## 현재 근거

- declared route catalog는 아직 `/v1/search`, `/v1/search/lookup`, `/v1/agent`를 canonical surface로 잡고 있다: [src/interface/http/routes/http-route-contract-catalog.ts](../../../../src/interface/http/routes/http-route-contract-catalog.ts#L55-L76)
- remote CLI facade도 old path를 친다: [src/infrastructure/cli/remote/remote-search-facade.ts](../../../../src/infrastructure/cli/remote/remote-search-facade.ts#L34-L43), [src/infrastructure/cli/remote/remote-wine-search-facade.ts](../../../../src/infrastructure/cli/remote/remote-wine-search-facade.ts#L42-L54)
- e2e와 replay fixture도 old naming에 결합돼 있다: `test/e2e/search-api.search.test.ts`, `test/e2e/wine-search-api.test.ts`, `test/replay-fixtures/**`

## 선행 티켓

- [T-IR-01](./T-IR-01-primitive-search-and-lookup-contract-split.md)
- [T-IR-02](./T-IR-02-agent-run-and-turn-contract-split.md)
- [T-IR-03](./T-IR-03-agent-session-store-and-history-custody.md)
- [T-IR-04](./T-IR-04-cli-taxonomy-cutover.md)
- [T-IR-05](./T-IR-05-agent-runtime-tool-taxonomy-realignment.md)

## 정확한 산출물

1. OpenAPI catalog와 generated client types가 새 route tree를 반영
2. web API client와 lab/debug UI가 새 path와 DTO를 사용
3. eval script와 replay fixture가 새 request shape를 사용
4. e2e/integration rails가 새 taxonomy를 기준으로 갱신
5. old route name과 payload field에 묶인 test fixture 제거

## 예상 수정 파일

```text
src/interface/http/routes/http-route-contract-catalog.ts
src/interface/http/routes/http-route-contract-openapi.ts
src/interface/http/routes/route-contracts.ts

web/src/shared/api/client.ts
web/src/shared/api/types.ts
web/src/features/**

scripts/eval/**
test/replay-fixtures/**
test/e2e/**
test/integration/http/routes/**
src/interface/http/routes/__tests__/**
src/infrastructure/cli/__tests__/local-remote-parity.test.ts
```

## 구현 범위

1. OpenAPI export 갱신
2. web client/request type 갱신
3. eval/replay fixture JSON 갱신
4. e2e/integration test 이름과 contract 갱신

## 구현 제외 범위

1. primitive search core logic 변경
2. session store 자체 구현
3. agent tool bundle 분해

## 구현 순서

1. route catalog/OpenAPI 반영
2. web client와 generated types 반영
3. eval/replay fixture 갱신
4. e2e/integration rails 갱신
5. old fixtures 삭제

## 금지사항

1. web client가 old path를 hidden compatibility branch로 계속 치는 것 금지
2. fixture가 `query + retrieval_mode` 같은 old request shape를 계속 쓰는 것 금지
3. OpenAPI 문서만 바꾸고 실제 route catalog를 안 맞추는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm run test:unit:file -- test/unit/interface/http/http-route-catalog-openapi-parity.test.ts
pnpm run test:integration:file -- test/integration/http/routes/public-query-contracts.test.ts test/integration/http/routes/route-contract-registry.test.ts
pnpm exec vitest run test/e2e/search-api.search.test.ts test/e2e/wine-search-api.test.ts test/e2e/server-protocol.test.ts test/e2e/schema-contract.test.ts
pnpm --dir web test -- src/shared/api/__tests__/client.test.ts
```

## DoD

1. OpenAPI, web, eval, fixture, e2e가 같은 taxonomy를 본다.
2. old path와 old payload field를 참조하는 fixture가 없다.
3. contract registry와 generated surface가 일치한다.

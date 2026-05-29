# T-IR-01 Primitive Search And Lookup Contract Split

## 목표

`search`를 path-authoritative primitive retrieval surface로 분해하고, `lookup`를 canonical wine resolution endpoint로 승격한다.

이번 티켓의 핵심은 `mode 기반 monolith`를 끊는 것이다.

## 현재 근거

- `SearchRequestSchema`가 `retrieval_mode`를 받는다: [src/interface/http/schemas/search-request.schema.ts](../../../../src/interface/http/schemas/search-request.schema.ts#L114-L139)
- `SearchOptionsSchema.mode`가 `auto | entity | hybrid | mixed`다: [src/interface/http/schemas/search-shared.schema.ts](../../../../src/interface/http/schemas/search-shared.schema.ts#L27-L57)
- lookup도 아직 `/v1/search/lookup` 하위에 매달려 있다: [src/interface/http/routes/lookup.route.ts](../../../../src/interface/http/routes/lookup.route.ts#L15-L63)
- declared catalog도 현재 `/v1/search`, `/v1/search/lookup`을 canonical surface로 본다: [src/interface/http/routes/http-route-contract-catalog.ts](../../../../src/interface/http/routes/http-route-contract-catalog.ts#L55-L76)

## 선행 티켓

없음

## 정확한 산출물

1. `POST /v1/search/hybrid`
2. `POST /v1/search/semantic`
3. `POST /v1/search/lexical`
4. `POST /v1/lookup/wine`
5. search request body에서 `mode`, `retrieval_mode`, `sessionContext`, `clarification` 제거
6. application port에서 primitive별 method 또는 port 분리
7. route catalog/OpenAPI/contract registry의 canonical surface 갱신

## 예상 수정 파일

```text
src/interface/http/routes/search.route.ts
src/interface/http/routes/lookup.route.ts
src/interface/http/routes/route-contracts.ts
src/interface/http/routes/http-route-contract-catalog.ts
src/interface/http/routes/search-request-mappers.ts
src/interface/http/schemas/search-request.schema.ts
src/interface/http/schemas/search-shared.schema.ts

src/application/search/port/search-route-usecases.port.ts
src/application/search/search-request.dto.ts
src/config/container.ts
src/config/container-search-contracts.ts
src/config/container-usecases.ts

test/integration/http/routes/search.route.test.ts
test/integration/http/routes/lookup.route.test.ts
test/integration/http/routes/public-query-contracts.test.ts
test/integration/http/routes/route-contract-registry.test.ts
test/e2e/search-api.search.test.ts
test/e2e/search-api.ops.test.ts
```

## 구현 범위

1. primitive route split
2. primitive별 request schema 분리
3. route contract 분리
4. container wiring 분리
5. OpenAPI catalog 반영

## 구현 제외 범위

1. agent run/session 계약
2. CLI command cutover
3. internal agent tool taxonomy 정렬

## 구조 규칙

1. primitive selector는 path가 authority다.
2. `hybrid`, `semantic`, `lexical`은 서로 다른 public contract다.
3. `lookup`는 search namespace 하위가 아니다.
4. 새 primitive route는 legacy `/v1/search`를 body mode로 우회 호출하면 안 된다.

## 구현 순서

1. primitive request/response contract 초안 고정
2. `search-route-usecases.port` 또는 신규 port에서 primitive별 surface 분해
3. route contract/catalog/OpenAPI 갱신
4. HTTP route handler 구현
5. integration/e2e 갱신
6. legacy `mode` field 삭제

## 금지사항

1. `/v1/search/{primitive}`가 내부에서 `retrieval_mode`만 세팅하고 기존 monolith를 그대로 호출하는 가짜 분해 금지
2. `auto`, `entity`, `mixed`를 새 public contract에 남기는 것 금지
3. primitive search에 `sessionContext` 유지 금지
4. lookup를 `/v1/search/lookup` alias로 계속 남기는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm run test:integration:file -- test/integration/http/routes/search.route.test.ts test/integration/http/routes/lookup.route.test.ts test/integration/http/routes/public-query-contracts.test.ts test/integration/http/routes/route-contract-registry.test.ts
pnpm exec vitest run src/interface/http/routes/__tests__/http-route-contract-openapi.test.ts src/interface/http/routes/__tests__/http-contract-openapi-parity.test.ts test/e2e/search-api.search.test.ts test/e2e/search-api.ops.test.ts
```

## DoD

1. public search primitive는 path만 보고 식별된다.
2. request body에 `mode`, `retrieval_mode`, `sessionContext`, `clarification`이 없다.
3. `lookup`는 `/v1/lookup/wine`으로 승격된다.
4. contract catalog와 OpenAPI가 새 surface를 canonical로 본다.

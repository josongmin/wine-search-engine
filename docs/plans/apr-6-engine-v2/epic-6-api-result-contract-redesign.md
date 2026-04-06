# Epic 6: API / Result Contract Redesign

**성격:** should  
**목표:** human search와 machine/LLM consumption을 구분하는 결과 계약을 설계한다.  
**의존성:** Epic 5

---

## 왜 필요한가

현재 [search-response.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-response.schema.ts)는 풍부하지만, 사람에게 보여줄 카드 결과와 LLM/tool이 소비할 evidence-rich envelope가 같은 계약 안에 섞여 있다.

브레이킹 체인지 허용이라면 이 레이어를 깔끔하게 분리할 수 있다.

이 epic는 **Epics 1–5가 내부 contract migration을 끝낸 뒤, public HTTP surface를 공식적으로 재설계하는 첫 단계**다.

---

## 목표 상태

- public human search response
- machine/LLM retrieval envelope
- interpret/debug/explain response

이 세 계약의 목적을 분리한다.

### Route strategy SSOT

Wave 3에서는 route strategy를 아래로 고정한다.

| Surface | Strategy |
|---|---|
| existing `/v1/search`, `/v1/search/hybrid`, `/v1/search/interpret` | adapter-compatible 유지 |
| new `/v2/search` | `SearchResponseV2Human` 공개 |
| new `/v2/search/hybrid` | `SearchResponseV2Human` 공개 |
| new `/v2/search/interpret` | `InterpretResponseV2` 공개 |
| machine/tool-friendly V2 | Wave 3에서는 새 public search route를 열지 않고 existing `/v1/claude-tools` wrapper + tool executor seam에서 `SearchResponseV2Machine` 공개 |
| `/v1/search/replay`, `/v1/batch-search`, `/v1/entity/resolve` | Epic 6에서는 V1 유지 |

비교 응답(`ComparisonSearchResponse`)은 이번 epic의 주 경로가 아니다.  
`/v1/search` family의 comparison behavior는 adapter-compatible하게 유지하고, V2 comparison family는 follow-on으로 둔다.

---

## 레포에서 건드리는 축

- [route-contracts.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/route-contracts.ts)
- [search-response.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-response.schema.ts)
- [http-route-contract-openapi.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/http-route-contract-openapi.ts)
- [src/interface/http/routes](/Users/songmin/wine-search-engine/src/interface/http/routes)
- [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts)
- [claude-tools.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/claude-tools.route.ts)
- [tool-executor.ts](/Users/songmin/wine-search-engine/src/interface/claude-tools/tool-executor.ts)
- [interpret.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/interpret.usecase.ts)
- [interpret.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/interpret.route.ts)

---

## In Scope

- result contract family 정의
- human vs machine response 구분
- explain / interpret 응답 정리
- OpenAPI and route contract migration

## Out Of Scope

- retrieval/ranking core algorithm 변경
- Vespa projection redesign

---

## 핵심 작업

### Step 1. Versioning / migration matrix + result contract family 정의

기본 전략은 다음으로 고정한다.

| Surface | 전략 |
|---|---|
| existing `/v1/search` family | migration 동안 adapter-compatible 유지 |
| V2 human response | 새 schema / opt-in route family로 병행 공개 |
| V2 machine/LLM response | 새 schema / existing `/v1/claude-tools` wrapper 및 tool executor seam으로 병행 공개 |
| V1 sunset | Epic 6 완료 후 별도 deprecation 문서로 관리 |

- `SearchResponseV2Human`
- `SearchResponseV2Machine`
- `InterpretResponseV2`

### Step 2. Evidence / provenance surfacing 정책 정의

human response엔 요약된 evidence, machine response엔 structured provenance를 준다.

### Step 3. Route surface 재배치

기존 경로를 그대로 버전업할지, 새 route family를 열지 결정한다.

여기서의 기본 결정은 이미 고정한다:

- V1 route family는 유지
- V2 human/interpret는 새 route family로 병행 공개
- V2 machine/LLM은 existing `/v1/claude-tools` wrapper와 tool executor seam에서 공개
- replay / batch / resolve는 Epic 6 범위 밖
- comparison response는 V1 유지

### Step 4. OpenAPI parity 재정렬

새 result family가 OpenAPI와 테스트에 일관되게 반영되게 한다.

### Step 5. Migration story 문서화

기존 route를 유지할지, versioned route를 열지, field-level deprecation을 둘지 명시한다.

## 설계 원칙

1. 내부 retrieval envelope를 그대로 public UX response로 노출하지 않는다.
2. explain/debug 목적 응답은 search UX 응답과 분리한다.
3. schema는 runtime code와 parity를 유지한다.
4. 브레이킹 허용이더라도 migration story는 문서화한다.
5. 기본값은 `existing route adapter-compatible 유지 -> V2 route/schema 병행 공개`다.

---

## LLM Execution Guide

이 epic의 hotspot은 `search-response.schema.ts`, `response-builder.ts`, `route-contracts.ts`, `http-route-contract-catalog.ts`다.  
따라서 schema skeleton, builder split, interpret adapter, route exposure/OpenAPI를 한 PR에 섞지 않는 것이 기본 규칙이다.

### Recommended PR slices

| Task | 닫는 기준 | Must change | Must not change |
|---|---|---|---|
| T6.1 | `SearchResponseV2Human`, `SearchResponseV2Machine`, `InterpretResponseV2` 심볼과 versioning matrix가 코드/문서에 모두 존재 | new V2 schema/model files, schema barrel, migration docs, route contract/catalog skeleton | V1 schema fields, V1 route URLs, runtime builder logic |
| T6.2 | human V2 builder가 UX-oriented summary contract를 생성하고 route exposure 없이 unit/e2e contract 수준에서 닫힘 | `response-builder.ts`, V2 human model/schema, response builder tests | machine/tool envelope, route catalog, OpenAPI path exposure |
| T6.3 | machine V2 builder가 structured provenance envelope를 만들고 existing `/v1/claude-tools` wrapper 안에서 migration seam을 가짐 | `response-builder.ts`, V2 machine model/schema, tool executor, `claude-tools.route.ts`, e2e transport helper/tests | human result summarization, search/hybrid route registration |
| T6.4 | interpret explain adapter가 planner raw dump와 분리되고 V2 explain contract를 준비함 | `interpret.usecase.ts`, V2 interpret schema/tests, explain adapter/mapper | search result card schema, V1 interpret route payload, public route exposure timing |
| T6.5 | route contracts/catalog/OpenAPI bridge가 V2 route family를 반영하고 V1 family는 그대로 유지 | route contracts, route catalog, OpenAPI bridge, search/hybrid/interpret route registration files, claude-tools parity surface, parity tests | response-builder internals, projection vocabulary |
| T6.6 | V1 유지 / V2 공개 / deprecation / tool migration rule이 한 문서 세트로 닫힘 | migration docs and rollout notes | runtime behavior |

### Hotspot ownership

- `T6.1` owns V2 route names and schema symbol names. 뒤 task는 새 이름을 다시 만들지 않는다.
- `T6.2`와 `T6.3`은 builder/model/schema까지만 닫고, 실제 HTTP exposure는 `T6.5`에서만 한다.
- `T6.3`에서 machine V2는 새 `/v2/search/*` route를 만들지 않는다. 필요하면 existing `/v1/claude-tools` wrapper의 `tool_result` typing만 정리한다.
- `T6.4`는 explain contract 전용 prep이다. `response-builder.ts`를 억지로 건드려 search result family와 합치지 않고, `/v1/search/interpret` payload를 여기서 먼저 깨지 않는다.
- `T6.5`는 route catalog/OpenAPI exposure만 다룬다. builder payload 자체를 여기서 다시 설계하지 않는다.
- `T6.6`은 docs only다. schema나 route 코드를 슬쩍 바꾸지 않는다.

### Required verification by slice

- Schema/model slices: `npm run typecheck`, `npm run verify:http-contracts`
- Builder slices: `npm run test:e2e:contract`, `npm run verify:http-contracts`
- Tool/machine slices: `npm run test:e2e:contract`, `npm run test:integration`, `npm run verify:http-contracts`
- Route/OpenAPI slices: `npm run verify:http-contracts`, `npm run test:e2e:contract`, `npm run test:integration`

---

## 완료 기준

- human vs machine result contract가 분리된다.
- evidence/provenance 노출 정책이 계약에 명시된다.
- OpenAPI와 route contracts가 새 응답 표면을 정확히 반영한다.
- 기존 `SearchResponseSchema`의 다목적 과부하가 해소된다.
- versioning / migration matrix가 문서와 계약에 반영된다.

## 검증 전략

- route contract tests
- OpenAPI parity tests
- response schema validation tests
- e2e contract suite
- claude-tools contract regression tests

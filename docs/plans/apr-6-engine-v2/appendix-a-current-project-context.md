# Appendix A: Current Project Context

이 appendix는 `apr-6-engine-v2` 설계 문서가 기대하는 현재 프로젝트 상태를 압축해 적은 것이다.  
세부 SSOT는 코드와 RFC 문서지만, 에픽 설계 판단에는 아래 요약이 충분하도록 구성한다.

---

## 1. 런타임 구조

현재 런타임 composition root는 [container.ts](/Users/songmin/wine-search-engine/src/config/container.ts)다.

- core wiring: query planner, entity resolver, candidate pool, ranker, decision engine, response builder, mixed solver
- feature wiring: search / replay / interpret / resolve / hybrid / decomposed / batch / watchlist / eval
- adapters: Postgres, Redis, Vespa, embedding HTTP, reranker HTTP, optional learned matcher HTTP

중요 포인트:

- 레포는 service locator라기보다 명시적 container wiring 구조다.
- 따라서 “설계는 좋은데 wiring이 숨는다” 류의 리팩터링보다, port/adapter contract를 선명하게 만드는 리팩터링이 맞다.

---

## 2. 검색 엔진 중심부

검색 엔진의 실질적 허브는 [search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/search.usecase.ts)와 [src/application/search](/Users/songmin/wine-search-engine/src/application/search) 폴더다.

현재 흐름:

```text
request
 -> pre-route
 -> route resolution
 -> entity / hybrid / mixed dispatch
 -> post-route
 -> response / cache / snapshot
```

좋은 점:

- pre/post 분리와 dispatch seam이 이미 있다.
- hybrid/mixed/decomposed 특수 경로도 이미 분리돼 있다.

제약:

- 여전히 orchestration contract 대부분이 `application/search`에 집중돼 있다.
- planner output이 runtime 전역 contract처럼 쓰여 하위 계층도 함께 묶인다.

---

## 3. Query / retrieval / ranking 결합 상태

### Query

- `QueryPlanV1`는 planner 결과이자 사실상 runtime-wide IR이다.
- route, retrieval mode, constraints, policy, uncertainty, budget가 모두 여기에 들어 있다.
- replay, snapshot, cache, ranking, mixed solver가 이 타입을 읽는다.

### Retrieval

- candidate generation은 [candidate-pool.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-pool.ts)가 핵심이다.
- sparse + dense + anchor neighborhood + RRF + filter 흐름이 이미 있다.
- specialized browse/compare, similar retrieval도 별도 경로가 존재한다.

### Ranking

- [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts) 중심으로 signal compute -> aggregate -> optional rerank 흐름이 있다.
- LTR와 cross-encoder까지 연결돼 있어 기능은 충분히 풍부하다.
- 다만 stage contract보다는 하나의 orchestrated rank path에 가깝다.

---

## 4. HTTP / 계약 표면

현재 HTTP 표면은 가볍지 않다.

- Fastify
- Zod request/response schemas
- route contract catalog
- OpenAPI bridge/parity tests

핵심 파일:

- [route-contracts.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/route-contracts.ts)
- [search-request.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-request.schema.ts)
- [search-response.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-response.schema.ts)

의미:

- public API 변경은 내부 리팩터링 부산물이 아니라 별도 설계 대상이다.
- schema drift를 허용하는 접근은 이 레포와 맞지 않는다.

### 4.1 현재 LLM / tool surface

이 레포는 이미 human-only 검색 엔진은 아니다.

- [claude-tools.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/claude-tools.route.ts)
- [tool-executor.ts](/Users/songmin/wine-search-engine/src/interface/claude-tools/tool-executor.ts)

기준으로 tool/agent surface가 이미 존재한다.  
다만 현재는 human search response와 machine/tool response가 충분히 분리돼 있지 않아서, Epic 6의 `human vs machine/LLM result contract split`이 현재 구조와 직접 맞닿아 있다.

---

## 5. Index / ETL / Vespa 구조

현재 index projection 계약의 중심은 [retrieval-document.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-document.ts)다.

이 타입은 아래를 연결한다.

- ETL scripts
- Vespa mapping
- runtime search index port
- watchlist-aware search index
- in-memory adapters
- test fixtures
- vespa e2e

핵심 파일:

- [mapping.ts](/Users/songmin/wine-search-engine/src/infrastructure/vespa/mapping.ts)
- [vespa-search-index.ts](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-search-index.ts)
- [index-to-vespa.ts](/Users/songmin/wine-search-engine/scripts/etl/index-to-vespa.ts)
- [vespa-schema.sd](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-schema.sd)

의미:

- index projection 변경은 가능하지만 가장 반경이 크다.
- 그래서 runtime/query/ranking contract가 먼저 정리돼야 한다.

---

## 6. 테스트 / 검증 레인

현재 `package.json` 기준 주요 검증 축:

- `npm run test:unit`
- `npm run test:integration`
- `npm run test:watchlist`
- `npm run test:e2e:contract`
- `npm run test:e2e:runtime`
- `npm run test:e2e:inmemory`
- `npm run test:quality`
- `npm run verify:http-contracts`
- `npm run test:verification:core`
- `npm run test:all`

주의:

- 문서에서 `fast lane`, `runtime lane`, `smoke lane` 같은 별칭만 쓰지 않는다. 항상 `npm run test:e2e:contract`, `npm run test:e2e:inmemory`, `npm run test:e2e:runtime`처럼 실제 실행 스크립트명을 적는다.
- `test:e2e:inmemory`(`e2e.config.ts`)와 `test:e2e:runtime`(`e2e.runtime.config.ts`)은 서로 다른 config를 사용하며, 커버 범위가 다르다.

설계 함의:

- 각 epic는 최소한 unit + relevant integration + contract parity 검증 계획을 가져야 한다.
- projection/API epic는 e2e와 ingest contract까지 같이 봐야 한다.
- 문서에서 `fast lane`, `smoke lane` 같은 별칭만 쓰면 drift가 발생한다. 반드시 `npm run ...` 실 스크립트명을 적는다.

---

## 7. 현재 레포의 강점

1. 구조 분리 자체는 이미 좋다.
2. 검색 스택이 장난감이 아니라 실제 운영 가능한 수준이다.
3. offline eval / noisy entity eval / LTR / reranker / Vespa lane이 있다.
4. bugbash hardening을 거치며 determinism, contracts, watchlist, replay가 강화됐다.

### 7.1 Repo Fit Matrix

| Epic | 현재 레포 적합성 | 이유 |
|---|---|---|
| Epic 1 | highest risk | `QueryPlanV1`가 runtime currency라 blast radius가 가장 큼 |
| Epic 2 | moderate | query domain 자산은 좋지만 planner/compiler 결합을 함께 건드려야 함 |
| Epic 3 | strongest fit | candidate-pool seam이 현재 레포에서 가장 잘 드러남 |
| Epic 4 | strongest fit | Vespa + retrieval layer가 이미 있어 채널 확장이 현실적 |
| Epic 5 | moderate | ranking scaffold는 좋지만 full policy layer는 아직 약함 |
| Epic 6 | moderate | HTTP 계약은 강하지만 migration story를 명시해야 함 |
| Epic 7 | strongest fit | 늦게 가는 게 맞고, highest-radius migration으로 잘 정의 가능 |

---

## 8. 현재 레포의 설계 부채

1. `QueryPlanV1` 전역 결합
2. `application/search` 중심 오케스트레이션 응집
3. candidate provenance contract의 부족
4. ranking stage contract의 부족
5. `RetrievalDocument` projection 계약의 비대화 (주로 retrieval infra + projection 레이어 18개 소스 파일에 집중되나, Vespa mapping · ETL · in-memory adapter · test fixtures를 동시에 건드려야 해서 변경 반경이 크다)

이 다섯 개가 `apr-6-engine-v2`가 해소하려는 핵심 구조 부채다.

---

## 9. v2 설계 시 항상 지킬 것

1. authority와 retrieval signal은 계속 분리한다.
2. public API와 internal execution contract는 구분한다.
3. replay determinism과 snapshot comparability는 유지한다.
4. port/adapter boundary를 흐리는 shortcut을 만들지 않는다.
5. 테스트와 문서 migration을 implementation 뒤에 미루지 않는다.

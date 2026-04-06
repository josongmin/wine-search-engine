# 빠른 색인 (빵꾸·보완점)

**실제 빵꾸만 (현행 SSOT):** [`ACTUAL-GAPS.md`](./ACTUAL-GAPS.md) — 해소 vs 유효 ID 구분, 2026-04-06 코드 재검증.

**플랜·에픽 ↔ 코드 갭 (서술):** [`PLANS-GAP-AUDIT.md`](./PLANS-GAP-AUDIT.md) (v0.1·v0.2 + v0.3 Epic 18 요약)  
**상세:** [`TASKS.md`](./TASKS.md) · [`BACKLOG.md`](./BACKLOG.md)  
**검증 로그:** [`AUDIT-LOG.md`](./AUDIT-LOG.md)  
**병렬 재현 표 (`M-xx` ↔ 이 표 `G-xx`):** [`FINDINGS-MATRIX.md`](./FINDINGS-MATRIX.md)

아래 표는 **역사적 색인**이다. **G-05, G-06, G-10, G-22, G-40, G-43, G-48** 등은 [`ACTUAL-GAPS.md`](./ACTUAL-GAPS.md) 기준 **해소**되었으나, ID 보존·교차 참조를 위해 행을 유지한다.

---

## 해소됨 (2026-04-06 코드 재검증) — 상세는 ACTUAL-GAPS

| ID | 요약 |
|----|------|
| **G-05** | `MAX_QUERY_LENGTH=2000` — HTTP 스키마·`QuerySanitizer` 정렬 (구 “500자 불일치” 감사는 구식). |
| **G-06** | `npm run lint` 통과. |
| **G-10** | `ConstraintSAT` 구현 + `SearchUseCase` 배선. |
| **G-22** | CI `verify-splits` 잡 존재 (`.github/workflows/ci.yml`). |
| **G-40** | `Hybrid` / `Interpret` / `Resolve` — `QueryEntrySecurityGate` 적용. |
| **G-43** | `requestId` → `ResolveUseCase`·응답 반영. |
| **G-48** | `GET /openapi.json` — 잔여는 계약 커버리지 수준. |

---

## ID ↔ 한 줄 (P0 — 측정·온보딩·CI가 깨지기 쉬움)

| ID | 한 줄 | 근거 |
|----|--------|------|
| **G-01** | Planner JSDoc이 “constraints placeholder”라고 하나 **실제로는** NLMapper+룰 파싱 | `TASKS` §A · `BACKLOG` §12 |
| **G-02** | `determineRetrievalMode`가 `producer_browse` / `region_browse` / `no_match_detection` **미반환** — 골든 `retrieval_mode`·`MODE_RELEASE_GATES`와 축 불일치 | `TASKS` §I · `BACKLOG` P0-2 · `AUDIT-LOG` |
| **G-03** | 오프라인 eval: 시나리오 A–H ↔ `ENTITY_TARGET_TYPE_MAP`이 Epic 2 문서 의미와 다름 (E/F/G/H) | `BACKLOG` P0-1 |
| **G-04** | ~~`npm run eval` → `run-eval.ts` 없음~~ → **해소:** `"eval": "tsx scripts/eval/run-offline-eval.ts"` **파일 존재** — 잔여는 **`G-21`/`G-22`** (`verify-splits`) | `package.json` · [`AUDIT-LOG`](./AUDIT-LOG.md) **2026-04-06 6차** |
| **G-05** | ~~HTTP `query.max(2000)` vs `QuerySanitizer` **500자**~~ → **해소** (위 표) | `BACKLOG` §24 (구 기록) |
| **G-06** | ~~**CI `lint`** … 200+ 에러~~ → **해소** | `BACKLOG` §14 (구 기록) |
| **G-07** | 루트 `test-search-direct.ts`가 ESLint `project` 밖 → 파싱 에러 유발 | `BACKLOG` §13 |
| **G-40** | ~~Epic 16: Hybrid/Interpret/Resolve 샌itizer 없음~~ → **해소** (`QueryEntrySecurityGate`) | `BACKLOG` §38 (구 기록) |
| **G-42** | **`/v1/search/hybrid`** vs **`/v1/search`**+`mode:hybrid` — **서로 다른 파이프라인** (resolver 스킵 여부) | `FINDINGS-MATRIX` **M-34** · `TASKS` §L |
| **G-43** | ~~`requestId` 미전달~~ → **해소** (`toResolveRequest`, `ResolveUseCase`) | `TASKS` §L (구 기록) |

---

## ID ↔ 한 줄 (P1 — 기능·파이프라인 갭)

| ID | 한 줄 | 근거 |
|----|--------|------|
| **G-08** | `BrowseRetriever` / `CompareRetriever` **빈 배열 스텁** — 컨테이너·`SearchUseCase`는 **배선됨** | `TASKS` P0-1 · `BACKLOG` §3 |
| **G-09** | `ResultGrouper` **응답 경로 미연결** | `TASKS` P0-3 |
| **G-10** | ~~ConstraintSAT 미구현~~ → **해소** | `TASKS` P1-4 (구 기록) |
| **G-11** | **Entropy `AbstainPolicy`** 미구현 (기존 ambiguity·confidence 경로와 별개) | `TASKS` §G 표 · Epic 13 |
| **G-12** | Epic 14: `/v1/search`에 top-level **`retrieval_mode` 없음**, `EngineDecision`에 override 메타 없음 | `TASKS` §G2 · §I |
| **G-13** | **`extractPairingConstraint`** 런타임 검색 경로 **미import** (ETL만 사용) | `BACKLOG` §32 · `TASKS` §B |
| **G-14** | **`mapping.ts`**에 `critic_proxy` / `pairing_tags` / organic 등 **스키마 필드 미매핑** | `TASKS` §B |
| **G-15** | 배치: 본문 `failed`/`POLICY_BLOCKED`도 **`succeeded`로 집계** 가능 | `TASKS` §C |
| **G-16** | Injection 차단 시에도 **`POST /v1/search` HTTP 200** (본문만 failed) | `TASKS` §C |
| **G-17** | `fail_fast`: 전부 **병렬 시작** — “첫 실패 후 미실행”과 다를 수 있음 | `TASKS` §C |
| **G-18** | `parsedConstraints.unparsed` **항상 `[]`** | `TASKS` §I · `response-builder.ts` |
| **G-19** | Epic 4 문서 경로(Python/feature-schema 등) vs **실제 TS LTR** 불일치 | `TASKS` P2-7 · `BACKLOG` §5 |
| **G-20** | `wine-attribute-encoder.ts`(domain) vs `label-encoder.ts` — **동명 클래스 이중 정의**, domain 쪽 **import 0건** | `BACKLOG` §33 |
| **G-21** | `run-offline-eval`이 **`verify-splits` 미호출** | `BACKLOG` §6 |
| **G-22** | ~~CI에 `verify-splits` 없음~~ → **해소** (워크플로 잡 추가됨) | `TASKS` §I (구 기록) |
| **G-23** | Watchlist: 응답 스키마 **UUID** vs 라우트 **`nanoid()`** | `BACKLOG` §34 |
| **G-24** | Watchlist: **`RedisWatchlistSubscriber` 서버 미기동** + **DB 마이그레이션 없음** | `BACKLOG` §35 |
| **G-25** | **`drinking_window_now`**: Vespa만 있고 **NL 매핑 없음** | `BACKLOG` §36 |
| **G-26** | **`EVAL_RUN_AT_STARTUP`**: 부팅 시 장시간 eval | `BACKLOG` §37 |
| **G-27** | Drinking window **ONNX TODO** / 휴리스틱 | `BACKLOG` §19 · `TASKS` §D |
| **G-28** | Claude **`check_drinking_window`** placeholder | `BACKLOG` §20 |
| **G-29** | Search **캐시 경로 비활성** | `BACKLOG` §18 |
| **G-30** | `LLMInjectionJudge` **fail-open** (API 오류 시 차단 완화) | `BACKLOG` §30 |

---

## ID ↔ 한 줄 (P2 — 문서·운영·정리)

| ID | 한 줄 | 근거 |
|----|--------|------|
| **G-31** | Epic 11: `mode-metrics.ts` 파일 없음 → **`metrics.ts`에 통합** | `BACKLOG` §7 |
| **G-32** | Golden 파일명 vs `data/splits/*` 워크플로 불일치 | `BACKLOG` §10 |
| **G-33** | Reranker **README** 없음 (`services/reranker`) | `BACKLOG` §9 |
| **G-34** | Epic 10 비교 **테이블/축** vs `ComparisonSearchResponse` 단순 구조 | `BACKLOG` §27 |
| **G-35** | Vespa **`ltr_v1` / second-phase** 없음 — 앱 LTR만 | `BACKLOG` §26 |
| **G-36** | `tsconfig.build` LTR exclude vs **import 시 dist emit** | `BACKLOG` §28 |
| **G-37** | PG 미연결 시 **광범위 Stub** — 프로덕션과 동작 차 | `BACKLOG` §22 |
| **G-38** | Epic 14: **`llm-decomposer` / `LLMDecomposerPort` 미구현** (플랜 폴백) | `PLANS-GAP-AUDIT` Epic 14 · `rg llm-decomposer src` → 0 |
| **G-39** | Epic 13: **BK-tree + Soundex** 별칭 통합 점수 — 코드베이스에 **해당 구현 없음** | `PLANS-GAP-AUDIT` Epic 13 |
| **G-41** | Epic 9 `missingInformation` — `SearchResponseV1`에 **필드 없음** | `BACKLOG` §25 · `FINDINGS-MATRIX` **M-30** |
| **G-45** | Epic 15: 플랜의 `collect-drinking-windows.ts`·`scripts/ml/drinking-window-features.ts` **없음** — `drinking-window-backfill.ts` 등과 **문서 경로 불일치** | `PLANS-GAP-AUDIT` Epic 15 · `G-27`과 연관 |
| **G-46** | **`@fastify/cors` 등 미사용** — 브라우저에서 API 도메인 **직접 호출 시** preflight/CORS 이슈 가능 (역프록시 뒤면 무관) | `BACKLOG` §39 · `rg cors src` → 0 |
| **G-47** | **`HTTP_RATE_LIMIT_MAX=0`** 이면 **전역 rate limit 미등록** — RFC-014 §13 완화·오해 소지 | `BACKLOG` §40 · `env.ts` 15–16 · `server.ts` 92–96 |
| **G-48** | ~~OpenAPI 없음~~ → **해소** (`GET /openapi.json`); 잔여=커버리지 | `BACKLOG` §41 (구 기록) |
| **G-55** | `docs/plans` **Epic 1·2·6** 등 Deliverables `- [ ]`·**Epic 9 본문 표(여전히 ❌)** — 스크립트·타입·envelope 필드는 **이미 있는 경우가 많음** (기능 빵꾸와 혼동 주의; Epic 9는 **`missingInformation`만 진짜 갭**) | `PLANS-GAP-AUDIT` **§6차** |
| **G-56** | Epic 14 플랜의 **`retrieval_mode_source` / `api_override`** 메타 — **응답·스키마에 없음** (`rg retrieval_mode_source src` → 0) | `G-12`와 연관 · `PLANS-GAP-AUDIT` Epic 14 |
| **G-57** | optional infra 설계와 달리 PG가 사실상 필수 부트스트랩 경로 | `BACKLOG` §45 · `TASKS` §O |
| **G-58** | `createServer`가 global `config`와 `process.env`를 직접 읽음 | `BACKLOG` §46 · `TASKS` §O |
| **G-59** | route layer에 Fastify schema/response 계약 등록이 거의 없음 | `BACKLOG` §47 · `TASKS` §O |

---

## 중복 제거 메모

- CI `verify-splits`: **G-22 해소** — 재현은 [`ACTUAL-GAPS.md`](./ACTUAL-GAPS.md) 해소 표.

---

**최종 갱신:** 2026-04-06 — **7차:** [`ACTUAL-GAPS.md`](./ACTUAL-GAPS.md) 추가; **G-05/6/10/22/40/43/48** 코드 재검증 기준 **해소** 반영. (이전 6차: `G-04`·Epic 9·Epic 18 등.)
---

## 8차 추가

| ID | 한 줄 | 근거 |
|----|--------|------|
| **G-49** | watchlist route가 pub/sub·webhook 인프라를 우회하는 인메모리 CRUD | `BACKLOG` §52 |
| **G-50** | watchlist async delivery는 테스트에만 있고 서버 startup wiring이 없음 | `BACKLOG` §53 |
| **G-51** | watchlist schema UUID vs route/test nanoid 계약 충돌 | `BACKLOG` §54 |
| **G-52** | `Pick<ConcreteClass,...>` 계약·남은 domain→infra 역참조 | `BACKLOG` §55 |

---

## 9차 추가

| ID | 한 줄 | 근거 |
|----|--------|------|
| **G-60** | watchlist response/error schema 대부분이 런타임에서 미사용 | `BACKLOG` §45 · `TASKS` §O |
| **G-61** | `createServer()`가 전역 `config` singleton에 직접 의존 | `BACKLOG` §46 · `TASKS` §O |
| **G-62** | `main.ts`는 optional pool 설계와 달리 항상 PG pool을 강제 생성 | `BACKLOG` §47 · `TASKS` §O |
| **G-63** | `/ready`가 실제 dependency 상태와 무관하게 항상 `ready: true` | `BACKLOG` §48 · `TASKS` §O |

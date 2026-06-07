# Wine Search Engine — 내부 개발자 가이드

와인 인텔리전스 / 검색 백엔드: **TypeScript**, **Node.js 22**, **Fastify** HTTP API, **PostgreSQL**, **Redis**, **Vespa** 검색, 선택적 **HTTP ML 서비스**(임베딩, 크로스 인코더 리랭크, 학습형 매처).

이 문서는 **이 저장소에서 작업하는 엔지니어**를 위한 것입니다. 제품 동작·용어는 **`docs/RFC-*.md`**를 따릅니다. 에디터/에이전트 단축: **`CLAUDE.md`**, **`AGENTS.md`**, **`.cursor/rules/wine-search-engine.mdc`**. **HTTP 요청 추적·에이전트 자율 디버깅:** **`.ai/llm-debugging-playbook.md`** (플레이북), **`.ai/debug-mode.md`** (활성화·한계).

### 문서 지도

| # | 섹션 |
|---|------|
| 1 | [기술 스택](#technical-stack) |
| 2 | [아키텍처·구성](#architecture--composition) |
| 3 | [HTTP API·검색 흐름](#http-api-entry-points--request-flow) |
| 4 | [검색·랭킹](#retrieval--ranking-engine-conceptual) |
| 5 | [알고리즘](#algorithms--established-methods-where-used) |
| 6 | [완성도: 엔지니어링 깊이와 제품 성숙도](#completeness-engineering-sota-vs-product-maturity) |
| 7 | [평가 지표](#evaluation-metrics-definitions--gates) |
| 8 | [테스트·커버리지·E2E](#test-coverage--e2e-scenarios) |
| 9 | [기능 요약](#what-this-codebase-implements-capabilities) |
| 10 | [저장소 구조](#repository-structure) |
| 11 | [전제·부트스트랩](#prerequisites) · [설정](#configuration-env) · [실행](#running-the-api) · [Docker](#docker-compose) · [마이그레이션](#database-migrations) |
| 12 | [스크립트](#scripts--pnpm-commands-reference) · [CI](#ci-github-actions) · [추가 읽을거리](#further-reading) |

### 빠른 시작

```bash
git clone <internal-remote> wine-search-engine && cd wine-search-engine
corepack enable   # once per machine — activates pnpm from package.json "packageManager"
pnpm install && cp .env.example .env   # DATABASE_URL(RDS), REDIS_URL, VESPA_URL 등 편집
pnpm run migrate                  # `.env`의 Postgres에 마이그레이션 (기본: RDS URL + PG_SSL)
pnpm run dev                      # http://localhost:3000 — GET /health 참고
pnpm run lint && pnpm run typecheck && pnpm run test   # 푸시 전
```

`pnpm run bootstrap:smoke`는 임시로 `.env.example`을 `.env`로 복사해 `typecheck` → `build` → 선택적 `migrate`까지 점검합니다. 마이그레이션은 **`.env.example`에 유효한 DB가 없으면 실패**하므로, 로컬에서는 `SKIP_MIGRATE=1`을 쓰거나 예시에 맞는 `DATABASE_URL`을 넣습니다. CI에서는 `SKIP_MIGRATE=1`로 DB 없이 실행합니다.

현재 레포에는 `ingest` / `kill-switch` 전용 CLI 진입점이 없습니다. 문서와 `package.json`에서도 제거해 “있는 척” 하지 않도록 맞췄고, ETL/운영 작업은 개별 `scripts/etl/*.ts` 또는 기존 HTTP/설정 경로를 사용합니다.

---

<h2 id="technical-stack">기술 스택</h2>

| 레이어 | 기술 |
|--------|------|
| 런타임 | **Node.js ≥ 22**, **ESM** (`"type": "module"`) |
| 언어 | **TypeScript** — `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` |
| HTTP | **Fastify 5**, **Zod**(스키마·라우트 계약), **Pino** 로깅 |
| API 문서 | 계약 카탈로그 기반 HTTP surface (`src/interface/http/routes/http-route-contract-catalog.ts`) |
| DB | **`pg`** — 엔터티, 별칭, 피드백, 제안, 워치리스트(해당 시) |
| 캐시 / pub-sub | **`redis`** (공식 클라이언트, ioredis 아님) |
| 검색 엔진 | **Vespa 8** — ANN + sparse; 앱 패키지는 **`vespa/app/`** |
| ML / 수치 | **onnxruntime-node**(음주 가능 기간 ONNX 선택), 원격 모델용 HTTP 어댑터 |
| LLM / 도구 | **@anthropic-ai/sdk** (선택; 보안·도구 경로) |
| 텔레메트리 | **OpenTelemetry** API/SDK 훅 (`src/infrastructure/telemetry/`) |
| 테스트 | **Vitest** — 단위(`src/**/__tests__`, `test/unit/`), 통합, e2e, 품질 설정 |
| 린트 | **ESLint** 플랫 설정 + **typescript-eslint** (`src/` 타입 인지 규칙) |

**경로 별칭** (`tsconfig.json`): `@shared`, `@domain`, `@app`, `@infra`, `@interface`, `@config`.

---

<h2 id="architecture--composition">아키텍처·구성</h2>

### 레이어링 (육각형 / 포트·어댑터)

| 레이어 | 책임 |
|--------|------|
| **Interface** (`src/interface/`) | Fastify 라우트, Zod 계약, 미들웨어, Claude 도구, CLI 진입점 |
| **Application** (`src/application/`) | 유스케이스 오케스트레이션: 검색 파이프라인 단계, 음주 가능 기간 파사드, 에이전트 실행 |
| **Domain** (`src/domain/`) | 순수 로직, 엔티티, 정책, **포트**(인터페이스) — 직접 I/O 없음 |
| **Infrastructure** (`src/infrastructure/`) | **어댑터**: Postgres, Redis, Vespa 클라이언트, HTTP ML 클라이언트, ONNX, 텔레메트리 |

의존성은 **안쪽**을 향합니다: 애플리케이션·도메인이 포트를 정의하고, 인프라가 구현합니다.

### 구성 루트 (`createContainer`)

배선은 모듈로 나뉘어 하나의 **`Container`**로 합쳐집니다.

1. **`buildCoreContainerServices`** (`container-core.ts` / `container-core-builders.ts`) — 쿼리 플래너, 엔터티 리졸버(+ 캘리브레이터, 학습형 매처 HTTP), 후보 풀·퓨전, 랭커, 의사결정 엔진, 응답 빌더, mixed 솔버, Vespa 검색 인덱스, 임베딩·리랭커 HTTP, 음주 가능 기간 예측기 등.
2. **`buildFeatureContainerServices`** (`container-features.ts` + `container-usecases.ts`) — search / hybrid / resolve / interpret / replay / batch / 분해 검색, 음주 가능 기간 유스케이스, 적응형 Claude 도구 실행기, 선택적 eval 러너.
`main.ts`는 **런타임 핸들**(Postgres 풀, Redis 클라이언트)을 만든 뒤 **`createContainer(config, runtime)`**, 그다음 **`buildHealthRouteOptions`**의 준비 상태 옵션으로 **`createServer(container)`**를 호출합니다.

---

<h2 id="http-api-entry-points--request-flow">HTTP API: 진입점·요청 흐름</h2>

### 라우트 카탈로그 (선언 계약)

권위 목록: **`src/interface/http/routes/http-route-contract-catalog.ts`** (`**server.ts**`에 등록된 핸들러와 대응).

| 메서드 | 경로 | 유스케이스 |
|--------|------|------------|
| GET | `/health` | 생존(liveness) |
| GET | `/ready` | 준비 상태 프로브 |
| POST | `/v1/search/hybrid` | 하이브리드 검색 경로 강제 |
| POST | `/v1/search/semantic` | dense-only 검색 경로 강제 |
| POST | `/v1/search/lexical` | sparse/BM25-only 검색 경로 강제 |
| POST | `/v2/entity-lookup` | 단일 와인 엔터티 해소 |
| POST | `/v1/agent` | single-shot agent 실행 |
| POST | `/v1/agent/sessions` | 서버 보관형 agent 세션 생성 |
| POST | `/v1/agent/sessions/:sessionId/turns` | agent 세션 turn 추가 |

### 일반 흐름: `POST /v1/search/hybrid`

상위 단계(`search.usecase.ts`의 **`SearchUseCase.execute`** 참고):

1. **Pre-route** (`runSearchPreRoutePhase`) — 보안 게이트(새니타이저 ± LLM 판정), 선택적 캐시 읽기, **쿼리 계획** (`QueryPlanner`), 제약 SAT, 선택적 **분해** “A vs B” 단축.
2. **Route resolution** — 실효 경로: **entity** / **hybrid** / **mixed** (플랜 + 요청 `retrieval_mode`).
3. **Dispatch** (`dispatchSearchRouteExecution`):
   - **Entity** — 리졸버 후보 구성 → **`EntityResolver.resolve`** (블로킹, 스코어링, 캘리브레이션, 선택적 학습형 매처 피처).
   - **Hybrid** — **`CandidatePool`** (sparse + dense + fusion) → **`Ranker`** (+ 쿼리 클래스별 선택적 **LTR**) → 해소/랭킹 입력으로 패키징.
   - **Mixed** — **`MixedSolver`** (앵커 + 유사 이웃).
4. **Post-route** (`runSearchPostRoutePhase`) — 기권 정책, **`DecisionEngine`**, **`ResponseBuilder`**, 선택적 음주 가능 기간 보강, 캐시 쓰기.

```mermaid
flowchart TD
  A[POST /v1/search/hybrid] --> B[Pre-route: security + plan]
  B --> C{Route}
  C -->|entity| D[Resolver]
  C -->|hybrid| E[CandidatePool + Ranker]
  C -->|mixed| F[MixedSolver]
  D --> G[Post-route: Decision + Response]
  E --> G
  F --> G
```

### 보조 진입점

- **`/v1/search/hybrid`** — 검색과 동일 오케스트레이션이나 **하이브리드만** 강제 실행.
- **`/v1/search/semantic`** — dense-only 경로를 강제해 lexical 후보군을 배제.
- **`/v1/search/lexical`** — sparse/BM25-only 경로를 강제해 임베딩 후보군을 배제.
- **`/v2/entity-lookup`** — discovery 대신 단일 canonical wine 해소만 수행.

---

<h2 id="retrieval--ranking-engine-conceptual">검색·랭킹 엔진 (개념)</h2>

| 단계 | 역할 | 주요 코드 |
|------|------|-----------|
| **쿼리 계획** | 쿼리 분류, 앵커, 정책, 불확실성 | `domain/query/`, `Planner` |
| **블로킹·별칭** | 정체성 그래프, **pg_trgm** 친화 블로킹, 문자 **n-gram** 퍼널 | `domain/alias/`, `infrastructure/adapter/*blocking*` |
| **Sparse 검색** | Vespa를 통한 어휘 / **BM25** 스타일 히트 | `vespa-search-index.ts` |
| **Dense 검색** | 문서 임베딩 **ANN** (`nearestNeighbor`, **angular** 거리) | `vespa-search-index.ts`, `vespa/app/` 스키마 |
| **Fusion** | sparse/dense(및 관련) 순위 목록에 **RRF** | `fusion.ts`, `shared/utils/rrf.ts` |
| **Cross-encoder 리랭크** | 쿼리–패시지 쌍 2단계 스코어링(HTTP 서비스) | `infrastructure/vespa/reranker.ts` |
| **Calibration** | 리졸버 스코어에 **Platt** / **isotonic** / **temperature** | `domain/resolver/service/calibrator.ts`, `calibration` 테이블 |
| **Decision** | 임계값, 기권, 증거 패키징 | `domain/decision/` |

하이브리드 후보는 **RRF 기반** 퓨전 스코어를 담습니다(`hybrid-candidate.ts` 참고); 캘리브레이션된 **의사결정 신뢰도**는 RFC에 따라 리졸버/의사결정 경계에서 정의됩니다.

---

<h2 id="algorithms--established-methods-where-used">알고리즘·정립된 방법 (사용 위치)</h2>

코드베이스는 **고전 IR**, **신경 검색·리랭킹**, **캘리브레이션 의사결정**을 의도적으로 결합합니다. 아래는 **패턴**과 **등장 위치**이며 문헌 조사 전체는 아닙니다.

| 방법·패턴 | 일반적 용도 | 저장소 연결점 |
|-----------|-------------|----------------|
| **BM25** (sparse 어휘) | 어휘 관련성 | Vespa sparse 쿼리; `vespa-search-index.ts`, `browse-diversity.ts` 주석 |
| **Dense ANN** (임베딩 유사도) | 의미적 리콜 | Vespa `nearestNeighbor` + **angular**; HTTP로 BGE 스타일 임베딩 |
| **Reciprocal Rank Fusion (RRF)** | 점수 정규화 없이 순위 목록 병합 | `shared/utils/rrf.ts`의 `rrfFuse(..., k=60)`, `FusionService` |
| **Cross-encoder 리랭킹** | 트랜스포머 쌍별 모델로 상위 후보 재점수 | HTTP `RerankerPort` 구현 |
| **Platt scaling / isotonic / temperature** | 점수를 확률로 보정 | `Calibrator`, `calibration_params` 테이블, `shared/utils/calibration.js` |
| **Learning-to-rank (LambdaMART 스타일 가중치)** | 선택적 쿼리 클래스별 선형 블렌드 | `QueryClassWeights`, `search-usecase-ltr-rerank.ts`(모델 로드 시) |
| **BK-tree** | 문자열·편집거리 스타일 조회용 메트릭 트리 | `domain/query/service/bk-tree.ts` |
| **Character n-grams** | 퍼지 별칭 표면 매칭 | `CharNgramIndex`, 별칭 매처 퍼널 |
| **음성·음역 헬퍼** | 쿼리·배치 별칭 표면 | `phonetic.ts`, `Transliterator`(ETL) |
| **Trigram 인덱스 (GIN)** | DB 쪽 퍼지 별칭 조회 | 마이그레이션의 `pg_trgm`; `PgBlockingAdapter` / 별칭 레포 |
| **ONNX Runtime** | 음주 가능 기간 회귀 | `infrastructure/ml/drinking-window-predictor.ts` |
| **Conformal / 기권 정책** | 저신뢰 결과 거부 | 기권 정책 + 의사결정 엔진(RFC-013 코드 참조) |

**인용(예시, 전부 아님):** BM25(Robertson & Walker 계열); RRF는 현대 하이브리드 검색에서 널리 사용(k≈60 등); Platt(1999); 단조 캘리브레이션용 isotonic 회귀; cross-encoder는 Nogueira & Cho(2019)류 신경 IR에서 흔한 문장 쌍 분류 패러다임.

---

<h2 id="completeness-engineering-sota-vs-product-maturity">완성도: 엔지니어링 “SOTA”와 제품 성숙도</h2>

- **강점:** **아키텍처**가 일반적인 **프로덕션 검색** 관행과 맞음: **하이브리드 검색**(sparse + dense), **퓨전**, 선택적 **cross-encoder**, **캘리브레이션**된 리졸버 스코어, 명시적 **의사결정 레이어**, 확장 가능한 검색용 **Vespa**, **계약 우선 HTTP**, **오프라인 eval** 훅(노이즈 엔터티, 오프라인 티어).
- **한계·솔직함:** “SOTA++”는 **프로젝트 지향**이지 단일 벤치마크 점수가 아님. 오프라인 eval 레인은 **스모크·골든** 픽스처를 쓸 수 있음; **라이브 A/B**와 프로덕션 트래픽 대비 **지속 캘리브레이션**은 **저장소 밖** 주제. ML 서비스(임베딩, 리랭커, 학습형 매처)는 **HTTP 계약** — 품질은 **모델·데이터·운영**에도 달리며 이 서비스만으로 결정되지 않음.
- **확장 방법:** 새 검색 모드 → Vespa 스키마 + `SearchIndexPort`; 새 랭킹 시그널 → `Ranker` / LTR 가중치; 새 안전 → `query-entry-security`와 RFC의 정책.

---

<h2 id="evaluation-metrics-definitions--gates">평가 지표 (정의·게이트)</h2>

**수식의 근원:** `scripts/eval/metrics.ts`(순수 함수, I/O 없음). **RFC 정합:** 의사결정 유틸 / AURC / ECE는 **RFC-009**; 릴리스 게이트는 **RFC-017 §3.2** (`scripts/eval/run-offline-eval.ts`의 `RELEASE_GATES`). **운영 런북:** `docs/eval-baseline-runbook.md`.

### 오프라인 평가 (`run-offline-eval.ts`)

골든 쿼리 JSONL을 파이프라인에 통과시키고 **전역** 및 **슬라이스**(시나리오, 언어, 검색 모드) 통계를 집계합니다.

| 지표 | 기호·범위 | 정의(요약) |
|------|-----------|------------|
| **NDCG@10** | 등급 관련성 | 랭크 10에서 정규화 DCG; 이득 = **2^grade − 1**, 할인 = **1 / log2(rank+1)**. 등급은 `RelevanceMap`(0–3). |
| **MRR@10** | 상위 10 내 첫 관련 | 등급 ≥ 1인 첫 히트의 역순위; 없으면 0. |
| **Recall@3** | 상위 3 커버리지 | 진실 관련 엔터티(등급 ≥ 1)가 1–3위에 나온 비율. |
| **Recall@10** | 상위 10 | 동일, **K = 10**(모드 슬라이스). |
| **Recall@100** | 상위 100 | 동일, **K = 100**(전역 검색 건강). |
| **Wrong Top-1 rate** | 의사결정 품질 | **`wrong_resolve`**로 분류된 쿼리 비율(RFC-009 §4.1). |
| **Decision utility** | 기대 유틸 | **RFC-009 §5.1** 가중치(`correct_resolve`, `safe_abstain`, `wrong_resolve`, …)의 쿼리별 유틸 평균. |
| **Safe / avoidable abstain rate** | 기권 동작 | `classifyDecision` 이후 `safe_abstain` vs `avoidable_abstain` 비율. |
| **AURC** | 선택적 예측 | `decision_confidence`로 정렬했을 때 risk–coverage 곡선 아래 면적(RFC-009 §5.3); 낮을수록 좋음. |
| **Excess AURC** | 캘리브레이션 갭 | 동일 라벨 집합에 대해 `AURC − optimal AURC`. |
| **ECE** | 캘리브레이션 오차 | 기대 캘리브레이션 오차(구간); 목표는 RFC-009 §7 / 코드 주석. |

**모드별 추가**(Epic 11, 해당 시): **다양성**, **생산자 다양성**, **앵커 보존**, **속성 커버리지**, **집합 커버리지** 등 — `ModeMetrics` / `run-offline-eval.ts` 집계 참고.

**기본 전역 릴리스 게이트**(오프라인 러너 — `--tier gate` 없으면 권고):

| 게이트 키 | 예시 임계값 | 역할 |
|-----------|-------------|------|
| `wrong_top1_rate_max` | ≤ 0.02 | 잘못된 해소 상한 |
| `decision_utility_min_delta` | ≥ −0.05 | 베이스라인 대비 유틸 퇴보 허용 |
| `ndcg_at_10_min_delta` | ≥ −0.03 | NDCG@10 퇴보 허용 |
| `recall_at_100_min` | ≥ 0.90 | 넓은 리콜 바닥 |
| `aurc_max_delta` | ≤ 0.01 | 선택적 예측 퇴보 |
| `entity_resolve_wrong_top1_max` | ≤ 0.03 | entity-resolve 슬라이스 |
| `set_retrieval_recall_at_10_min` | ≥ 0.60 | 집합 검색 슬라이스 |
| `no_match_false_resolve_max` | ≤ 0.05 | no-match 슬라이스 |

**검색 모드별 바닥**(예: `entity_lookup`, `constraint_filter`, `producer_browse`, …)은 같은 파일의 `MODE_RELEASE_GATES`(NDCG@10, recall@10, diversity 등).

### 노이즈 엔터티 벤치마크 (`run-noisy-entity-eval.ts`)

`data/noisy-entity-benchmark.jsonl`(또는 `--input` 커스텀)으로 **노이즈 쿼리 하의 엔터티 해소**를 평가합니다. **라이브 API**(`SEARCH_API_URL`) 또는 **예측 JSONL**(`--predictions`)에서 실행합니다.

| 지표 | 의미 |
|--------|------|
| **Recall@1** | 기대 엔터티가 1위. |
| **Recall@3** | 기대 엔터티가 상위 3(노이즈 엔터티의 주요 지표). |
| **MRR** | 기대 엔터티의 평균 역순위. |
| **by_category** / **by_language** | 동일 지표를 슬라이스(오타, 음역, `en`/`ko`/`mixed` 등). |
| **provenance_match_rate** | 보고된 provenance 단계/출처가 벤치마크와 일치하는 비율(기대가 있을 때). |
| **resolution_match_rate** | 의사결정 상태가 `expected_resolution`과 일치하는 비율(설정 시). |
| **false_exact_rate** | 벤치마크가 비 exact 경로를 기대할 때 “exact” 스타일 결과 비율(추적 시). |

**CLI 품질 게이트**(선택): `--min-recall-at-3`, `--min-resolution-match-rate`, `--min-provenance-match-rate`, `--max-false-exact-rate`. **`pnpm run eval:noisy:gate`**는 스모크 예측 픽스처에 엄격한 스모크 임계값(예: recall@3 = 1)을 둡니다.

### CI·pnpm 단축

| 명령 | 확인 내용 |
|------|-----------|
| `pnpm run eval:noisy:assert-baseline` | 스모크 1회 실행 후 베이스라인 대비 (`eval:noisy:validate` + assert) |
| `pnpm run eval:noisy:smoke` | 활성 shared data dir의 `data/noisy-entity-eval-smoke-results.json` 생성 |
| `pnpm run eval:noisy:gate` | 스모크 실행 임계값 통과(파이프라인 무결성) |
| `pnpm run test:verification:noisy` | `eval:noisy:gate` 1회 후 `eval:noisy:assert-baseline:current`(동일 `/tmp` 산출물) |
| `pnpm run test:verification:core` | 로컬/나이틀리용: `typecheck` + `e2e:contract` + `e2e:runtime` + `ingest:contract` + `test:verification:noisy` |
| `pnpm run eval:offline:*` | 전체 오프라인 티어; 스모크 베이스라인: `eval:offline:smoke:assert-baseline` |

---

<h2 id="test-coverage--e2e-scenarios">테스트·커버리지·E2E 시나리오</h2>

### 커버리지 측정 방식

- **설정:** `config/vitest/unit.config.ts`(루트 `vitest.config.ts`가 재export).
- **제공:** `@vitest/coverage-v8`, **`coverage.include`** = `src/**/*.ts`, 제외 `**/*.test.ts`, `**/__tests__/**`, `src/main.ts`.
- **산출:** `coverage/lcov.info` + 터미널(`coverage.reporter`: `text`, `lcov`).
- **실행:** `pnpm run test:coverage`(단위 레인만 — 통합/e2e Vespa는 별도 설정).

커버리지는 **`src/` 라인 기준**이며 `test/e2e/`의 HTTP e2e 파일은 자동 포함되지 않습니다(`inject()`로 앱을 돌리지만 Vitest 프로젝트가 다름).

### Vitest 레인(설정 → 목적)

| 설정 | `pnpm run …` | 실행 내용 |
|------|-------------|-----------|
| `config/vitest/unit.config.ts` | `test`, `test:unit` | `test/unit/**/*.test.ts` + `src/**/__tests__/**/*.test.ts` + 선택 `src/__tests__` |
| `config/vitest/integration.config.ts` | `test:integration` | `test/integration/**/*.test.ts` + 선택 `src/**/integration` 레일 |
| `config/vitest/e2e.config.ts` | `test:e2e:fast`, `test:e2e`, `test:e2e:inmemory` | 핵심 인메모리 E2E 회귀군: primitive search, ops/protocol, edge/hard scenario, mixed-search, canonical `/v1/agent` happy-path |
| `config/vitest/e2e.runtime.config.ts` | `test:e2e:runtime` | 런타임/품질 성격이 강한 `user-journeys`, `golden-set`, `query-family-release-gate`, `specialized-modes-quality` |
| `config/vitest/e2e.smoke.config.ts` | `test:e2e:contract`, `test:e2e:smoke` | **초소형** PR 스모크: `search-api.search`, `search-api.ops`, `schema-contract`, `server-protocol`, `cli-process` |
| `config/vitest/e2e.wine-search.config.ts` | 직접 `vitest run --config ...` | `/v1/agent` 전용 hell/concurrency/perf E2E 묶음 |
| `config/vitest/e2e.vespa.config.ts` | `test:e2e:vespa` (`scripts/run-vespa-e2e.sh`) | 전체 `test/e2e/vespa/**/*.test.ts`; `VESPA_URL` 설정(기본 `http://localhost:18080`) |
| `config/vitest/quality.config.ts` | `test:quality` | 골든 세트, 사용자 여정, specialized quality, decision utility, eval 단위 테스트 |

### 인메모리 E2E (`test/e2e/*.test.ts`, `test:e2e:fast`)

**`createTestServer()`** + Fastify **`inject()`**(실제 TCP 포트 없음). 대표 시나리오:

| 스위트 파일 | 시나리오(요약) |
|-------------|----------------|
| **`search-api.search.test.ts`** | primitive search + lookup 계약: `POST /v1/search/{hybrid,semantic,lexical}` + `POST /v2/entity-lookup` |
| **`search-api.ops.test.ts`** | `/health`, `/ready` ops endpoint 계약 |
| **`wine-search-api.test.ts`** | canonical `/v1/agent` single-shot 계약: happy path, validation, abort, 응답 봉투 |
| **`schema-contract.test.ts`** | 요청·응답 **Zod** 형태 vs 픽스처 |
| **`cli-process.test.ts`** | CLI 프로세스 표면 smoke |
| **`server-protocol.test.ts`** | 전역 프로토콜(CORS 훅, content-type 등) |
| **`golden-set.test.ts`** | **검색 품질** — 지명 와인에 대해 top-k에 기대 `entity_id`(EN/KO), 순서는 완화 |
| **`user-journeys.test.ts`** | **엔드투엔드 여정**: 다국어 동일 엔터티, 악센트 변형, 모호성, mixed 경로, 실패 처리 |
| **`mixed-search.test.ts`** | mixed 경로 **크래시 없음**; 시드 하네스에서 비어 있지 않은 결과 |
| **`realistic-scenarios.test.ts`**, **`edge-cases.input.test.ts`**, **`edge-cases.protocol.test.ts`**, **`hard-scenarios.test.ts`** | 넓은 쿼리 형태·엣지 |
| **`response-invariants.test.ts`** | 응답 필드·불변식 |
| **`wine-search-api-hell-*.test.ts`** | `/v1/agent` adversarial, HTTP boundary, concurrency, combo, perf |
| **`infrastructure.invariants.test.ts`** | rate-limit, request-id, replay determinism, concurrent isolation |
| **`infrastructure.contracts.test.ts`** | content-type, success envelope, RFC-014 / RFC-015 error contract |

**런타임 보강 레인:** `test:e2e:runtime`는 **`golden-set.test.ts`**, **`user-journeys.test.ts`**, **`specialized-modes-quality.test.ts`**를 별도로 묶어 돌립니다.

**품질 레인:** `test:quality`는 위 품질성 e2e 3종과 통합/단위 eval 테스트를 함께 돌립니다(`config/vitest/quality.config.ts`).

### Vespa 기반 E2E (`test/e2e/vespa/**`, `test:e2e:vespa`)

**도달 가능한 Vespa** 필요(`VESPA_URL`, 헬스 체크). 많은 스위트가 **`describe.skipIf(!HAS_REACHABLE_VESPA)`**로 Vespa 없으면 **스킵**합니다.

| 스위트 파일 | 시나리오(요약) |
|-------------|----------------|
| **`search-correctness.test.ts`** | 시드 엔터티 대비 **sparse** 검색(정확/부분 조회, 필터) |
| **`search-quality.test.ts`** | 라이브 인덱스 랭킹·품질 단언 |
| **`infrastructure-pipeline.test.ts`** | 실제 Vespa 대상 E2E 파이프라인 |
| **`search-network-services.test.ts`** | **HTTP ML 어댑터**(`/embeddings`, `/rerank`) + **가짜 ML 서비스** + Vespa 테스트 서버 |
| **`vespa-test-real-stores.test.ts`** | 실제 스토어·통합 점검(활성화 시) |

래퍼 스크립트(`scripts/run-vespa-test-lane.sh`, `setup-vespa-test.sh`, …)가 환경·정리를 표준화합니다.

### 로컬에서 무엇을 돌릴지

#### 추천 기본 루프

| 상황 | 명령 |
|------|------|
| 작업 중 기본 확인 | `pnpm run check:smart` |
| source 파일 하나 기준으로 좁게 확인 | `pnpm run check:smart src/domain/foo.ts` |
| 테스트 파일 하나만 바로 실행 | `pnpm run test:file -- test/unit/foo.test.ts` |
| 변경 파일 관련 테스트만 실행 | `pnpm run test:related -- src/domain/foo.ts` |
| changed-file lint만 빠르게 | `pnpm run lint:smart` |
| 커밋 직전 staged 범위만 확인 | `pnpm run check:staged` |
| 커밋 직전 staged lint만 확인 | `pnpm run lint:staged` |
| push 직전 브랜치 diff 기준 스마트 게이트 | `pnpm run git:prepush:smart` |

`check:smart` / `check:staged`는 현재 변경 범위를 보고 가능한 한 **가장 좁은 lane**으로 내려갑니다. docs-only 변경은 스킵하고, test-only 변경은 `typecheck`를 생략하며, source/config 변경은 필요한 `typecheck`와 changed-file lint를 먼저 실행합니다.

| 목표 | 명령 |
|------|------|
| 기본 단위 | `pnpm run test` |
| 스마트 기본 확인 | `pnpm run check:smart` |
| 스마트 staged 확인 | `pnpm run check:staged` |
| changed-file lint | `pnpm run lint:smart` |
| CI에 가까운 단위 | `pnpm run test:unit` |
| HTTP + 통합 | `pnpm run test:integration` |
| 전체 인메모리 e2e | `pnpm run test:e2e:fast` |
| 런타임/품질 e2e | `pnpm run test:e2e:runtime` |
| 최소 계약 스모크 | `pnpm run test:e2e:contract` |
| 품질 + eval 단위 | `pnpm run test:quality` |
| 커버리지 리포트 | `pnpm run test:coverage` |
| Vespa(Docker 기동) | `pnpm run test:e2e:vespa` |
| 스마트 pre-push 게이트 | `pnpm run git:prepush:smart` |

---

<h2 id="what-this-codebase-implements-capabilities">이 코드베이스가 구현하는 것(기능)</h2>

요약 **기능 체크리스트**(파이프라인 단계·엔드포인트·알고리즘은 위 2–5절). 상세: **RFC** + 소스.

### 검색·리트리벌

- **쿼리 계획** — 플래너, 모호성 사전, 앵커 추출, NL 속성 매핑, 제약·의도 처리 (`src/domain/query/`, `src/application/search/`).
- **엔터티 해소** — 블로킹, 스코어링, 캘리브레이션, 선택적 **학습형 매처** HTTP 블렌드; 학습 경로용 **후보별 매처 피처 벡터** (`learned-matcher-features.ts`, `resolver.ts`에서 연결).
- **별칭 매칭** — **문자 n-gram** 퍼지 인덱스 포함 다단계 퍼널 (`CharNgramIndex`, `alias-matcher.ts`).
- **검색** — 후보 풀, 퓨전, browse/compare 리트리버, **Vespa** 검색 인덱스 어댑터, 하이브리드·dense-sparse 라우팅.
- **랭킹** — 시그널, 증거, 선택적 **LTR** 스타일 리랭크 훅 (`domain/ranking/`, 애플리케이션 파이프라인).
- **의사결정·응답** — 의사결정 엔진, 임계 프로필, 응답 빌더; **음주 가능 기간** 힌트(ONNX 또는 휴리스틱 정책) (`domain/drinking-window/`, `infrastructure/ml/`).
- **Mixed·유사도** — 앵커 + 유사 이웃용 mixed 솔버 (`domain/mixed/`).
- **캐싱** — 검색 응답 캐시 포트 + 연결 시 Redis (`domain/performance/`).

### 보안·품질 게이트

- **쿼리 새니타이제이션**, **쿼리 진입 보안**(인젝션·남용 휴리스틱, 선택적 LLM 판정 경로).
- **속도 제한** (`@fastify/rate-limit`), 구조화된 **에러 계약**(RFC-014 스타일), snake_case 응답 훅.

### 데이터·ETL(Postgres 사용 시)

- **ETL** — Silver/NDJSON 파이프라인, 별칭 생성, **규칙 기반 KO 음역** 배치 작업 (`scripts/etl/generate-transliteration-aliases.ts`, `Transliterator`), Vespa 인덱싱 헬퍼 (`scripts/etl/index-to-vespa.ts`, …).

### 통합

- **Claude 도구** — 에이전트 주도 검색용 도구 실행기 + HTTP (`interface/claude-tools/`).
- **Eval·품질** — 오프라인 eval, 노이즈 엔터티 eval, 베이스라인 회귀 스크립트 (`scripts/eval/`), 스플릿 검증; CI는 스모크 + 베이스라인 검사.

### 인프라 어댑터(일부)

- Postgres 레포지토리(별칭, 블로킹, 캘리브레이션, 임계값 저장 등).
- Vespa 클라이언트, 임베딩 HTTP 클라이언트, 리랭커 HTTP 클라이언트, 학습형 매처 HTTP 어댑터.
- 기동 시 eval을 위한 선택적 eval 러너 배선 (`infrastructure/eval/`).

---

<h2 id="repository-structure">저장소 구조</h2>

### 루트(선택)

| 경로 | 역할 |
|------|------|
| `src/` | 애플리케이션, 도메인, 인프라, 인터페이스, 설정 |
| `test/unit/` | 영역별 단위 테스트 |
| `test/integration/` | HTTP, DB 헬퍼, 라우트 계약 |
| `test/e2e/` | 계약 스모크, Vespa 레인, 네트워크 서비스 테스트 |
| `scripts/` | ETL, eval, Vespa 레인 셸 래퍼, HTTP 계약 내보내기 |
| `scripts/etl/` | NDJSON / Silver 파이프라인, 음역, index-to-Vespa, 검증 |
| `vespa/app/` | Vespa 스키마(`schemas/`), `services.xml`, `hosts.xml`, 쿼리 프로파일 |
| `data/` | eval 쿼리, 베이스라인, 스모크 예측(대용량 — 커밋 전 검토) |
| `docs/` | RFC, 계획, 런북; **`docs/archive/`**(날짜별 메모); **`docs/sessions/`**(예: 버그배시) |
| `models/` | 선택 ONNX / 모델 번들(음주 가능 기간 문서 참고) |
| `docker-compose.yml` | 전체 개발 스택(**프로젝트 `wine-search-dev`**) |
| `docker-compose.test.yml` | 임시 테스트 DB / 대체 포트(**프로젝트 `wine-search-test`**) |
| `Dockerfile` | Node API용 멀티스테이지 프로덕션 이미지 |
| `.github/workflows/` | CI(lint, typecheck, 테스트, eval 게이트, Docker 빌드) |

### `src/` 레이아웃(도메인 주도)

| 경로 | 책임 |
|------|------|
| `src/main.ts` | 프로세스 진입; 설정, 런타임 핸들, 컨테이너, HTTP 서버 로드 |
| `src/config/` | `env.ts`, **구성 루트** (`container.ts`, `container-core.ts`, `container-features.ts`, …), 준비 상태 |
| `src/domain/` | 바운디드 컨텍스트: **query**, **resolver**, **alias**, **retrieval**, **ranking**, **decision**, **response**, **mixed**, **security**, **entity**, **ingestion**, **evaluation**, **performance**, **drinking-window**, **attribute**, **shared**(타입, 에러, 유틸) |
| `src/application/` | **Search**(오케스트레이션 + 분할 헬퍼), **resolve**, **hybrid**, **batch**, **replay**, **interpret**, **drinking-window**, **wine-search/agent** 유스케이스 |
| `src/infrastructure/` | **어댑터**(Postgres, HTTP ML), **db** + 마이그레이션, **vespa/**, **ml/**(ONNX 음주 가능 기간), 공유 클라이언트 **redis**, **telemetry**, **eval** |
| `src/interface/` | **http/** 라우트, 스키마, 미들웨어, 에러; **claude-tools/**; **cli/** |

### HTTP 라우트(개념)

**`src/interface/http/routes/http-route-contract-catalog.ts`**에 선언(`route-contracts.ts`와 함께 근원). health/ready, primitive search 4종, agent surface만 현재 공개 HTTP surface에 포함됩니다.

### 테스트

Vitest 레인, 커버리지 범위, 파일별 E2E 의도는 위 **테스트·커버리지·E2E 시나리오** 참고.

| 위치 | 역할 |
|------|------|
| `src/**/__tests__/` | 동반 단위 테스트 |
| `test/unit/` | 집중 단위 스위트 |
| `test/integration/` | 서버, HTTP 계약, 스키마, 선택 정책 테스트 |
| `test/e2e/` | 인메모리 HTTP e2e(`inject`) + 라이브 검색용 `vespa/` |
| `config/vitest/*.config.ts` | 분리 설정: 단위, 통합, e2e, 스모크, Vespa, 품질 |

---

<h2 id="prerequisites">전제 조건</h2>

- **Node.js ≥ 22** 및 **pnpm** (`corepack enable` — `package.json`의 `packageManager` 필드로 버전 고정)
- **Docker** + Docker Compose v2(의존 서비스 권장)
- 선택: **Semgrep**(`pnpm run semgrep`), Vespa/ML 로컬 도구

---

<h2 id="bootstrap">부트스트랩</h2>

```bash
git clone <internal-remote> wine-search-engine
cd wine-search-engine
corepack enable
pnpm install --frozen-lockfile
# npm/yarn/bun으로는 설치되지 않습니다(preinstall 가드). 예외 자동화만 SKIP_PNPM_ONLY_CHECK=1.
cp .env.example .env
# .env 편집 — PG_*, REDIS_URL, VESPA_URL, ML URL, 시크릿.
```

실질적 변경을 머지하기 전: **`pnpm run lint`**, **`pnpm run typecheck`**, 담당 영역 테스트.

로컬에서 빌드 산출물·대형 로컬 캐시·임시 워크트리·`node_modules`를 비우려면 **`pnpm run clean:worktree`** 후 **`pnpm install --frozen-lockfile`**. 루트 의존성만 다시 외부화하려면 **`pnpm run deps:link`**. pnpm 패키지 스토어는 **`.npmrc`의 `store-dir`**로 `~/.wine-search-engine/store/pnpm`에 두어 클론 밖에 유지합니다(일부 패키지 postinstall이 내부적으로 `npm`을 호출하면 `store-dir`에 대한 무해한 경고가 나올 수 있음).

---

<h2 id="configuration-env">설정 (`.env`)</h2>

**`.env.example`**을 복사해 시작. 주요 그룹:

| 그룹 | 예시 |
|------|------|
| Core | `NODE_ENV`, `PORT`, `LOG_LEVEL`, `HTTP_RATE_LIMIT_MAX`, `CORS_ALLOWED_ORIGINS` |
| Postgres | `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD` — 비밀번호 비우면 여러 경로에서 PG 풀 생략 |
| Redis | `REDIS_URL` |
| Vespa | `VESPA_URL`, `VESPA_CONTENT_CLUSTER` |
| ML HTTP | `EMBEDDING_SERVICE_URL`, 선택 `COHERE_API_KEY`/`COHERE_RERANK_MODEL`, `RERANK_BLEND_SCALE`, 선택 `LEARNED_MATCHER_SERVICE_URL` |
| Anthropic | `ANTHROPIC_API_KEY`(선택 기능) |
| 음주 가능 기간 | 기본 deterministic runtime, 선택 `DRINKING_WINDOW_MODEL_DIR`(ONNX override) |
| 킬 스위치 | `KILL_SWITCH_ALIAS_OVERLAY`, `KILL_SWITCH_LEARNING`, `KILL_SWITCH_DENSE_RETRIEVAL`, `KILL_SWITCH_INJECTION_JUDGE`, `KILL_SWITCH_QUERY_CACHE` |
| 테스트 | `PG_TEST_URL` — 테스트 Compose에서는 `postgresql://wine:wine_test@localhost:5433/wine_engine_test` 등 |

대용량 NDJSON/JSONL 자산은 저장소 안 `data/`보다 `~/.wine-search-engine/data`에 두는 쪽이 기본 운영값에 가깝습니다. `resolveDataPath('data/...')`를 쓰는 스크립트와 테스트는 이 홈 디렉터리가 있으면 자동으로 그쪽을 우선 사용합니다.

```bash
bash scripts/data/move-local-data-to-home.sh
bash scripts/deps/link-external-node-modules.sh
bash scripts/build/link-external-artifacts.sh
```

루트 `node_modules`는 `link-external-node-modules.sh`로 **`WINE_DEPS_DIR`(기본 `~/.wine-search-engine/deps`)** 밖으로 옮길 수 있습니다. `web/node_modules`는 Next/Turbopack 제약 때문에 **저장소 안의 실제 디렉터리**로 두는 것이 안전합니다. `dist`/`.next`/coverage 등은 `link-external-artifacts.sh`가 **`WINE_BUILD_DIR`(기본 `~/.wine-search-engine/build`)** 쪽으로 옮기고 레포에는 심볼릭 링크만 둡니다.

**Docker Compose (`docker-compose.yml`)**는 **`app`** 서비스 환경을 설정해 **`postgres`**, **`redis`**, **`vespa`**를 DNS으로 해석; 임베딩은 **`host.docker.internal`**로 호스트 서비스를 쓸 수 있음. 리랭커는 Cohere API(`COHERE_API_KEY`)를 사용합니다.

---

<h2 id="running-the-api">API 실행</h2>

```bash
pnpm run dev          # tsx watch src/main.ts
pnpm run build && pnpm run start   # dist/main.js
```

---

<h2 id="docker-compose">Docker Compose</h2>

스택 두 가지; **한 머신에서 충돌하는 호스트 포트로 Vespa 두 개를 동시에 띄우지 않도록** 주의.

### 전체 스택 — `docker-compose.yml` (**`wine-search-dev`**)

```bash
docker compose up -d --build
```

| 서비스 | 호스트 포트 | 비고 |
|--------|-------------|------|
| API | `3000` | |
| Postgres | `5432` | `wine_engine` / `wine_dev`(파일 참고) |
| Redis | `6379` | |
| Vespa | `8080`, 설정 `19072`→`19071` | 호스트 `VESPA_URL`: `http://localhost:8080` |
### 테스트 레인 — `docker-compose.test.yml` (**`wine-search-test`**)

```bash
docker compose -f docker-compose.test.yml up -d
```

| 서비스 | 호스트 포트 |
|--------|-------------|
| Postgres | `5433` — `wine_engine_test` |
| Redis | `6380` |
| Vespa | `18080`, `19071` — `VESPA_URL`: `http://localhost:18080` |

---

<h2 id="database-migrations">DB 마이그레이션</h2>

SQL: `src/infrastructure/db/migrations/*.sql` (실행 순서는 파일명 정렬).

- **`pnpm run migrate`** / **`pnpm run migrate:from-env`** — **`.env`의 `DATABASE_URL` / `PG_*`** 그대로 사용 (기본 워크플로: RDS 등 관리형 Postgres + `PG_SSL`).
- **`pnpm run migrate:local-docker`** — `docker-compose.yml`의 Postgres만 대상으로 고정(`pnpm run docker:db:up` 후).

```bash
pnpm run migrate
# 선택: 로컬 Docker PG만 쓸 때
# pnpm run docker:db:up && pnpm run migrate:local-docker
```

체크아웃에서 한 줄 실행이 필요하면 **tsx** 예시는 `scripts/migrate-from-env.ts` / `scripts/migrate-local-docker-pg.ts`를 참고.

---

<h2 id="scripts--pnpm-commands-reference">스크립트·pnpm 명령(참고)</h2>

| 영역 | 명령 |
|------|------|
| 품질 | `pnpm run lint`, `pnpm run typecheck`, `pnpm run test`, `test:coverage`, `test:unit`, `test:integration`, `test:e2e:*`, `test:quality*`, `test:verification:noisy`, `test:verification:core`, `test:verification:vespa` |
| HTTP 계약 | `pnpm run contracts:http` |
| Eval | `pnpm run eval`, `eval:offline:*`, `eval:noisy*`, `eval:sota:parallel` |
| ETL | `pnpm run etl:transliteration`, 추가 `scripts/etl/*.ts`(별칭, index-to-vespa, validate-silver, …) |
| 운영 | `pnpm run bootstrap:smoke`, `pnpm run migrate` (`.env` DB), `pnpm run migrate:local-docker` (Docker PG), `verify:drinking-window-model`, `vivino:bronze`, `finetuning:prepare` |

많은 ETL/eval 호출은 **`npx tsx --env-file=.env …`**를 씁니다.

---

<h2 id="ci-github-actions">CI (GitHub Actions)</h2>

잡에 **lint**, **typecheck**, **unit**, **integration**, **e2e fast**, **verification-core** (`test:verification:noisy`: gate 1회 + 베이스라인 assert만), **verify-splits**, 이후 **build** + **Docker 이미지 빌드** 포함. 공통 단계는 **`.github/actions/setup-node-ci`**(checkout + Node 22 + `pnpm install --frozen-lockfile`). **수동 실행:** Actions에서 `workflow_dispatch`. 노이즈 스모크 JSON은 로컬 `eval:noisy:smoke`. **`.github/workflows/ci.yml`** 참고.

---

<h2 id="http-surface-quick-reference">HTTP 표면(빠른 참고)</h2>

**전체 라우트 목록**(메서드·경로 전부): [HTTP API: 진입점·요청 흐름](#http-api-entry-points--request-flow).

| 주제 | 비고 |
|------|------|
| 준비 상태 | `GET /ready` — `src/config/readiness.ts`의 의존성 프로브 |
| agent | `/v1/agent`, `/v1/agent/sessions`, `/v1/agent/sessions/:sessionId/turns` |
| 음주 가능 기간 | ONNX 번들: **`docs/drinking-window-model-bundle.md`** |

---

<h2 id="further-reading">추가 읽을거리</h2>

- **`docs/RFC-*.md`** — 프로토콜·동작(엣지 케이스의 근원).
- **`CLAUDE.md`** — 짧은 아키텍처 + 명령 치트시트.
- **`docs/eval-baseline-runbook.md`** — 오프라인·노이즈 베이스라인 갱신·검증.
- **`docs/archive/2026-04-root-notes/`** — 에픽/디버깅/웨이브/태스크 메모(루트에서 이전).
- **`docs/sessions/bugbash-apr-6/`** — 2026년 4월 버그배시 감사·수정 백로그.

**읽는 순서(신규):** 빠른 시작 → 문서 지도 → 부트스트랩·Docker → 아키텍처·HTTP 흐름 → 평가·테스트 → 담당 영역 RFC.

---

<h2 id="license--distribution">라이선스·배포</h2>

소속 조직에서 달리 정하지 않는 한 내부용.

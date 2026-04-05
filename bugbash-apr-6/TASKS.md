# Bug bash 작업 목록 (근거 포함)

## 범위

- **기준 플랜**: `docs/plans/apr-5-v0.1/00-overview.md` 및 epic-1 … epic-11, `docs/plans/apr-5-v0.2/00-overview.md` 및 epic-12 … epic-17.
- **검증 시점**: 저장소 정적 분석 + 대표 파일 내용 확인. CI는 `npm run typecheck` / `npm run test` 통과 전제.
- **한 줄 색인**: [`GAPS.md`](./GAPS.md) (`G-01` … `G-37`).

---

### O. 9차 패스 — 스키마/부트스트랩/헬스체크 (`BACKLOG.md` §45–48)

| ID | 요약 |
|----|------|
| **45** | watchlist response/error schema 대부분이 런타임에서 미사용 — schema drift 감지 실패. |
| **46** | `createServer()`가 전역 `config` singleton에 직접 의존 — injected wiring 불완전. |
| **47** | `main.ts`는 optional pool 설계와 달리 항상 PG pool을 강제 생성. |
| **48** | `/ready`가 실제 dependency 상태와 무관하게 항상 `ready: true`. |

**재현 (9차):**

```bash
rg -n "GetWatchlistResponseSchema|CreateWatchlistResponseSchema|WatchlistErrorResponseSchema" src test --glob "*.ts"
sed -n '1,120p' src/interface/http/server.ts
sed -n '1,80p' src/main.ts
sed -n '1,60p' src/infrastructure/db/pg-pool.ts
sed -n '1,80p' src/interface/http/routes/health.route.ts
```

### N. 8차 패스 — 구조 빵꾸 누적 (`BACKLOG.md` §39–44)

| ID | 요약 |
|----|------|
| **39** | `Ranker`가 `infrastructure/ml/label-encoder`를 직접 import — `domain -> infrastructure` 누수. |
| **40** | `LLMInjectionJudge`가 `RedisClient` 타입에 직접 결합 — 보안 도메인 cache port 부재. |
| **41** | watchlist HTTP가 여전히 route-local in-memory CRUD — infra/runtime path와 분리. |
| **42** | watchlist ID 계약이 `nanoid` / UUID schema / test 기대값 사이에서 충돌. |
| **43** | route/container 계약이 아직 `Pick<ConcreteClass, 'method'>` 수준 — explicit port 미완료. |
| **44** | watchlist subscriber/webhook lifecycle이 서버 startup/shutdown 경로에 미배선. |

**재현 (8차):**

```bash
sed -n '1,40p' src/domain/ranking/service/ranker.ts
sed -n '1,40p' src/domain/security/service/llm-injection-judge.ts
sed -n '1,120p' src/interface/http/routes/watchlist.route.ts
sed -n '1,120p' src/interface/http/schemas/watchlist.schema.ts
sed -n '1,80p' src/interface/http/routes/route-deps.ts
sed -n '1,80p' src/config/container-contracts.ts
rg -n "subscriber.start|subscriber.stop|publishUpdate\\(" src --glob "*.ts"
```

## P0 — 플랜에 명시된 동작이 스텁이거나 파이프라인 미연결

### 1. Browse / Compare retrieval 구현 또는 플랜 정합성 정리

**해야 할 일**

- `BrowseRetriever.browseProducer` / `browseRegion`이 실제 인덱스 조회·랭킹을 수행하도록 구현하거나, 플랜에서 해당 Epic 범위를 “스텁 허용”으로 문서 수정.
- `CompareRetriever.compareToAnchor` 동일.

**근거**

- ```33:50:src/domain/retrieval/service/browse-retriever.ts
  browseProducer(
    _producerName: string,
    ...
  ): Promise<readonly HybridCandidate[]> {
    ...
    // For now, return empty to allow compilation.
    return Promise.resolve([]);
  }
  ```
- ```58:79:src/domain/retrieval/service/compare-retriever.ts
  compareToAnchor(
    ...
  ): Promise<readonly ComparisonCandidate[]> {
    ...
    // For now, return empty.
    return Promise.resolve([]);
  }
  ```
- 플랜: `docs/plans/apr-5-v0.1/epic-10-similar-compare-browse.md` — producer/region browse, comparison table 반환 등 완료 기준.

**완료 정의**

- 최소: `SearchUseCase` 또는 동등 오케스트레이션에서 위 메서드가 호출되고, 비어 있지 않은 후보가 나올 수 있는 통합 테스트 1개 이상.
- 또는: 플랜 문서에 “현재 스텁” 명시 + 이 TASK를 P2로 하향.

---

### 2. Planner가 `producer_browse` / `region_browse`를 선택하지 않음

**해야 할 일**

- `QueryIntent`·앵커·타겟 타입 등과 맞춰 `determineRetrievalMode`에 `producer_browse`, `region_browse` 분기 추가.
- 또는 의도적으로 미지원이면 `RETRIEVAL_MODES`·`mode-weights`·캐시 키와 주석을 정리해 **데드 모드**를 없앨 것.

**근거**

- 플랜 `docs/plans/apr-5-v0.1/epic-7-retrieval-modes.md` 결정 로직 예시: `entity_exact + producer name only → producer_browse`, `facet_search + region keyword → region_browse`.
- `planner.ts` 내 `determineRetrievalMode` 검색 시 `producer_browse` / `region_browse` 문자열 **미등장** (정적 검색으로 확인).

**완료 정의**

- “안티노리”류 쿼리에 대해 플랜이 기대하는 모드로 `QueryPlanV1.retrievalMode`가 설정되는 단위/통합 테스트.

---

### 3. `ResultGrouper`가 응답 경로에 없음

**해야 할 일**

- `ResultGrouper.group()`을 `response-builder` 또는 `SearchUseCase` 결과 조립 단계에 연결하거나, 미사용이면 export/문서 정리.

**근거**

- 구현: `src/domain/response/service/result-grouper.ts`.
- `ResultGrouper` 심볼 참조가 **해당 파일에만** 존재 (`rg ResultGrouper src` → `result-grouper.ts` only).
- 플랜: `docs/plans/apr-5-v0.1/epic-8-entity-index-surface.md` — Option A 집계 레이어.

**완료 정의**

- `targetEntityType`이 `producer`/`region`일 때 `SearchResponseV1`에 `resultType`·그룹 메타가 일관되게 반영되는지 테스트.

---

## P1 — v0.2 플랜 대비 미구현·불일치

### 4. ConstraintSAT (하드 제약 모순) 미구현

**해야 할 일**

- `src/domain/query/service/constraint-sat.ts`(가칭)에 `ConstraintBundle` 모순 검사 구현.
- `SearchUseCase.execute`에서 planner 이후·retrieval 이전에 호출, 모순 시 실패 응답(플랜: `HARD_CONSTRAINT_VIOLATION` 등).

**근거**

- 플랜: `docs/plans/apr-5-v0.2/epic-13-query-intelligence.md` Step 13.1, SearchUseCase 통합 예시 코드.
- `search.usecase.ts`에 `constraintSAT` / `ConstraintSAT` **미등장**.

**완료 정의**

- `"dry sweet wine"` 등 플랜 표의 케이스에 대한 단위 테스트 + (가능하면) HTTP 레벨 스모크.

---

### 5. Golden 데이터: 플랜 파일명과 실제 산출물 불일치

**해야 할 일**

- 플랜은 `data/golden-queries-silver.jsonl`, `data/golden-queries-gate.jsonl`를 Deliverable로 명시.
- 현재 `data/`에는 `golden-queries-bronze.jsonl`만 있고, 분할은 `data/splits/train.jsonl`, `val.jsonl`, `gate.jsonl` 형태.

**근거**

- `docs/plans/apr-5-v0.1/epic-2-golden-query-set.md` Deliverables 표.
- `ls data/golden-queries*.jsonl` → bronze만 존재.

**완료 정의**

- (A) silver/gate JSONL을 생성해 플랜과 동일한 경로에 두거나, (B) 플랜을 `splits/*.jsonl` 워크플로로 업데이트하고 `run-offline-eval` 문서/기본 인자를 맞출 것.

---

### 6. Epic 14 LLM Decomposer 부재

**해야 할 일**

- 패턴 분해 실패 시 `llm-decomposer` 폴백 구현 또는 플랜에 “패턴만 지원”으로 한정.

**근거**

- 플랜: `docs/plans/apr-5-v0.2/epic-14-decomposition-api.md` Step 14.1.2.
- 저장소에 `llm-decomposer.ts` **없음**; `decomposition-detector.ts` + `DecomposedSearchUseCase`만 존재.

---

## P2 — 문서·산출물·운영 정합성

### 6b. Planner `plan()` JSDoc이 구현과 불일치

**해야 할 일**

- `src/domain/query/service/planner.ts` 파이프라인 단계 7번 설명을 실제 동작에 맞게 수정: `parseConstraints`는 `NLMapper` 기반이며 빈 번들이 아님.

**근거**

- 주석: "Parse constraints (placeholder -- returns empty bundle)." (`planner.ts` 114행 근처)
- 구현: `parseConstraints` → `nlMapper.mapConstraints` (`planner.ts` 557행~).

**완료 정의**

- JSDoc만 갱신; 동작 변경 없음.

---

### 6c. 루트 `test-search-direct.ts`가 ESLint/tsconfig에 없음

**해야 할 일**

- `eslint.config` ignore에 추가하거나, `tsconfig`에 포함하거나, 스크립트를 `scripts/`로 옮겨 프로젝트 그래프에 넣기.

**근거**

- `npm run lint` 시 `parserOptions.project` 파싱 에러 (해당 파일).
- 2026-04-06 감사: 전체 **214** ESLint errors 중 일부 원인.

---

### 6d. Drinking window ONNX (`onnxruntime-node`)

**해야 할 일**

- 의존성 추가 후 `DrinkingWindowPredictor.load`에서 세션 생성 주석 해제, 또는 “의도적 휴리스틱”을 README/RFC에 명시.

**근거**

- `src/infrastructure/ml/drinking-window-predictor.ts` 65–71 TODO 및 stub `console.warn`.

---

### 7. Epic 4 Python/LightGBM 스크립트 경로 vs 실제 구현

**해야 할 일**

- 플랜의 `scripts/ltr/feature-schema.ts`, `collect-training-data.ts`, `train_lambdamart.py`가 메인 트리에 없음. 대신 `src/domain/ranking/service/lambdamart-ranker.ts`, `scripts/eval/run-eval-and-train-ltr.ts` 등 **TS 파이프**가 있음.
- 문서를 실제 진입점에 맞게 수정하거나, 누락 스크립트를 추가해 재현성을 맞출 것.

**근거**

- 플랜: `docs/plans/apr-5-v0.1/epic-4-ltr.md` Deliverables.
- `scripts/ltr/` 실제 파일: `finetune_embedding.py`, `distill_cross_encoder.py`, `generate-triplets.ts`, `reindex-embeddings.ts`, `validate-embedding.ts` 등 (feature-schema/collect-training-data/train_lambdamart 없음).

---

### 8. Silver 품질 리포트 vs Epic 1 숫자 목표

**해야 할 일**

- `data/silver-quality-report.json`의 `totalBronzeRows`/`afterDedup`가 플랜의 “≥8000”, “10K” 서술과 맞는지 확인. 불일치 시 플랜 또는 데이터 파이프라인 쪽 목표를 현실 값으로 갱신.

**근거**

- `data/silver-quality-report.json`에 `totalBronzeRows`: 7040 등 (플랜 `epic-1-etl-pipeline.md` 완료 기준과 대조 필요).

---

### 9. Epic 17 Watchlist — 문서 아키텍처 vs 구현 단계

**해야 할 일**

- `watchlist.route.ts` 주석: in-memory store 등 **프로덕션 전** 상태. Redis pub/sub·웹훅은 `src/infrastructure/watchlist/*` + 테스트로 존재.
- Vespa 인덱스 변경 → 워처 → 웹훅 전체 플로가 플랜과 같이 필요한지 확정하고, 부족하면 TASK 분해.

**근거**

- 플랜: `docs/plans/apr-5-v0.2/epic-17-agentic-async.md` Step 17.1.
- `src/interface/http/routes/watchlist.route.ts` 인메모리 스토어 사용.

---

### 10. Eval: `mode-metrics.ts` 파일명 vs 통합 구현

**해야 할 일**

- 플랜의 별도 `scripts/eval/mode-metrics.ts`는 없으나, `scripts/eval/metrics.ts`에 `ModeMetrics`·`by_mode` 등이 있음. 문서만 수정할지, 모듈 분리할지 결정.

**근거**

- 플랜: `docs/plans/apr-5-v0.1/epic-11-eval-extension.md` Deliverables.
- `scripts/eval/run-offline-eval.ts`에 `MODE_RELEASE_GATES`, `retrieval_mode` 관련 로직 존재.

---

## Bug bash에서 권장 순서

1. P0-2 → P0-1 → P0-3 (모드·browse·그룹핑이 한 줄에 연결됨)
2. P1-4 (제약 모순)
3. P1-5, P1-6 (데이터·분해)
4. P2 (문서·운영)

---

## 참고: 이미 잘 맞는 것으로 확인된 항목 (이번 bug bash에서 우선 제외 가능)

- `RetrievalMode` 타입 및 `QueryPlanV1.retrievalMode` (`src/domain/query/model/retrieval-mode.ts`, `query-plan.ts`).
- LLM envelope 필드: `SearchResponseV1`, `ResultItem.matchReasons` / `violatedConstraints`, `parsedConstraints`, `EngineDecision.abstainReason` (`search-response.ts`, `result-item.ts`, `engine-decision.ts`, `response-builder.ts`).
- Epic 16: `QuerySanitizer`, `LLMInjectionJudge`, `POST /v1/batch-search` (`domain/security`, `application/search/batch-search.usecase.ts`, 라우트·테스트).
- Epic 5: `services/reranker/`, `docker-compose.yml` reranker, `ranker.ts`의 `buildWineText`.
- Vespa 스키마: `critic_proxy_*`, `organic`, `biodynamic`, `pairing_tags` (`vespa/app/schemas/wine_entity.sd`).
- Golden bronze 500행: `data/golden-queries-bronze.jsonl`에 `leakage_keys`, `retrieval_mode` 필드 존재.

이 목록은 추가 코드 변경 없이도 재검증 가능하도록 파일 경로를 남겼습니다.

---

## 심화 감사 — 추가 빵꾸·보완점 (2026-04-06)

정적 분석·대표 파일 열람으로 **위 표에 없거나 보강할 근거**를 더 적음.

### A. 문서/주석 부채 (동작은 있는데 설명이 틀림)

| 항목 | 해야 할 일 | 근거 |
|------|------------|------|
| **Planner 파이프라인 주석 (7번 단계)** | 클래스 상단 JSDoc에서 “Parse constraints (**placeholder — returns empty bundle**)” 문구 삭제 또는 “NLMapper + rule fallback”으로 수정. | `src/domain/query/service/planner.ts` 104–114행 주석 vs 실제 `parseConstraints()`(557행~)·`extractRuleBasedConstraints()` 구현 불일치. |
| **Epic 13 “dry sweet” 모순** | `extractRuleBasedConstraints`에서 `sweetness`가 **if / else if** 체인이라 한 쿼리에 dry·sweet 토큰이 동시에 있어도 **하나만** 들어갈 수 있음. 모순 검출(SAT) 없이도 “둘 다 번질” 가능성은 낮지만, **의도적 모순 문장**은 ConstraintSAT 또는 규칙 보강 필요. | `planner.ts` 715–734행 근처 `if (dry) … else if (sweet)`. |

### B. v0.2 데이터·쿼리 경로 (이전 감사 보강)

| 항목 | 해야 할 일 | 근거 |
|------|------------|------|
| **`extractPairingConstraint` 미배선** | 쿼리 타임에 페어링 태그 제약 또는 Vespa 필터로 연결. 현재는 ETL `generate-pairings.ts`만 `pairing-extractor`를 import. | `rg "extractPairingConstraint|pairing-extractor"` → 도메인 검색 경로 **0건** (스크립트 제외). |
| **`pairing_tags` vs `pairing`** | 인덱스 필드 두 개 공존(`wine_entity.sd`). 매핑은 `pairing`만; taxonomy 필드는 **미채움** 가능성. | `src/infrastructure/vespa/mapping.ts`에 `pairing_tags` 문자열 없음(이전 감사와 동일, 심화 확인). |
| **Critic proxy·organic 등** | TASKS P1 및 상단 항목과 동일 — **도메인 모델·매핑 부재** 재확인. | `mapping.ts`에 `critic_proxy`/`organic`/`biodynamic` 없음. |

### C. API 계약·배치 시맨틱스

| 항목 | 해야 할 일 | 근거 |
|------|------------|------|
| **Injection 차단 시 HTTP 상태** | 플랜(Epic 16)은 400 언급. `POST /v1/search`는 응답 본문만 `failed`/`POLICY_BLOCKED`이고 **항상 200**. 클라이언트·모니터링 기준 확정. | `src/interface/http/routes/search.route.ts` 44행 `reply.status(200)`. |
| **배치에서 정책 차단을 `succeeded`로 카운트** | `SearchUseCase.execute`가 throw하지 않고 실패 본문을 반환하면 `executeSingle`은 **무조건 `status: 'succeeded'`**. injection·POLICY_BLOCKED를 배치 실패로 보려면 `engineDecision.decisionStatus`/`failure_reason` 검사 추가. | `batch-search.usecase.ts` 307–316행. |
| **`fail_fast` 병렬 시작** | 모든 서브요청이 동시에 `execute`에 들어감; 첫 실패 후 `AbortController`는 **이미 돌아간 요청을 취소하지 못함**. “첫 실패 시 나머지 미실행”이 요구사항이면 순차/큐 모델 또는 문서 완화. | `executeFailFast` 234–268행. |

### D. 구현 스텁·TODO (코드 표식)

| 항목 | 위치 | 내용 |
|------|------|------|
| Drinking window ONNX | `src/infrastructure/ml/drinking-window-predictor.ts` | `TODO` onnxruntime, stub mode 경고. |
| `check_drinking_window` | `src/interface/claude-tools/tool-executor.ts` 215–230행 | entity 조회 미구현, placeholder `error` 객체 반환. |
| 캐시 | `src/application/search/search.usecase.ts` 상단 주석 | 검색 캐시 경로 주석 처리·백로그 언급. |

### E. 재확인 커맨드 (심화 항목용)

```bash
# pairing 추출이 검색 파이프라인에 없음
rg "extractPairingConstraint" src --glob "*.ts"

# Planner 주석과 실제 parseConstraints 구현 대조
rg -n "placeholder|parseConstraints" src/domain/query/service/planner.ts | head -40

# 배치가 본문 실패를 성공으로 세는지 논의할 때
rg -n "status: 'succeeded'" src/application/search/batch-search.usecase.ts

# 매핑에 v0.2 스키마 필드가 빠졌는지
rg "critic_proxy|pairing_tags|organic" src/infrastructure/vespa/mapping.ts
```

### F. 권장 머지 순서 (심화 반영)

1. **문서/주석 정리** (A) — 비용 낮음, 혼동 감소.  
2. **배치 시맨틱스 결정** (C) — 제품 계약에 직결.  
3. **pairing_tags 쿼리 배선** (B) — Epic 12·13 교차.  
4. **ConstraintSAT** (기존 P1-4) — A와 합쳐 “dry sweet” 등 케이스 정의를 테스트로 고정.

### G. 제2패스 누적 (2026-04-06) — `BACKLOG.md` §24–30과 동일 주제

아래는 위 섹션 이후 **한 번 더** 훑어 보강한 항목이다. 상세 근거·파일 행 번호는 [`BACKLOG.md`](./BACKLOG.md)에 정리됨.

| ID | 주제 | 한 줄 |
|----|------|--------|
| **24** | API `query.max(2000)` vs sanitizer `500` | 스키마·보안 정책 길이 불일치 → 501–2000자 요청이 혼란스러운 실패 가능. |
| **25** | `missingInformation` | Epic 9 플랜 필드가 `SearchResponseV1`에 없음 — 구현 또는 플랜 정합성. |
| **26** | Vespa `ltr_v1` / LightGBM | 스키마에 2차 rank 없음 — 앱 LTR만 사용 시 문서에 명시. |
| **27** | 비교 테이블 | `ComparisonSearchResponse`는 축/테이블 구조 없음 — Epic 10·14 갭. |
| **28** | `tsconfig.build` LTR exclude | import 시 dist에 여전히 emit — exclude 의도 문서화. |
| **29** | Entropy abstain | 플랜 Epic 13 전용 레이어 vs 기존 confidence 경로 구분 필요. |
| **30** | Injection judge fail-open | API 실패 시 차단 완화 — 보안 정책 재검토. |

**재현 커맨드 (제2패스):**

```bash
# 길이 불일치
rg "max\(2000\)|MAX_QUERY_LENGTH" src/interface/http/schemas/search.schema.ts src/domain/security/service/query-sanitizer.ts

# missingInformation 부재
rg "missingInformation" src/domain/response

# Vespa LTR
rg -i "lightgbm|lambdamart|ltr_v1" vespa/

# 비교 응답 구조
rg "comparisonAxes" src/domain/response/model/comparison-response.ts
```

### H. 3차 패스 누적 (2026-04-06) — 런타임·스키마·부팅

**§G(24–30)와 중복되지 않는** 추가 확인만 기술.

> [`BACKLOG.md`](./BACKLOG.md) **§34–37**과 아래 표가 대응(워치리스트 ID/Redis/DB, `drinking_window_now` NL, `EVAL_RUN_AT_STARTUP`). **§31–33**은 `npm run eval`·pairing 미배선·인코더 중복 — 번호 충돌 없음.

| 항목 | 해야 할 일 | 근거 |
|------|------------|------|
| **Watchlist `watchlist_id` 타입** | 응답 스키마는 **UUID**, 구현은 **`nanoid()`** — Zod로 응답 검증 시 실패. 스키마를 `z.string().min(1)` 등으로 맞추거나 ID 생성을 UUID로 통일. | `watchlist.schema.ts` 61–62행; `watchlist.route.ts` nanoid; 테스트는 nanoid 패턴 기대(`watchlist-routes.test.ts` 53행). |
| **Redis subscriber 비가동** | `createServer`가 **`RedisWatchlistSubscriber`를 시작하지 않음** — pub/sub → 웹훅 체인이 프로세스 내에서 자동 기동되지 않음. | `rg "RedisWatchlistSubscriber" src/interface/http/server.ts` → **0건**; `server.ts`는 `registerWatchlistRoute`만. |
| **Watchlist DB 부재** | 마이그레이션에 watchlist 테이블 없음 — 인메모리만. | `rg -i watchlist src/infrastructure/db/migrations` → **0건**. |
| **`drinking_window_now` NL 단절** | Vespa `mapping.ts`는 YQL 분기 있으나 **`nl-mapper`에 drinking_window / ready-to-drink 매핑 없음** — 자연어가 해당 필터로 안 내려갈 수 있음. | `rg "drinking_window\|ready" src/domain/attribute` → **0건**; `mapping.ts`에 `case 'drinking_window_now'`만 존재. |
| **`EVAL_RUN_AT_STARTUP`** | `true` 시 부팅 직후 **전체 eval**이 백그라운드(수분) 실행 — 프로덕션 실수 방지 문서화. | `server.ts` 144–167행. |

**재현 커맨드 (3차):**

```bash
rg "nanoid|CreateWatchlistResponseSchema" src/interface/http/routes/watchlist.route.ts src/interface/http/schemas/watchlist.schema.ts
rg "RedisWatchlistSubscriber" src/interface/http/server.ts
rg -i watchlist src/infrastructure/db/migrations
rg "drinking|drinkable|ready" src/domain/attribute/service/nl-mapper.ts
rg "EVAL_RUN_AT_STARTUP" src/interface/http/server.ts
```

### I. 4차 패스 누적 (2026-04-06) — §G·H와 겹치지 않게 **추가만**

| 항목 | 해야 할 일 | 근거 |
|------|------------|------|
| **`determineRetrievalMode` 반환 집합** | `producer_browse` / `region_browse` / `no_match_detection` 문자열이 함수 본문에 **없음** — `RetrievalMode`·골든 `retrieval_mode` 태그와 런타임이 영구히 어긋날 수 있음. §P0-2·§G1과 동일 주제이나 **코드 인용**은 여기서만 상세히 둠. | 아래 코드 블록. |
| **`POST /v1/search`에 `retrieval_mode` 없음** | Epic 14 Step 14.2: top-level `retrieval_mode` — `SearchRequestSchema`는 여전히 `options.mode`만. 배치와 단일 검색 계약 불일치. | `src/interface/http/schemas/search.schema.ts` 29–35행. |
| **`parsedConstraints.unparsed` 고정** | 구조화 실패 조각을 채우거나 Epic 9 플랜의 `missingInformation`과 통합. | `response-builder.ts` `unparsed: []`. §G-25와 연결. |
| **CI에 `verify-splits` 없음** | PR 게이트에 스크립트 추가. | `.github/workflows/ci.yml`에 `verify-splits` 문자열 없음; `scripts/eval/verify-splits.ts`는 존재. |

**코드 인용 — `determineRetrievalMode` 전체에 `producer_browse` / `region_browse` / `no_match_detection` 분기 없음** (발췌):

```414:468:src/domain/query/service/planner.ts
  private determineRetrievalMode(
    intent: QueryIntent,
    anchors: readonly AnchorCandidate[],
    _normalizedQuery: string,
  ): RetrievalMode {
    const hasStrongAnchor = anchors.some(
      (a) => a.confidence >= EXACT_ANCHOR_CONFIDENCE,
    );
    const hasAnyAnchor = anchors.some(
      (a) => a.confidence >= ANCHOR_PRESENT_CONFIDENCE,
    );
    const hasMultipleCandidates = anchors.some(
      (a) => a.candidateEntityIds.length > 1,
    );

    if (intent === 'comparison_search') {
      return 'compare_candidates';
    }
    if (intent === 'entity_fuzzy' && hasMultipleCandidates) {
      return 'entity_resolution';
    }
    if (intent === 'entity_exact' && hasStrongAnchor) {
      return 'entity_lookup';
    }
    if (intent === 'mixed_query' && hasAnyAnchor) {
      return 'similar_items';
    }
    if (intent === 'pairing_search') {
      return 'recommendation';
    }
    if (
      (intent === 'facet_search' || intent === 'budget_search') &&
      !hasAnyAnchor
    ) {
      return 'constraint_filter';
    }
    if (intent === 'semantic_discovery') {
      return 'attribute_search';
    }
    return 'attribute_search';
  }
```

**재현 (4차):**

```bash
rg "producer_browse|region_browse|no_match_detection" src/domain/query/service/planner.ts
rg "retrieval_mode" src/interface/http/schemas/search.schema.ts
rg "unparsed: \[\]" src/domain/response/service/response-builder.ts
rg verify-splits .github/workflows/ci.yml
```

### K. 5차 패스 — [`BACKLOG.md`](./BACKLOG.md) §31–33과 동기화

| ID | 요약 |
|----|------|
| **31** | `package.json`의 `eval` → `scripts/run-eval.ts` **파일 없음** — `npm run eval` 실패. |
| **32** | `extractPairingConstraint` 등 **도메인 검색 경로에서 미import** (`pairing-extractor.ts`). |
| **33** | `wine-attribute-encoder.ts`와 `label-encoder.ts` **이중 정의** — `ranker`는 후자만 사용. |

---

### L. 6차 패스 (2026-04-06) — CI·온보딩·API 중복·관측

**§K와 겹치지 않는 항목만.** (31–33은 `BACKLOG`와 동일.)

| 항목 | 해야 할 일 | 근거 |
|------|------------|------|
| **CI에 `semgrep` 없음** | `package.json`에 `"semgrep"` 스크립트·`semgrep/wine-rules.yml`이 있으나 `.github/workflows/ci.yml`에는 **미실행**. 보안/패턴 회귀를 PR에서 잡으려면 job 추가 또는 nightly. | `rg semgrep .github` → 0건. `package.json` `scripts.semgrep` 존재. |
| **CI에 E2E / Vespa E2E 없음** | `test:e2e`, `test:e2e:vespa`는 수동·별도 인프라 전제. 의도면 README/RUNBOOK에 “CI 범위 밖” 명시. | `ci.yml`에 vitest e2e 호출 없음. |
| **`/v1/search/hybrid` vs `POST /v1/search` + `options.mode: hybrid`** | 두 경로가 공존: `HybridUseCase`는 resolver 스킵·강제 hybrid (`hybrid.usecase.ts` 55–93행), 일반 검색은 플래너+`resolveRoute`. 클라이언트/문서에 **언제 어느 엔드포인트를 쓰는지** 한 표로 정리. | `hybrid.route.ts`, `search.usecase.ts` |
| **`POST /v1/entity/resolve`에 `request_id` 미전달** | `ResolveUseCase.execute`가 `requestId`를 받지 않음 — 로그·트레이스·스팬과 상관관계가 약함. 필요 시 시그니처·라우트 확장. | `resolve.route.ts` 15–19행; `resolve.usecase.ts` `execute(request)`만. |
| **루트 `test-search-direct.ts`** | ESLint `parserOptions.project`에 없으면 `eslint .` 시 파싱 에러(기존 BACKLOG §13). `tsconfig.eslint.json`의 `include`에 `test-search-direct.ts` 추가 또는 `eslint.config` `ignores`에 루트 스모크 파일 명시. | `Glob`로 루트 파일 존재; `tsconfig.eslint.json` include는 `src|test|tools|scripts`만. |

**재현 (6차):**

```bash
rg semgrep .github/workflows
rg "test:e2e" .github/workflows
rg "registerHybridRoute|HybridUseCase" src/interface/http src/application/search/hybrid.usecase.ts
head -5 src/interface/http/routes/resolve.route.ts src/application/search/resolve.usecase.ts
```

### M. 7차 패스 (2026-04-06) — Epic 16 **injection 우회** (`BACKLOG` §38, `GAPS` **G-40**)

`QuerySanitizer` / `LLMInjectionJudge`는 **`SearchUseCase.execute`에만** 연결되어 있다. 아래 엔드포인트는 **같은 `query` 문자열**로 플래너·리졸버까지 직접 들어가 **Layer 0 방어 없음**.

| 엔드포인트 | 유스케이스 | 근거 |
|------------|------------|------|
| `POST /v1/search/hybrid` | `HybridUseCase` | `hybrid.usecase.ts` — `plan(request.query)` 직행, sanitizer import 없음. |
| `POST /v1/interpret` | `InterpretUseCase` | `interpret.usecase.ts` — planner만 실행. |
| `POST /v1/entity/resolve` | `ResolveUseCase` | `resolve.usecase.ts` — planner + resolver. |

**예외 (안전):** `ReplayUseCase` → 내부적으로 `searchUseCase.execute` 호출 (`replay.usecase.ts` 124행). 배치 검색은 `SearchUseCase` 경유.

**재현:**

```bash
rg "QuerySanitizer|querySanitizer|injectionJudge" src/application --glob "*.ts"
# 기대: search.usecase.ts 에만 매칭
```

**완료 정의:** 위 세 유스케이스 시작부에 `SearchUseCase`와 동일한 sanitization+judge 순서 적용, 또는 라우트를 인증·내부 전용으로 격리 + 문서화.

---

### N. 8차 패스 (2026-04-06) — HTTP 계약·엣지 (`BACKLOG` §39–41, `GAPS` **G-46–G-48**, `FINDINGS-MATRIX` **M-36–M-38**)

| § | 주제 | 한 줄 근거 |
|---|------|------------|
| **§39** | CORS | `rg -i cors src` → **매칭 없음** — 브라우저 교차 오리진에서만 문제. |
| **§40** | Rate limit 끄기 | `HTTP_RATE_LIMIT_MAX=0` 이면 `server.ts`에서 `rateLimit` 플러그인 **미등록**. |
| **§41** | OpenAPI | `rg -i "openapi\|swagger" src` → **0건**. |

```bash
rg -i cors src || true
rg -i "openapi|swagger" src || true
rg HTTP_RATE_LIMIT src/config/env.ts
```

---

### P. 9차 패스 (2026-04-06) — 구조 수습 이후 남은 watchlist/runtime/경계 빵꾸

| ID | 주제 | 한 줄 |
|----|------|--------|
| **52** | Watchlist in-memory CRUD | route가 전역 `Map`을 직접 소유해 실제 watchlist infra를 우회함. |
| **53** | Watchlist async wiring | server startup에 subscriber/delivery 배선이 없어 webhook path가 테스트 전용 상태. |
| **54** | Watchlist ID contract | schema는 UUID, route와 테스트는 nanoid라 API 계약이 충돌함. |
| **55** | Last-mile boundaries | `Pick<ConcreteClass,...>` 계약과 `Ranker`/`LLMInjectionJudge`의 infra 역참조가 남아 있음. |

**해야 할 일**

1. watchlist를 route-local state에서 application/service + repository + delivery port 구조로 올리기
2. server 또는 worker startup에 subscriber start/stop과 webhook delivery 배선 추가
3. watchlist ID 포맷 하나로 통일
4. `container-contracts.ts` / `route-deps.ts`를 명시적 포트 인터페이스로 교체
5. `Ranker`, `LLMInjectionJudge`의 infra import 제거

**재현 (9차):**

```bash
nl -ba src/interface/http/routes/watchlist.route.ts | sed -n '20,260p'
nl -ba src/interface/http/server.ts | sed -n '133,170p'
nl -ba src/interface/http/schemas/watchlist.schema.ts | sed -n '47,105p'
rg -n "start\\(|publishUpdate\\(|deliver\\(" src test -g'*.ts'
rg -n "label-encoder|redis-client" src/domain -g'*.ts'
```

---

### 보강 — 정적 검증 스냅샷 (제5패스, 2026-04-06)

§L 위 항목과 별도로, **명령 전체 결과·라인 근거**를 날짜로 쌓은 로그: [`AUDIT-LOG.md`](./AUDIT-LOG.md).

| 명령 | 결과 |
|------|------|
| `npm run typecheck` | 통과 |
| `npm run test` | 1083 tests 통과 |
| `npm run lint` | **실패**, 214 problems (errors) |

---

### O. 9차 패스 — 부트스트랩 / runtime config / HTTP contract (`BACKLOG.md` §45–47)

| ID | 요약 |
|----|------|
| **45** | optional infra처럼 보이지만 `env.ts` + `main.ts` + `pg-pool.ts` 조합상 PG가 사실상 필수. |
| **46** | `createServer`가 global `config`와 `process.env`를 직접 읽어 pure composition이 아님. |
| **47** | route layer에 Fastify request/response schema 등록이 거의 없어 transport contract drift 위험. |

**재현 (9차):**

```bash
sed -n '1,80p' src/main.ts
sed -n '1,120p' src/config/env.ts
sed -n '1,80p' src/infrastructure/db/pg-pool.ts
sed -n '1,200p' src/interface/http/server.ts
rg -n "schema:|response:|body:|params:" src/interface/http/routes -g'*.ts'
```

### O. 9차 패스 — 부트스트랩/설정/스키마 경계 (`BACKLOG.md` §45–47)

| ID | 요약 |
|----|------|
| **45** | `createServer()`가 전역 `config`와 `process.env`를 직접 읽어 pure composition이 아님. |
| **46** | `env.ts`가 import 시점에 `.env` 로드 + `process.env` parse를 수행 — config bootstrapping side effect. |
| **47** | watchlist CRUD 응답은 schema parse를 거치지 않아, schema file이 실제 runtime 계약을 강제하지 못함. |

**재현 (9차):**

```bash
sed -n '1,220p' src/interface/http/server.ts
sed -n '1,220p' src/config/env.ts
sed -n '1,220p' src/interface/http/routes/watchlist.route.ts
sed -n '1,220p' src/interface/http/schemas/watchlist.schema.ts
```

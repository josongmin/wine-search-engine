# Bugbash — apr-6 (apr-5-v0.1 구현 점검 후속)

**작성 기준:** `docs/plans/apr-5-v0.1/*`와 저장소 코드·데이터를 대조한 감사 결과.  
**목적:** 계획 대비 갭·버그·부채를 **근거와 함께** 추적해 다음 스프린트에서 처리한다.  
**현행 “실제 빵꾸만” SSOT:** [`ACTUAL-GAPS.md`](./ACTUAL-GAPS.md) — 해소된 ID(G-05/6/10/22/40/43/48 등)는 아래 **구간별 서술**과 함께 갱신됨.  
**최종 갱신:** 2026-04-06 (제5패스: **`ACTUAL-GAPS.md`** 추가 · `GAPS`/`PLANS-GAP-AUDIT` 7차 정렬)

### 제5패스 스냅샷 (명령·건수)

| 검증 | 결과 |
|------|------|
| `npm run typecheck` | 통과 |
| `npm run test` | 1083 tests 통과 (68 files) |
| `npm run lint` | **통과** (2026-04-06 재확인) — 과거 감사의 **214건** 기록은 [`AUDIT-LOG.md`](./AUDIT-LOG.md) 참고 |

상세 라인 근거: [`AUDIT-LOG.md`](./AUDIT-LOG.md) §2026-04-06. 구간 §8·§14 등 **lint 대량 실패** 서술은 **G-06 해소** 후 [`ACTUAL-GAPS.md`](./ACTUAL-GAPS.md)와 불일치할 수 있음.

---

## 재현용 검증 (직접 확인할 때)

아래는 백로그 항목의 **근거를 재확인**할 때 쓸 수 있는 명령이다.

```bash
# Golden 500줄 · 시나리오 분포
wc -l data/golden-queries-bronze.jsonl
rg '"scenario":' data/golden-queries-bronze.jsonl | sed 's/.*"scenario":"\([^"]*\)".*/\1/' | sort | uniq -c

# Planner가 producer_browse/region_browse/no_match_detection을 반환하는지 (0건이면 미구현)
rg "return '(producer_browse|region_browse|no_match_detection)'" src/domain/query/service/planner.ts

# ResultGrouper 참조 여부 (정의 파일만 나오면 미연결)
rg "ResultGrouper" src --glob '*.ts'

# run-offline-eval이 verify-splits를 부르는지 (0건이면 미연동)
rg "verify-splits|verifySplits" scripts/eval/run-offline-eval.ts

# Epic 4 문서상 Python/LightGBM 스크립트 존재 여부
ls scripts/ltr/feature-schema.ts scripts/ltr/collect-training-data.ts scripts/ltr/train_lambdamart.py 2>/dev/null; ls scripts/ltr/

# Epic 5 README
ls services/reranker/README.md 2>/dev/null || echo "README 없음"

# 린트
npm run lint

# 루트 스크립트가 ESLint 프로젝트에 없으면 파싱 에러
rg "test-search-direct" tsconfig.eslint.json || true
ls test-search-direct.ts 2>/dev/null

# 오프라인 eval에 blocker/sparse·dense 분리 언급 여부
rg -i "blocker|sparse only|dense only" scripts/eval/run-offline-eval.ts scripts/eval/metrics.ts

# CI 워크플로에 eval/verify-splits 유무
rg "verify-splits|offline-eval|run-offline-eval" .github/workflows/*.yml

# package.json 의 eval 스크립트가 가리키는 파일 존재 여부
rg '"eval"' package.json; ls scripts/run-eval.ts 2>/dev/null || echo "scripts/run-eval.ts 없음"

# pairing 추출기가 플래너/풀에서 import 되는지 (정의만 있으면 미배선)
rg "extractPairingConstraint|extractAllPairingConstraints" src --glob '*.ts'

# WineAttributeEncoders 정의 중복 여부
rg "class WineAttributeEncoders" src
```

---

## P0 — 측정/동작이 틀어질 수 있는 항목

### 1. 오프라인 eval: 시나리오(A–H) → entity target 타입 매핑이 Epic 2와 불일치

**해야 할 일:** `scripts/eval/run-offline-eval.ts`의 `ENTITY_TARGET_TYPE_MAP`를 `docs/plans/apr-5-v0.1/epic-2-golden-query-set.md` §8개 시나리오 정의와 **동일한 의미**로 맞추고, 주석을 수정한다.

**근거:**

- Epic 2 표준 시나리오 (문서):

  | 시나리오 글자 | 의미 |
  |---------------|------|
  | A | 정확 엔티티 |
  | B | 짧은/모호한 별칭 |
  | C | 속성/취향 기반 |
  | D | 제약 기반 |
  | E | **탐색/추천형 (exploration)** |
  | F | **비교/유사품 (similar_compare)** |
  | G | **카탈로그 browse** |
  | H | **OOV/오타/불완전 (noisy_recall)** |

- 현재 코드는 E를 `producer`, F를 `region` 등으로 두고 주석까지 “Producer browse”, “Region browse”로 달려 있음:

```106:116:scripts/eval/run-offline-eval.ts
const ENTITY_TARGET_TYPE_MAP: Record<string, EntityTargetType> = {
  'A': 'wine',      // Exact entity lookup (wine)
  'B': 'wine',      // Ambiguous wine
  'C': 'wine',      // Short-form wine
  'D': 'wine',      // Semantic preference (wine)
  'E': 'producer',  // Producer browse
  'F': 'region',    // Region browse
  'G': 'region',    // Region/appellation browse
  'H': 'wine',      // Comparison (wines)
  'no_match': 'wine',
} as const;
```

**영향:** `EntityTargetType`별 confusion rate·슬라이스 메트릭이 **잘못된 가정**으로 집계될 수 있음.

---

### 2. Planner가 `producer_browse` / `region_browse` / `no_match_detection`을 선택하지 않음

**해야 할 일:**

- `src/domain/query/service/planner.ts`의 `determineRetrievalMode` (및 필요 시 `inferTargetEntityType`와의 결합)에서 Epic 7 문서에 적힌 규칙대로 위 모드가 **실제로** 나오게 분기 추가.
- 또는 문서가 과도하면: “현재는 `attribute_search` 등으로 폴백한다”를 **문서·RFC에 명시**하고, eval의 `retrieval_mode` 태그와 런타임 모드를 **한 축으로 정렬**.

**근거:**

- `RetrievalMode` 타입에는 세 모드가 포함됨: `src/domain/query/model/retrieval-mode.ts`.
- `determineRetrievalMode` 구현 안에서는 `'producer_browse' | 'region_browse' | 'no_match_detection'`에 대한 **return 문이 없음** (해당 파일 검색 시 매칭 없음).
- Epic 7 완료 기준 예: “안티노리 → `producer_browse`” (`docs/plans/apr-5-v0.1/epic-7-retrieval-modes.md`).

**영향:** 골든 쿼리 JSONL의 `retrieval_mode`와 실제 검색 파이프라인 모드가 **어긋날 수 있음**; 모드별 가중치(`mode-weights.ts`)·캐시 정책이 **기대대로 쓰이지 않음**.

---

## P1 — 기능 갭 (계획서 대비)

### 3. Browse / Compare 리트리버가 스텁

**해야 할 일:** `src/domain/retrieval/service/browse-retriever.ts`, `compare-retriever.ts`에 `SearchIndexPort`(또는 기존 hybrid 경로)를 연결해 실제 후보를 반환하고, `search.usecase.ts`에서 `retrievalMode`에 따른 분기 연결.

**근거:**

- `browseProducer` / `browseRegion` / `compareToAnchor`가 빈 배열을 반환하도록 되어 있음 (placeholder 주석).
- `src/application/search/search.usecase.ts`에 `BrowseRetriever`/`CompareRetriever` 참조 없음.

**문서:** `docs/plans/apr-5-v0.1/epic-10-similar-compare-browse.md` Deliverables·완료 기준.

---

### 4. `ResultGrouper` 미연결

**해야 할 일:** `src/domain/response/service/result-grouper.ts`를 `ResponseBuilder` 또는 검색 use case에서 호출해, Epic 8 Option A(집계 레이어)에 맞게 `producer_set` / `region_set` 등을 응답에 반영할지 결정하고 배선.

**근거:** `ResultGrouper`는 다른 `src` 모듈에서 import되지 않음 (심볼 검색 시 정의 파일만 존재).

**문서:** `docs/plans/apr-5-v0.1/epic-8-entity-index-surface.md` §8.2.

---

### 5. Epic 4 문서 vs 구현 경로 불일치

**해야 할 일 (택 1 이상):**

- `docs/plans/apr-5-v0.1/epic-4-ltr.md`를 **실제 구현**(`src/domain/ranking/service/lambdamart-ranker.ts`, `ltr-training-service.ts`, `pg-ltr-model-registry.ts`, `scripts/eval/run-eval-and-train-ltr.ts` 등)에 맞게 갱신하거나,
- “권장 Deliverables”에 **실제 소스 오브 트루스 파일 목록**을 추가.

**근거:** 문서의 `scripts/ltr/feature-schema.ts`, `collect-training-data.ts`, `train_lambdamart.py`, Vespa `ltr_v1` LightGBM는 루트 저장소 기준 **없거나 Vespa 스키마에 미반영**; 대신 TS+앱 레이어 LTR이 존재.

---

### 6. 오프라인 eval과 split 검증의 연동

**해야 할 일:** `npm run` 스크립트 또는 `run-offline-eval.ts` 시작 시 `verify-splits.ts`를 **옵션/플래그**로 실행하거나, CI에서 eval 전 단계로 고정.

**근거:** Epic 3 §3.5는 eval 전 leakage check를 요구. `run-offline-eval.ts`에 `verify-splits` / `verifySplits` 문자열이 **없음** (`rg`로 확인).

---

### 7. Epic 11: `mode-metrics.ts` 별도 파일 없음 (문서 vs 코드)

**해야 할 일:** `docs/plans/apr-5-v0.1/epic-11-eval-extension.md`는 `scripts/eval/mode-metrics.ts`를 Deliverables에 넣음. 실제로는 `scripts/eval/metrics.ts`에 `ModeMetrics`, `setCoverage`, `anchorPreservationScore` 등이 **통합**되어 있음. 문서를 실제 구조에 맞게 고치거나, 파일을 분리해 import 경로를 정리한다.

**근거:** `scripts/eval/`에 `mode-metrics.ts` **파일 없음**; `metrics.ts`에 모드 슬라이스 타입·함수 존재.

---

## P2 — 품질·문서·산출물

### 8. ESLint 실패 다수

**해야 할 일:** `npm run lint`가 통과하도록, 최소한 **경로/역할상 핵심 파일**(`lambdamart-ranker.ts`, `ltr-ranker.ts`, `prepare-finetuning-data.ts` 등)부터 정리. 디버그용 `src/__tests__/*trace*`·`console` 규칙은 별도 예외 또는 파일 분리 검토.

**근거:** 감사 시 `npm run lint` exit code 1, 수백 건 리포트.

---

### 9. Reranker 서비스 README

**해야 할 일:** `docs/plans/apr-5-v0.1/epic-5-cross-encoder.md`는 `services/reranker/README.md`를 Deliverables에 포함. 현재 `main.py` docstring에 실행법이 있으나 **전용 README 없음**.

---

### 10. Golden tier 파일 명명 vs 문서

**해야 할 일:** `golden-queries-silver.jsonl` / `golden-queries-gate.jsonl`를 문서처럼 루트 `data/`에 둘지, 현재처럼 `data/splits/*.jsonl`로 통일할지 결정 후 **RUNBOOK·Epic 2** 한 곳에만 규칙을 적는다.

**근거:** 실제 데이터는 `data/splits/train|val|gate.jsonl`(합 500) + `data/golden-queries-bronze.jsonl`(500) 조합으로 충족; 파일 이름만 문서와 다름.

---

### 11. 임베딩 파인튜닝 산출물

**해야 할 일:** `models/bge-m3-wine-ft-v1/` 등은 `.gitignore` 여부와 “학습 후 아티팩트는 어디에 두는지”를 README 또는 `scripts/ltr/finetune_embedding.py` 상단에 명시.

**근거:** Epic 6 Deliverables에 모델 디렉터리가 있으나 레포에는 스크립트만 있고 **커밋된 가중치 없음**(정상일 수 있음).

---

## 참고 — 이미 잘 맞는 부분 (이번 백로그 제외)

- `data/golden-queries-bronze.jsonl` 500줄, 시나리오·언어 분포, `leakage_keys`, `retrieval_mode` 필드 존재.
- `scripts/eval/verify-splits.ts` 존재 및 스플릿 파일 `data/splits/*`.
- `SearchResponseV1` LLM envelope 필드, `ResultItem.matchReasons`/`violatedConstraints`, `EngineDecision.abstainReason` 구현.
- `MixedSolver`의 `similar_items`용 seed 제외·producer diversity 등 (`applySetConstraintsForSimilarItems`).
- `npm run typecheck` 통과.

---

### (선택) P2 — Epic 5 `buildWineText` vs 문서 예시

**해야 할 일:** `docs/plans/apr-5-v0.1/epic-5-cross-encoder.md` 예시는 vintage·appellation·country를 passage에 포함. `src/domain/ranking/service/ranker.ts`의 `buildWineText`는 라벨·producer·region·searchTextEn·grape 중심이며 길이 상한 있음. 의도적이면 문서 예시를 맞추고, 아니면 코드에 필드 보강 검토.

---

## 추가 누적 — 코드·CI 전수 스캔

아래는 초기 백로그 이후 **더 촘촘히** 찾은 빵꾸·보완점이다. 우선순위는 팀이 조정.

### 12. `Planner` 클래스 docstring이 `parseConstraints` 실제 동작과 불일치

**해야 할 일:** `src/domain/query/service/planner.ts` 상단 Pipeline 설명 7번이 “Parse constraints (placeholder -- returns empty bundle)”로 되어 있으나, 실제 `parseConstraints()`는 `nlMapper.mapConstraints` 등으로 **빈 번들이 아닐 수 있음**. 단계 번호도 본문(`plan()` 내부 주석)과 어긋남 — docstring 정리.

**근거:** 클래스 블록 주석 114행 부근 vs `parseConstraints` 구현(557행대 이후).

---

### 13. 루트 `test-search-direct.ts` — ESLint `parserOptions.project` 대상 아님

**해야 할 일:** `tsconfig.eslint.json`의 `include`에 없어 `eslint .` 시 **Parsing error: file was not found in any of the provided project(s)** 유발. 선택지: (a) `include`에 추가, (b) `eslint.config.js` `ignores`에 추가, (c) `scripts/dev-search-smoke.ts` 등으로 이동.

**근거:** 파일이 저장소 루트에 존재; `tsconfig.eslint.json`은 `src`, `test`, `tools`, `scripts` 위주.

---

### 14. CI가 `npm run lint`를 게이트로 사용 — 로컬 린트 실패 = PR 실패

**해야 할 일:** `.github/workflows/ci.yml` job `lint`가 전체 `eslint .` 실행. 로컬에서 수백 건 실패하던 상태면 **CI도 동일하게 실패**한다. P2-8(린트 정리)과 직결.

**근거:** `.github/workflows/ci.yml` 8–15행 `npm run lint`.

---

### 15. CI에 `verify-splits` / 오프라인 eval / Vespa e2e 없음

**해야 할 일:** 데이터 누수·검색 회귀를 **자동으로 잡는 잡**이 없음. 선택지: (1) `verify-splits`를 최소 주 1회 또는 PR 시 조건부 실행, (2) golden 데이터가 있는 브랜치에서만 `run-offline-eval` 스모크, (3) `test:e2e:vespa`는 리소스 비용 때문에 nightly만.

**근거:** `.github/workflows`에 `verify-splits`, `run-offline-eval` 문자열 **없음** (`rg`).

---

### 16. Epic 3 §3.4 “Retrieval Component 분리” (sparse / dense / hybrid) — 오프라인 eval에 미반영

**해야 할 일:** 계획서는 sparse only vs dense only vs hybrid(RRF) 분리 측정을 말함. `run-offline-eval.ts` / `metrics.ts`에 해당 **실험 축**이 없으면 “한 파이프라인 점수”만 보게 됨. 제품 결정: 스코프 밖이면 Epic 3 문서에 “Phase 2”로 내리기.

**근거:** `scripts/eval/run-offline-eval.ts`, `metrics.ts`에 `blocker`/`sparse only` 등 키워드 매칭 시 **의미 있는 분리 지표 없음** (전수 검색 기준).

---

### 17. Blocker recall (RFC-006 §3.3, Epic 3 언급) — eval 산출물에 부재 가능성

**해야 할 일:** Blocker 전용 메트릭·게이트가 eval JSON에 없다면 추가하거나, “아직 미측정”을 문서에 명시.

**근거:** `scripts/eval/`에서 `blocker` 문자열 **없음** (이전 `rg` 기준). (이름이 다르면 용어 통일 필요.)

---

### 18. 검색 캐시 경로가 코드에서 비활성 (`SearchUseCase`)

**해야 할 일:** `src/application/search/search.usecase.ts`에 캐시 키 빌드·통합이 **DISABLED** 주석으로 남음 (Wave 4 backlog). 성능/비용 목표가 있으면 우선순위 재평가.

**근거:** 파일 상단 주석 `// DISABLED: Caching infrastructure is incomplete`.

---

### 19. Drinking window: ONNX / 실모델 경로 미완 + 휴리스틱 스텁

**해야 할 일:** `src/infrastructure/ml/drinking-window-predictor.ts`에 `onnxruntime-node` 관련 TODO 및 stub 모드 로그. 운영에서 음용 기간을 신뢰도 있게 쓰려면 모델 로딩·배포 스토리 정리.

**근거:** 파일 내 `TODO: Uncomment when onnxruntime-node` 및 “stub mode” 로깅.

---

### 20. Claude tool `check_drinking_window` — 엔티티 조회 미구현

**해야 할 일:** `src/interface/claude-tools/tool-executor.ts` `executeDrinkingWindow`가 **항상** “entity lookup not yet implemented” 성격의 에러 객체 반환. 도구를 노출한다면 search index에서 entity 로드 후 `DrinkingWindowUseCase`로 연결.

**근거:** 215–230행 부근 주석 및 `return Promise.resolve({ error: ... })`.

---

### 21. Gate tier “human-validated” — 데이터에 검수 메타가 충분한지 불명확

**해야 할 일:** Epic 2는 Gate를 human-validated로 규정. `data/splits/gate.jsonl` 존재는 확인됐으나, `annotated_by` / tier 승격 이력이 bronze와 어떻게 구분되는지 **운영 프로세스·스키마**를 한 곳에 적어 두기.

**근거:** 문서 완료 기준 vs 실제 JSONL 스키마(브론즈와 동일 필드인지) 검증 필요.

---

### 22. 컨테이너: PG/Redis 미연결 시 광범위 Stub 사용

**해야 할 일:** `src/config/container-adapters.ts`는 풀 없으면 `StubBlockingPort`, `StubCalibrationStore`, `StubAmbiguityDictionary` 등으로 대체. 로컬 스모크는 편하지만 **blocker recall·캘리브레이션** 관련 동작이 프로덕션과 다를 수 있음 — 문서화 또는 dev/prod 프로파일 분리 명시.

**근거:** `container-adapters.ts` 분기 및 `src/config/container-stubs.ts`.

---

### 23. `CascadeRouter` 난이도 → phase 스킵 로직 — 회귀·관측 부족

**해야 할 일:** `CascadeRouter`는 **`CandidatePoolService`** (`candidate-pool.ts`)에서 `estimateDifficulty` → `getPhases`로 **실제 사용됨** (dead code 아님). 다만 난이도별로 sparse/dense/anchor 단계가 생략되는 경로가 **E2E·오프라인 eval에서 의도대로 검증**되는지(트레이스 필드, 테스트) 보강할지 검토.

**근거:** `src/domain/retrieval/service/candidate-pool.ts` 64–75행 부근에서 `cascadeRouter` 호출.

---

### 24. HTTP 검색 본문 `max(2000)` vs `QuerySanitizer` 500자 상한 — 계약 불일치

**해야 할 일:** (택 1) Zod 스키마 `search.schema.ts`의 `query.max`를 500 이하로 맞추거나, (택 2) `QuerySanitizer.MAX_QUERY_LENGTH`를 API 계약과 맞추고 부하·DoS 가드를 별도로 둔다.

**근거:** `SearchRequestSchema` `query` … `.max(2000)` — `src/interface/http/schemas/search.schema.ts` 30행. `QuerySanitizer` `MAX_QUERY_LENGTH = 500` — `src/domain/security/service/query-sanitizer.ts` 22–23행.

**영향:** 501–2000자 요청은 스키마 통과 후 Layer 1에서 `LENGTH_EXCEEDED`로 막힐 수 있음.

---

### 25. Epic 9 `missingInformation` 필드 — `SearchResponseV1`에 없음

**해야 할 일:** 플랜 `epic-9-llm-envelope.md`에 있던 “파싱 못한 정보” 노출이 필요하면 타입·빌더·스키마에 추가. 비목표면 플랜 체크리스트에서 제거.

**근거:** `src/domain/response/model/search-response.ts`에 `missingInformation` 없음 (`rg missingInformation src/domain` → 0건).

---

### 26. Epic 4 Option A — Vespa `second-phase` LightGBM / `ltr_v1` rank-profile 없음

**해야 할 일:** 앱 레이어 LTR만 쓸 거면 Epic 4 문서의 Vespa native GBDT 절을 “대안 미채택”으로 명시. Vespa에서 2차 rerank 하려면 `vespa/app/schemas/*.sd`에 rank-profile 추가.

**근거:** `rg -i lightgbm|lambdamart|ltr_v1 vespa` → 매칭 없음. `LTRRanker`는 Node (`search.usecase.ts`).

---

### 27. Epic 10 “비교 테이블” vs Epic 14 `ComparisonSearchResponse`

**해야 할 일:** 분해 검색은 `ComparisonEntity`에 `topResult`·`allResults`만 담음. 플랜의 `comparisonAxes`, 속성별 테이블은 별도 빌더 필요. 구현할지 문서만 줄일지 결정.

**근거:** `src/domain/response/model/comparison-response.ts`에 `comparisonAxes`/`attributes` 테이블 없음. `compare-retriever.ts` 스텁.

---

### 28. `tsconfig.build.json` LTR 파일 `exclude` — 의도와 실제 emit 불일치 가능

**해야 할 일:** `exclude`에 `lambdamart-ranker.ts` 등이 있으나 `search.usecase.ts`가 import하면 의존성으로 dist에 emit됨. “학습 전용 제외” 의도면 주석 명시하거나 exclude 정리.

**근거:** `npm run build` 후 `dist/domain/ranking/service/ltr-ranker.js` 존재.

---

### 29. v0.2 Epic 13 — Calibrated entropy abstain (전용 레이어)

**해야 할 일:** 플랜의 “top-K 점수 분산 entropy”가 기존 `confidence-refusal`/decision 경로에 흡수됐는지 문서화. 별도 모듈이 없으면 Epic 13에 “부분 구현” 명시.

**근거:** `planner.ts`에 entropy/abstain 전용 분기 없음 (기존 ConstraintSAT 항목과 독립).

---

### 30. `LLMInjectionJudge` API 오류 시 fail-open

**해야 할 일:** 보안 요구가 “차단 우선”이면 네트워크/파싱 실패 시 fail-closed 정책 검토 (현재 테스트는 fail-open 명시).

**근거:** `src/domain/security/service/llm-injection-judge.ts` — Claude 오류 시 injection 미탐 처리.

---

### 31. `npm run eval` 스크립트가 가리키는 파일 없음 (깨진 npm script)

**해야 할 일:** `package.json`의 `"eval": "tsx scripts/run-eval.ts"`를 **실제 존재하는 엔트리**로 바꾼다. 예: `scripts/eval/run-offline-eval.ts` 또는 `scripts/eval/run-eval-and-train-ltr.ts`. 또는 `scripts/run-eval.ts`를 복구해 위 스크립트로 위임.

**근거:** 저장소 전체 `**/run-eval.ts` **0건** (`Glob`). `scripts/`에는 `eval/run-offline-eval.ts` 등만 존재.

**영향:** 문서·온보딩에서 `npm run eval` 실행 시 **즉시 실패**.

---

### 32. Food pairing 추출기(`pairing-extractor.ts`) — 런타임 미배선

**해야 할 일:** `extractPairingConstraint` / `extractAllPairingConstraints`를 `Planner`·`CandidatePoolService`·Vespa 필터 등에 연결해 `pairing_tags`와 맞추거나, 미사용이면 Epic 12 문서에서 “준비만 됨”으로 명시.

**근거:** `rg "extractPairingConstraint|extractAllPairingConstraints" src` → **`pairing-extractor.ts` 정의 파일만** 매칭. `scripts/etl/generate-pairings.ts`는 `PAIRING_TAXONOMY`·타입만 import — **쿼리 타임** 추출 함수는 검색 파이프라인에 **연결되지 않음**.

**문서:** 파일 헤더 “Epic 12, Step 12.3”.

---

### 33. `WineAttributeEncoders` 이중 정의 — 도메인 파일 vs `label-encoder.ts`

**해야 할 일:** `src/domain/ranking/service/wine-attribute-encoder.ts`와 `src/infrastructure/ml/label-encoder.ts`에 유사한 정적 인코더가 공존. `ranker.ts`는 **`label-encoder.js`만** import. 도메인 쪽 파일이 **데드 코드**이면 제거하거나 단일 소스로 합침.

**근거:** `from '.*wine-attribute-encoder'` import **0건**. `ranker.ts` 10행 `label-encoder.js` 사용.

---

### 34. Watchlist: 응답 스키마 UUID vs `nanoid()` ID

**해야 할 일:** `CreateWatchlistResponseSchema.watchlist_id`가 `z.string().uuid()`인데 라우트는 `nanoid()` 발급 — 클라이언트·Zod 검증 불일치. 스키마 완화 또는 ID를 UUID로 통일.

**근거:** `watchlist.schema.ts` 61–62행; `watchlist.route.ts` nanoid; `watchlist-routes.test.ts` 53행은 nanoid 패턴 기대.

---

### 35. Watchlist: HTTP 서버가 Redis subscriber 미기동 + DB 마이그레이션 없음

**해야 할 일:** (1) `RedisWatchlistSubscriber.start()`를 서버 또는 worker에서 기동해 pub/sub→webhook 완성. (2) 인메모리 `Map` 대신 마이그레이션·리포지토리.

**근거:** `server.ts`에 subscriber 없음; `src/infrastructure/db/migrations`에 `watchlist` **0건**.

---

### 36. `drinking_window_now`: Vespa YQL만 있고 NL 매핑 없음

**해야 할 일:** 자연어 “지금 마시기 좋은” 등을 `drinking_window_now` 제약으로 연결 (`nl-mapper` 또는 planner 규칙).

**근거:** `mapping.ts`에 `case 'drinking_window_now'`; `nl-mapper.ts`에 drinking 관련 **0건**.

---

### 37. `EVAL_RUN_AT_STARTUP` — 부팅 시 장시간 eval

**해야 할 일:** 프로덕션 런북에 경고; prod에서 비활성 권장.

**근거:** `server.ts` 144–167행.

---

### 38. Epic 16 — Prompt injection 방어가 `SearchUseCase`에만 있음 (`/v1/search` 우회 가능)

**심각도:** 보안 — `POST /v1/search`가 아닌 엔드포인트로 **동일 악성 페이로드**를 보내면 Layer 1·2를 거치지 않음.

**해야 할 일 (택 1 이상):**

- 공통 `sanitizeQueryForPlanner()`(또는 `QuerySanitizer` 호출)를 `HybridUseCase.execute`, `InterpretUseCase.execute`, `ResolveUseCase.execute` **최상단**에 추가.
- 또는 해당 라우트를 **내부 전용**·인증 필수로 제한하고, 공개 API는 `/v1/search`만 문서화.

**근거 (병렬 확인):**

- `rg "QuerySanitizer|querySanitizer" src/application` → **`search.usecase.ts`만** 매칭.
- `HybridUseCase` — `request.query`를 그대로 `queryPlanner.plan`에 전달 (`src/application/search/hybrid.usecase.ts` 63–87행).
- `InterpretUseCase` — 동일 (`src/application/search/interpret.usecase.ts`).
- `ResolveUseCase` — 동일 (`src/application/search/resolve.usecase.ts` 47행~).
- `ReplayUseCase`는 `searchUseCase.execute`를 호출하므로 **방어 유지**.

**재현 커맨드:**

```bash
rg "QuerySanitizer|querySanitizer" src/application --glob "*.ts"
```

---

### 39. CORS 미설정 — 브라우저 직접 호출 시 차단 가능

**해야 할 일:** 퍼블릭 웹앱이 **동일 API 오리진**이 아니면 `@fastify/cors`(또는 게이트웨이에서 CORS) 도입. **API-only·역프록시 뒤만** 쓸 거면 RUNBOOK에 “CORS는 엣지에서 처리” 명시.

**근거:** `rg -i cors src` → **0건**. `server.ts`에 CORS 플러그인 없음.

**영향:** 브라우저에서 `fetch`/`XHR`로 다른 오리진의 API를 호출하면 **CORS preflight 실패** (서버는 JSON API로 정상 동작해도 클라이언트만 막힘).

---

### 40. `HTTP_RATE_LIMIT_MAX=0` — 전역 rate limit 비활성

**해야 할 일:** 운영 문서에 “0 = 무제한(분당 캡 없음)” 경고. 부하 테스트·로컬 eval 외 **프로덕션에서 0 금지** 권장.

**근거:** `src/config/env.ts` 15–16행 주석 “use 0 to disable”; `src/interface/http/server.ts` 92–96행 `if (config.httpRateLimit.max > 0)` 일 때만 `@fastify/rate-limit` 등록.

**연관:** RFC-014 §13 언급과 일치하나, **기본값은 100**이라 0은 명시 설정 시에만.

---

### 41. OpenAPI / Swagger 스펙 없음

**해야 할 일:** `@fastify/swagger` + 스키마 export, 또는 외부 `openapi.yaml` 유지. 최소한 **엔드포인트 목록·요청 본문**을 `README` 또는 `docs/`에 표로 고정.

**근거:** `rg -i "openapi|swagger" src` → **0건**.

---

### 52. watchlist route가 실제 비동기 인프라를 우회하는 인메모리 CRUD로 남아 있음

**해야 할 일:** `src/interface/http/routes/watchlist.route.ts`의 전역 `Map` 기반 CRUD를 애플리케이션 서비스로 올리고, 저장소/로그/notification delivery를 포트로 분리한다.

**근거:** route가 직접 `watchlistStore`, `deliveryLogStore`를 소유하고 CRUD/로그 기록을 모두 수행한다. 반면 `src/infrastructure/watchlist/redis-watchlist-publisher.ts`, `redis-watchlist-subscriber.ts`, `webhook-delivery.ts`는 별도로 존재한다.

**영향:** 서버 재시작 시 watchlist 상태가 사라지고, Epic 17.1의 “Redis pub/sub + webhook” 설계가 런타임 경로에 반영되지 않는다.

---

### 53. 서버 시작 경로에 watchlist subscriber / delivery wiring이 없음

**해야 할 일:** `createServer()` 또는 별도 worker startup에서 `RedisWatchlistSubscriber.start(...)`를 실제로 올리고, 수신 이벤트를 watchlist 조회 -> `WebhookDelivery.deliver(...)` -> delivery log 기록 경로에 연결한다. 종료 시 `stop()`도 추가.

**근거:** `src/interface/http/server.ts`는 `registerWatchlistRoute(app)`만 호출한다. `rg -n "start\\(|publishUpdate\\(|deliver\\(" src test -g'*.ts'` 기준으로 subscriber/publisher/delivery 호출은 대부분 테스트에만 존재한다.

**영향:** watchlist async delivery는 “구현 파일은 있음” 상태이지, 실제 앱 기능은 아니다. 운영에서는 entity change가 와도 webhook이 나가지 않는다.

---

### 54. watchlist API 스키마와 실제 ID 포맷이 충돌함

**해야 할 일:** UUID와 nanoid 중 하나로 통일. UUID를 유지할 거면 route/test를 바꾸고, nanoid를 유지할 거면 Zod schema의 `uuid()` 제약을 완화한다.

**근거:** `src/interface/http/schemas/watchlist.schema.ts`는 `watchlist_id`, `id`에 `z.string().uuid()`를 요구하지만, `src/interface/http/routes/watchlist.route.ts`는 `nanoid()`를 생성한다. `src/__tests__/watchlist-routes.test.ts`도 nanoid 패턴을 기대한다.

**영향:** OpenAPI/SDK/검증 계층을 붙일 때 즉시 깨질 수 있는 계약 충돌이다.

---

### 55. 구조 수습 이후에도 계약/도메인 경계에 마지막 누수가 남아 있음

**해야 할 일:** `src/config/container-contracts.ts`, `src/interface/http/routes/route-deps.ts`의 `Pick<ConcreteClass, method>`를 명시적 포트 인터페이스로 치환하고, `Ranker`/`LLMInjectionJudge`의 infra import를 제거한다.

**근거:** `container-contracts.ts`, `route-deps.ts`는 아직 `Pick<...>` 기반이고, `src/domain/ranking/service/ranker.ts`는 `label-encoder`, `src/domain/security/service/llm-injection-judge.ts`는 `redis-client` 타입을 직접 import한다.

**영향:** 구현 클래스 리팩터가 계약 레이어까지 번지고, 인코더/캐시 구현 교체 시 도메인 코드가 흔들린다.

---

## 제안 작업 순서 (업데이트)

1. **P0-1 ~ P0-2** (그대로).  
2. **§38** — 공개 API면 **즉시** (injection 우회 차단).  
3. **13 + 14 + 8** — 린트·루트 스크립트·CI 붉은불 먼저 줄이기.  
4. **15 ~ 17** — 데이터/검색 회귀 자동화·메트릭 완성도.  
5. **3 ~ 4, 12, 18 ~ 22** — 기능·운영·문서 정리 순. **23**은 관측/테스트 보강 수준. **24**는 API 계약·보안 정책 정렬 우선 검토.  
6. **31** — 온보딩 깨짐 방지(`npm run eval`). **32–33** — pairing·LTR 주변 중복 정리. **34–37** — watchlist 계약·인프라·drinking NL·eval 부팅.  
7. **§39–§41** — 프런트/운영: CORS, rate limit `0`, OpenAPI (제품 노출 방식에 따라 P2).

---

## 인덱스

| 파일 | 역할 |
|------|------|
| `BACKLOG.md` (본 문서) | apr-5-v0.1 대비 갭·버그·부채 목록 + 근거 |
| `README.md` | 이 폴더 안내 |
| [`TASKS.md`](./TASKS.md) | v0.1+v0.2 통합; **§H**↔**§34–37**, **§K**↔**§31–33**, **§I** 4차, **§L** 6차, **§M**↔**§38**, **§N**↔**§39–41** |
| [`GAPS.md`](./GAPS.md) | ID `G-01`–`G-48` 한 줄 색인 (P0/P1/P2) |
| [`FINDINGS-MATRIX.md`](./FINDINGS-MATRIX.md) | 병렬 점검 표 `M-xx` ↔ `G-xx` ↔ § |
| [`PLANS-GAP-AUDIT.md`](./PLANS-GAP-AUDIT.md) | `docs/plans/*` **에픽별 매트릭스** (v0.1 + v0.2 Epic 12–17) |
| [`AUDIT-LOG.md`](./AUDIT-LOG.md) | 날짜별 `rg`·`Glob`·npm 근거 |

---

## 구조 제7패스 (2026-04-06)

아래는 ROI 무관하게 “끝까지 닫히는 구조” 기준으로 추가한 아키텍처 빵꾸들이다.

### 39. `Ranker`가 `infrastructure/ml` 구현을 직접 import

**해야 할 일:** `WineAttributeEncoders`를 `domain` 포트 또는 shared mapping utility 뒤로 숨기고, `Ranker`는 encoding capability만 의존하게 바꾼다.

**근거:**

```1:10:src/domain/ranking/service/ranker.ts
import { WineAttributeEncoders } from '../../../infrastructure/ml/label-encoder.js';
```

```177:195:src/domain/ranking/service/ranker.ts
...(candidate.grapePrimary !== undefined
  ? { grapePrimaryEnc: WineAttributeEncoders.encodeGrape(candidate.grapePrimary) }
  : {}),
...(candidate.appellation !== undefined
  ? { regionEnc: WineAttributeEncoders.encodeRegion(candidate.appellation) }
  : {}),
...(candidate.country !== undefined
  ? { countryEnc: WineAttributeEncoders.encodeCountry(candidate.country) }
  : {}),
```

**영향:** 도메인 랭킹 경로가 인프라 ML 구현체를 직접 알게 되어, 인코딩 전략 교체나 오프라인 precompute 전환 시 도메인 코드까지 흔들린다.

### 40. `LLMInjectionJudge`가 Redis 인프라 타입에 직접 결합

**해야 할 일:** `InjectionJudgeCachePort` 같은 작은 포트를 도입하고, Redis adapter는 `infrastructure`에 남긴다.

**근거:**

```1:2:src/domain/security/service/llm-injection-judge.ts
import type { RedisClient } from '../../../infrastructure/db/redis-client.js';
```

```24:47:src/domain/security/service/llm-injection-judge.ts
export class LLMInjectionJudge {
  private readonly client: Anthropic;
  private readonly redis: RedisClient;
  ...
  constructor(apiKey: string, redisClient: RedisClient) {
```

**영향:** security domain service가 특정 캐시 adapter shape을 직접 안다. alternate cache/noop cache/local test double을 붙일 때 boundary가 불필요하게 넓어진다.

### 41. Watchlist HTTP가 route-local in-memory 서브시스템으로 남아 있음

**해야 할 일:**

1. `WatchlistUseCase`/`WatchlistService` 계층 추가
2. repository / delivery log store / publisher / delivery port를 도입
3. route는 validation + request/response mapping만 남기기

**근거:**

```23:36:src/interface/http/routes/watchlist.route.ts
const watchlistStore = new Map<string, WatchlistEntry>();
const deliveryLogStore = new Map<string, Array<{
  id: string;
  watchlist_id: string;
  attempt: number;
  status_code: number | null;
  error_message: string | null;
  delivered_at: Date;
}>>();
```

```43:210:src/interface/http/routes/watchlist.route.ts
export function registerWatchlistRoute(app: FastifyInstance): void {
  app.post('/v1/watchlist', async (request, reply) => {
    ...
    watchlistStore.set(watchlistId, entry);
    deliveryLogStore.set(watchlistId, []);
  });
  ...
}
```

반면 비동기 인프라는 이미 따로 존재한다.

```text
src/infrastructure/watchlist/redis-watchlist-publisher.ts
src/infrastructure/watchlist/redis-watchlist-subscriber.ts
src/infrastructure/watchlist/webhook-delivery.ts
```

**영향:** 코드베이스 안에는 watchlist infra가 있지만, 실제 제품 경로는 별개 인메모리 CRUD로 동작한다. persistence / pub-sub / webhook retry / 운영 가시성이 런타임 경로에 닫히지 않는다.

### 42. Watchlist ID 계약이 schema / 구현 / 테스트 사이에서 충돌

**해야 할 일:** UUID를 쓸지 `nanoid`를 쓸지 한 번 정하고 schema·route·tests를 모두 맞춘다.

**근거:**

- 구현은 `nanoid()`

```12:12:src/interface/http/routes/watchlist.route.ts
import { nanoid } from 'nanoid';
```

```51:66:src/interface/http/routes/watchlist.route.ts
const watchlistId = nanoid();
...
reply.status(201).send({ watchlist_id: watchlistId });
```

- schema는 UUID 요구

```62:62:src/interface/http/schemas/watchlist.schema.ts
watchlist_id: z.string().uuid(),
```

- 테스트는 nanoid 형식을 기대

```53:53:src/__tests__/watchlist-routes.test.ts
expect(body.watchlist_id).toMatch(/^[\\w-]+$/); // nanoid format
```

**영향:** 응답 schema 강제, OpenAPI 생성, client validation을 켜는 순간 바로 계약 불일치가 드러난다.

### 43. Route/container 계약이 아직 `Pick<ConcreteClass, 'method'>` 수준

**해야 할 일:** `SearchExecutor`, `BatchSearchExecutor`, `PlanningPort`, `ClaudeToolExecutionPort` 같은 명시적 인터페이스로 승격.

**근거:**

```25:39:src/config/container-contracts.ts
export type QueryPlannerContract = Pick<Planner, 'plan'>;
export type EntityResolverContract = Pick<Resolver, 'resolve'>;
...
export type BatchSearchUseCaseContract = Pick<BatchSearchUseCase, 'execute'>;
```

```11:48:src/interface/http/routes/route-deps.ts
export interface SearchRouteDeps {
  readonly searchUseCase: Pick<SearchUseCase, 'execute'>;
  readonly decomposedSearchUseCase: Pick<DecomposedSearchUseCase, 'execute'>;
}
...
export interface ClaudeToolsRouteDeps {
  readonly adaptiveToolExecutor: Pick<AdaptiveToolExecutor, 'executeWithFallback'>;
}
```

**영향:** 이전보다 훨씬 얇아졌지만, 아직 “진짜 포트”라기보다 concrete class projection에 가깝다. 클래스명 변경·오버로드 정리·메서드 시그니처 리팩터 시 계약층도 함께 흔들린다.

### 44. Watchlist subscriber / webhook lifecycle이 서버 runtime에 연결되지 않음

**해야 할 일:**

- subscriber를 서버 startup hook 또는 별도 worker 프로세스에 연결
- shutdown 시 `stop()` 보장
- publisher 호출 경로를 명시하고 운영 문서에 역할 분리 기록

**근거:**

subscriber는 명시적인 lifecycle을 가진다.

```30:68:src/infrastructure/watchlist/redis-watchlist-subscriber.ts
async start(handler: WatchlistEventHandler): Promise<void> { ... }
async stop(): Promise<void> { ... }
```

하지만 실제 서버는 watchlist route만 등록한다.

```126:134:src/interface/http/server.ts
registerHybridRoute(app, deps);
registerWatchlistRoute(app);
```

또한 생산 코드 검색 기준으로 `subscriber.start`, `subscriber.stop`, `publishUpdate(`가 운영 경로에 거의 등장하지 않는다.

```bash
rg -n "watchlistSubscriber|subscriber.start|subscriber.stop|publishUpdate\\(" src --glob "*.ts"
```

**영향:** Epic 17 비동기 감시/전달 기능이 제품 lifecycle 안에서 살아 있지 않다. 어떤 프로세스가 이벤트를 소비하고, 어디서 웹훅을 보내는지 운영 모델이 불분명하다.

### 45. Optional infra 설계와 실제 부트스트랩이 충돌: PG가 사실상 필수

**해야 할 일:** `createContainer(config, pool?)`가 pool 없이도 부분 기동되도록 설계돼 있다면, `main.ts`와 `env.ts`도 그 모델을 따라야 한다. 선택지는 둘 중 하나다.

1. Postgres를 정말 필수로 선언하고 문서/타입/주석을 모두 맞춘다.
2. 아니면 `PG_PASSWORD`를 optional로 내리고, `main.ts`에서 pool 생성 여부를 명시적으로 결정한다.

**근거:**

```23:23:src/config/env.ts
PG_PASSWORD: z.string().min(1),
```

```19:20:src/main.ts
const pool = getPgPool();
const container = await createContainer(config, pool);
```

```1:16:src/infrastructure/db/pg-pool.ts
export function getPgPool(): Pool {
  if (!pool) {
    pool = new Pool({
      ...
      password: config.pg.password,
```

반면 컨테이너 조립은 `pool?: Pool`을 받아 stubs/fallback이 가능한 형태로 나뉘어 있다.

**영향:** “부분 기동 / 선택적 인프라”처럼 보이는 구조와 실제 시작 조건이 다르다. 로컬 개발, 테스트, 문서, 운영 가정이 어긋나고 fallback 설계의 신뢰도가 떨어진다.

### 46. `createServer`가 여전히 global config와 `process.env`를 직접 읽음

**해야 할 일:** rate limit, startup eval flag 같은 서버 런타임 설정을 `ServerOptions` 또는 별도 `ServerRuntimeConfig`로 주입하고, `createServer()`는 pure composition 단계가 되게 정리한다.

**근거:**

```4:4:src/interface/http/server.ts
import { config } from '../../config/env.js';
```

```92:97:src/interface/http/server.ts
if (config.httpRateLimit.max > 0) {
  await app.register(rateLimit, {
    max: config.httpRateLimit.max,
```

```147:147:src/interface/http/server.ts
if (process.env.EVAL_RUN_AT_STARTUP === 'true') {
```

**영향:** 부트스트랩 계층이 완전히 닫히지 않는다. 테스트에서 runtime knobs를 명시적으로 바꾸기 어렵고, `main -> config -> server` 조립 흐름이 중간에 다시 전역 상태를 읽는 구조가 된다.

### 47. HTTP route layer가 Fastify schema/response contracts를 거의 등록하지 않음

**해야 할 일:** 최소 공개 API부터 request/response schema를 Fastify route 옵션에 연결해 contract drift를 막는다. 이미 존재하는 Zod schema가 있다면 route registration에서 그대로 재사용하면 된다.

**근거:**

`src/interface/http/routes` 전체 검색 기준, route option의 `schema`, `response`, `body`, `params` 등록이 거의 없다.

```bash
rg -n "schema:|response:|body:|params:" src/interface/http/routes -g'*.ts'
```

현재 매칭도 실제 route option 등록이 아니라 지역 변수 타입/응답 변수 수준에 가깝다.

```28:28:src/interface/http/routes/health.route.ts
const body: HealthResponse = {
```

```75:75:src/interface/http/routes/claude-tools.route.ts
const response: ClaudeToolCallResponse = {
```

반면 watchlist 등에는 Zod schema 파일이 이미 따로 있다.

```1:114:src/interface/http/schemas/watchlist.schema.ts
```

**영향:** 테스트와 구현이 맞아도 런타임에서 request/response contract가 강제되지 않는다. OpenAPI 생성, SDK 생성, transport-level validation, 계약 회귀 방지가 모두 약해진다.

### 45. Watchlist 응답/에러 schema 대부분이 런타임에서 전혀 사용되지 않음

**해야 할 일:** `CreateWatchlistResponseSchema`, `GetWatchlistResponseSchema`, `WatchlistErrorResponseSchema`를 실제 route 응답에서 parse하거나, Fastify schema/OpenAPI에 연결하거나, 미사용이면 정리한다.

**근거:**

watchlist schema 정의는 존재한다.

```61:121:src/interface/http/schemas/watchlist.schema.ts
export const CreateWatchlistResponseSchema = z.object({ ... });
export const GetWatchlistResponseSchema = z.object({ ... });
export const WatchlistErrorResponseSchema = z.object({ ... });
```

하지만 참조 검색 기준 실제 사용은 0건이다.

```bash
rg -n "GetWatchlistResponseSchema|CreateWatchlistResponseSchema|WatchlistErrorResponseSchema" src test --glob "*.ts"
```

반면 `ListDeliveriesResponseSchema`만 route에서 실제 parse한다.

**영향:** schema 파일이 있어도 런타임 계약을 보장하지 못한다. 지금처럼 ID format drift 같은 문제가 생겨도 테스트가 route body를 느슨하게만 보면 지나갈 수 있다.

### 46. `createServer()`가 injected config가 아니라 전역 `config` singleton에 직접 의존

**해야 할 일:** `createServer(deps, { config, logLevel })`처럼 명시적으로 주입하거나, 최소한 rate limit / env-driven behavior를 options로 전달한다.

**근거:**

```4:4:src/interface/http/server.ts
import { config } from '../../config/env.js';
```

```84:90:src/interface/http/server.ts
if (config.httpRateLimit.max > 0) {
  await app.register(rateLimit, {
    max: config.httpRateLimit.max,
```

서버 시그니처는 `deps`와 `options`만 받지만, 실제 동작은 module-level singleton env에 숨은 의존을 둔다.

**영향:** 테스트에서 서버 동작을 완전히 제어하기 어렵고, composition root를 통해 wiring을 명시했다는 최근 구조 개선과도 결이 맞지 않는다.

### 47. `main.ts`는 optional pool 설계와 달리 항상 PG pool을 강제 생성

**해야 할 일:** 정말 PG가 필수면 문서/타입에서 optional pool 환상을 제거하고, 선택 기능만 PG를 쓰는 모델이면 `main.ts`도 pool optional 경로를 지원해야 한다.

**근거:**

`createContainer(config, pool?)`는 optional pool을 받는다.

```53:53:src/config/container.ts
export async function createContainer(config: Config, pool?: Pool): Promise<Container> {
```

하지만 실제 엔트리포인트는 무조건 PG pool을 만든다.

```17:18:src/main.ts
const pool = getPgPool();
const container = await createContainer(config, pool);
```

그리고 env parsing도 `PG_PASSWORD`를 필수로 요구한다.

```22:22:src/config/env.ts
PG_PASSWORD: z.string().min(1),
```

**영향:** “선택적 PG 의존” 구조처럼 보여도 실제 앱 기동 경로는 그렇지 않다. 런타임 모델과 조립 계약이 어긋나 있으면 운영/로컬 개발/문서가 계속 혼란스러워진다.

### 48. `/ready`가 실제 의존성 상태와 무관하게 항상 ready=true

**해야 할 일:** 최소한 PG/Redis/Vespa/reranker/embedding 중 필수 의존성 체크를 readiness에 반영하거나, `/ready`를 단순 liveness와 구분하지 않는다고 문서화한다.

**근거:**

```33:41:src/interface/http/routes/health.route.ts
// In production, this would check database connections, search index,
// embedding service, etc. For now, always report ready.
const body: ReadyResponse = {
  ready: true,
  timestamp: new Date().toISOString(),
};
```

**영향:** 쿠버네티스/로드밸런서/운영 runbook이 `/ready`를 신뢰하면, 실제로는 핵심 dependency가 죽어 있어도 트래픽을 계속 받을 수 있다. 이름은 readiness인데 동작은 liveness에 가깝다.

### 45. `createServer()`가 전역 `config`와 `process.env`를 직접 읽어 purity가 깨짐

**해야 할 일:** `createServer()`는 `deps`와 함께 필요한 런타임 옵션을 주입받고, 내부에서 `config` singleton이나 `process.env`를 직접 읽지 않게 바꾼다.

**근거:**

```1:4:src/interface/http/server.ts
import { config } from '../../config/env.js';
```

```92:96:src/interface/http/server.ts
if (config.httpRateLimit.max > 0) {
  await app.register(rateLimit, {
    max: config.httpRateLimit.max,
```

```147:147:src/interface/http/server.ts
if (process.env.EVAL_RUN_AT_STARTUP === 'true') {
```

**영향:** 서버 생성 함수가 pure composition 함수가 아니라 전역 환경에 묶인다. 테스트에서 환경 조합을 독립적으로 검증하기 어렵고, future multi-server / worker / embedded runtime 구성에서도 재사용성이 떨어진다.

### 46. `env.ts`가 import 시점에 `.env` 로드 + `process.env` parse를 수행

**해야 할 일:** `loadConfig()` 또는 `parseEnv(rawEnv)` 같은 명시적 팩토리로 바꾸고, import-time side effect를 줄인다.

**근거:**

```1:2:src/config/env.ts
import { z } from 'zod';
import 'dotenv/config';
```

```82:82:src/config/env.ts
const parsed: EnvVars = envSchema.parse(process.env);
```

```87:153:src/config/env.ts
export const config = {
  ...
} as const;
```

**영향:** 설정 파싱이 module load side effect가 되면서 테스트 격리, 다중 config instance, worker별 환경 오버라이드, 실패 위치 추적이 모두 거칠어진다.

### 47. Watchlist CRUD 응답은 schema parse를 거치지 않아 계약이 runtime에서 강제되지 않음

**해야 할 일:** `POST /v1/watchlist`, `GET /v1/watchlist/:id`도 `CreateWatchlistResponseSchema` / `GetWatchlistResponseSchema`로 응답 직전 parse하거나 Fastify response schema에 연결한다.

**근거:**

deliveries 응답만 schema parse를 거친다.

```193:196:src/interface/http/routes/watchlist.route.ts
const response = ListDeliveriesResponseSchema.parse({
  deliveries,
  total: deliveries.length,
});
```

반면 create/get 응답은 raw object를 바로 보낸다.

```66:66:src/interface/http/routes/watchlist.route.ts
void reply.status(201).send({ watchlist_id: watchlistId });
```

```108:118:src/interface/http/routes/watchlist.route.ts
const response = {
  id: entry.id,
  ...
};
void reply.status(200).send(response);
```

동시에 schema는 UUID를 요구한다.

```56:72:src/interface/http/schemas/watchlist.schema.ts
export const CreateWatchlistResponseSchema = z.object({
  watchlist_id: z.string().uuid(),
});
...
export const GetWatchlistResponseSchema = z.object({
  id: z.string().uuid(),
```

**영향:** 스키마 파일은 존재하지만 실제 운영 경로를 보호하지 못한다. 그래서 nanoid/UUID 불일치처럼 계약 드리프트가 조용히 누적된다.

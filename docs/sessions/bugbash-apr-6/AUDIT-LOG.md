# Audit log (누적)

날짜별로 **실행한 검증·재확인 근거**를 쌓는다. 상위 요약·우선순위는 [`TASKS.md`](./TASKS.md), [`BACKLOG.md`](./BACKLOG.md).

---

## 2026-04-06 — 정적 검증 + 코드 재확인

### 실행한 명령

| 명령 | 결과 |
|------|------|
| `npm run typecheck` | ✅ exit 0 |
| `npm run test` | ✅ 68 files, 1083 tests |
| `npm run lint` | ❌ exit 1, **214 problems** (0 warnings, all errors) |

### 재확인한 근거 (파일·라인)

#### 1. 오프라인 eval: 시나리오 ↔ `EntityTargetType` 매핑 vs Epic 2

- **문서:** `docs/plans/apr-5-v0.1/epic-2-golden-query-set.md` — A=`exact_entity` … E=`exploration`, F=`similar_compare`, G=`catalog_browse`, H=`noisy_recall`.
- **코드:** `scripts/eval/run-offline-eval.ts` 106–116 — E→`producer`, F→`region`, G→`region`, H→`wine` 주석 "Comparison (wines)".
- **영향:** 시나리오 슬라이스·`EntityTypeMetrics`가 **문서의 시나리오 의미와 다른 축**으로 집계됨. (BACKLOG P0-1과 동일 이슈, 주석 오류 H는 추가로 확인.)

#### 2. `determineRetrievalMode` — 세 모드 미사용

- **코드:** `src/domain/query/service/planner.ts` 414–469.
- **실제 반환:** `compare_candidates` | `entity_resolution` | `entity_lookup` | `similar_items` | `recommendation` | `constraint_filter` | `attribute_search`(default).
- **없음:** `producer_browse`, `region_browse`, `no_match_detection`.
- **대조:** `scripts/eval/run-offline-eval.ts` 64–103 `MODE_RELEASE_GATES` 키에는 위 모드가 포함됨 → **게이트 정의와 런타임 모드가 불일치.**

#### 3. Planner 클래스 주석 vs 구현

- **코드:** `src/domain/query/service/planner.ts` 114 — "7. Parse constraints (placeholder -- returns empty bundle)."
- **실제:** `parseConstraints` (557행~)에서 `nlMapper.mapConstraints`로 매칭 후 hard/soft 분리.
- **조치:** JSDoc만 수정하면 됨 (동작 버그 아님, **문서 부채**).

#### 4. Browse / Compare 리트리버 — 미배선

- **정의:** `browse-retriever.ts`, `compare-retriever.ts` — 여전히 빈 배열 반환.
- **검색:** `src/application/search/` 아래에 `BrowseRetriever` / `CompareRetriever` import **없음** (`rg` 기준).

#### 5. Drinking window — ONNX 미연결

- **코드:** `src/infrastructure/ml/drinking-window-predictor.ts` 65–71 — `onnxruntime-node` 주석 처리, stub + heuristic.

#### 6. ESLint: 루트 스크립트가 프로젝트 밖

- **파일:** `test-search-direct.ts` (저장소 루트).
- **에러:** `Parsing error: The file was not found in any of the provided project(s)` — `parserOptions.project`와 불일치.
- **영향:** 전체 `npm run lint` 실패에 기여. **eslintignore 추가 또는 `tsconfig` 포함·삭제** 중 택일.

#### 7. v0.2 ConstraintSAT vs 기존 게이트

- **검색:** `src`에 `constraint-sat` / `ConstraintSAT` 모듈명 **미등장** (planner 이전 하드 모순 전용).
- **대조:** `admission-gate.ts`에 `HARD_CONSTRAINT_VIOLATION` 존재 → **결과 단계 거부는 있음**, Epic 13 스타일 **사전 SAT**는 별도.

---

## 2026-04-06 — 병렬 정적 검증 (문서 통합)

`docs/sessions/bugbash-apr-6` 폴더를 SSOT로 정리하기 위해 **동시에** 아래를 실행·기록했다.

### 명령·결과

| 검사 | 명령 / 방법 | 결과 |
|------|-------------|------|
| eval 스크립트 | `Glob **/run-eval.ts` | **0 파일** — `package.json` `"eval": "tsx scripts/run-eval.ts"`와 불일치 |
| 제약 SAT / Entropy | `rg ConstraintSAT\|AbstainPolicy src` | **매칭 없음** |
| 플래너 브라우즈 모드 | `rg producer_browse\|region_browse\|no_match_detection planner.ts` | **미등장** (반환 집합과 골든 태그 불일치) |
| v0.2 Vespa 필드 매핑 | `rg critic_proxy\|pairing_tags\|organic mapping.ts` | **매칭 없음** |
| pairing 추출기 | `rg extractPairingConstraint src` | **정의 파일·ETL만** |
| ResultGrouper | `rg ResultGrouper src` | **result-grouper.ts만** |
| Browse/Compare | `rg BrowseRetriever src/application` | **미사용** |
| WineAttributeEncoders | `rg wine-attribute-encoder` import | **domain 파일 import 0건**; `ranker.ts`는 `label-encoder.js` 사용 |
| CI verify-splits | `rg verify-splits .github` | **0건** |
| Redis watchlist | `rg RedisWatchlistSubscriber server.ts` | **0건** |
| DB watchlist | `rg -i watchlist migrations` | **0건** |

### 산출물

- [`README.md`](./README.md): SSOT 표·병렬 체크리스트·문서 대응표.
- [`GAPS.md`](./GAPS.md): `G-01`–`G-37` ID 재구성 (P0/P1/P2).
- 본 섹션: 재현 가능한 근거 로그.

---

## 2026-04-06 — 병렬 코드·CI 스캔 (매트릭스)

- **산출물:** [`FINDINGS-MATRIX.md`](./FINDINGS-MATRIX.md) — `M-01`…`M-32` 행에 파일·라인·`BACKLOG` §·재현 커맨드 묶음.
- **추가 확인:** `.github/workflows/ci.yml` — `lint` / `npx tsc --noEmit` / `npm run test` / `build`만; `semgrep`, `verify-splits`, `run-offline-eval`, e2e 없음.
- **추가 확인:** `package.json` `"eval": "tsx scripts/run-eval.ts"` — `scripts/run-eval.ts` **부재** (`M-11`).
- **추가 확인:** `wine-attribute-encoder.ts` — 레포 전체 `import` **0건** (`M-18`).

### 보안 — Epic 16 injection 우회 (`BACKLOG` §38 · `TASKS` §M · `GAPS` G-40)

| 검증 | 명령 | 결과 |
|------|------|------|
| application 레이어에 sanitizer/judge | `rg "QuerySanitizer\|querySanitizer\|injectionJudge" src/application --glob "*.ts"` | **`search.usecase.ts`만** |
| 루트 스모크 TS ESLint | `npx eslint test-search-direct.ts` | 파싱 에러 (project 밖) |

**결론:** `HybridUseCase` / `InterpretUseCase` / `ResolveUseCase`는 악성 `query`를 **Layer 1·2 없이** 플래너에 전달 가능. `ReplayUseCase`는 `SearchUseCase.execute` 경유로 방어 유지.

---

## 2026-04-06 — 8차 병렬 스캔 (HTTP·엣지·ID 정리)

| 검증 | 명령 | 결과 |
|------|------|------|
| CORS | `rg -i cors src` | **매칭 없음** → §39 |
| OpenAPI | `rg -i "openapi\|swagger" src` | **매칭 없음** → §41 |
| Rate limit env | `rg HTTP_RATE_LIMIT src/config/env.ts` | `HTTP_RATE_LIMIT_MAX` — 0이면 `server.ts`에서 플러그인 미등록 → §40 |
| `GAPS` ID | Epic 15 문서 경로 항목 | **G-42**가 하이브리드 API(`G-42`)와 충돌 → **`G-45`**로 변경 |

---

## 2026-04-06 — `docs/plans/*` 5차 패스 (에픽별 표 + 메타 갭)

| 검증 | 명령 / 근거 | 결과 |
|------|-------------|------|
| 플랜 Deliverables `[ ]` vs 파일 존재 | `Glob` / `test -f` (Epic 1·6 스크립트 등) | **일부는 구현됐으나 체크박스 미갱신** → `G-55` |
| Epic 14 `retrieval_mode_source` | `rg retrieval_mode_source src` | **0건** → `G-56` (`G-12`와 연관) |
| SSOT 반영 | [`PLANS-GAP-AUDIT.md`](./PLANS-GAP-AUDIT.md) **§5차 패스** 표 | v0.1/v0.2·`00-overview` 요약 추가 |

---

## 2026-04-06 — 6차: 문서↔코드 재대조 (Epic 9 · eval · v0.3)

| 검증 | 명령 / 근거 | 결과 |
|------|-------------|------|
| `npm run eval` | `package.json` `"eval"` → `scripts/eval/run-offline-eval.ts`; `test -f` | **파일 존재** — 과거 `run-eval.ts` 가정 **폐기**; [`GAPS`](./GAPS.md) **G-04** 해소 |
| Epic 9 본문 표 | `rg` `retrievalMode|matchReasons|abstainReason` in `search-response.ts`, `result-item.ts`, `response-builder.ts` | 플랜 `epic-9-llm-envelope.md` 표는 여전히 ❌ — **문서 드리프트**; **`missingInformation`만** 타입 갭 (`G-41`) |
| v0.3 Epic 18 Track A | `test -f data/noisy-entity-benchmark.jsonl`; `test -f scripts/eval/run-noisy-entity-eval.ts` | **존재** — 벤치·러너 **부분 충족** |
| v0.3 Epic 18 Track B | `test -f src/domain/query/service/query-normalizer.ts` | **존재** — 실행 계획 문서의 “신규”와 **불일치** → 문서 갱신 권장 |
| SSOT | [`PLANS-GAP-AUDIT.md`](./PLANS-GAP-AUDIT.md) | **§apr-6-v0.3**·Epic 9 드리프트 표·재현 블록 갱신 |

---

## 이전 항목 (요약만 유지)

- 2026-04-06 이전 초기 감사: [`BACKLOG.md`](./BACKLOG.md) 본문.

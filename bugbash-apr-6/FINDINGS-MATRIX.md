# 병렬 점검 — 빵꾸·보완점 매트릭스 (근거 SSOT)

**목적:** 같은 이슈를 **파일·라인·재현 커맨드**로 한 번에 추적한다. 장문 서술은 [`BACKLOG.md`](./BACKLOG.md) §, 작업 우선순위는 [`TASKS.md`](./TASKS.md), ID 색인은 [`GAPS.md`](./GAPS.md).

**갱신:** 2026-04-06 — `M-36`–`M-38` (`G-46`–`G-48`, §39–§41) CORS·rate limit·OpenAPI 추가; Epic 15 문서 경로 ID **`G-45`** (`GAPS` 충돌 정리).

---

## 검증 스냅샷 (이번 세션)

| 검증 | 결과 |
|------|------|
| `npm run typecheck` | 통과 |
| `npm run test` | 1083 passed (68 files) |
| `npm run lint` | 실패 권장 — 이전 기록 214 errors ([`AUDIT-LOG.md`](./AUDIT-LOG.md)) |
| `scripts/run-eval.ts` | **없음** (`Glob` 0건) — `package.json` `"eval"` 스크립트 깨짐 |
| `data/golden-queries-bronze.jsonl` | **500** 줄 (`wc -l`) |
| `data/golden-queries-silver.jsonl` / `golden-queries-gate.jsonl` (루트) | **없음** — `data/splits/*.jsonl` 사용 |

---

## 매트릭스 (우선순위 대략 순)

| ID | `GAPS` | 영역 | 문제 (한 줄) | 근거 (파일·라인 또는 명령) | `BACKLOG` |
|----|--------|------|----------------|-----------------------------|-----------|
| **M-01** | **G-03** | Eval | 시나리오 A–H → `EntityTargetType` 매핑이 Epic 2와 다름 | `scripts/eval/run-offline-eval.ts` 106–116 vs `epic-2-golden-query-set.md` §8 시나리오 표 | §1, P0 |
| **M-02** | **G-02** | Planner | `producer_browse` / `region_browse` / `no_match_detection` **미반환** | `planner.ts` `determineRetrievalMode` 414–469 — 위 문자열 `return` 없음 | §2, P0-2 |
| **M-03** | **G-02** | Eval | 게이트 키 vs 런타임 모드 불일치 | `run-offline-eval.ts` `MODE_RELEASE_GATES` 64–103 | §2 |
| **M-04** | **G-08** | Retrieval | Browse/Compare **스텁** (빈 배열) | `browse-retriever.ts` 50, 82 / `compare-retriever.ts` 79 | P0-1 |
| **M-05** | **G-08** | Search | Browse/Compare **use case 미배선** | `rg BrowseRetriever\|CompareRetriever src/application` → 0건 | P0-1 |
| **M-06** | **G-09** | Response | `ResultGrouper` **다른 모듈에서 미사용** | `rg ResultGrouper src` → 정의 파일만 | P0-3 |
| **M-07** | **G-10** | v0.2 | ConstraintSAT **미구현** | `rg constraint-sat\|ConstraintSAT src` → 0건 | P1-4 |
| **M-08** | **G-32** | Data | 루트 golden silver/gate 파일명 vs `splits/` | `ls data/golden-queries*.jsonl` — bronze만 | P1-5 |
| **M-09** | **G-38** | Epic 14 | LLM decomposer 폴백 **없음** | `rg llm-decomposer src` → 0 | P1-6 |
| **M-10** | **G-19** | Docs | Epic 4 문서 경로 vs TS LTR | `scripts/ltr/train_lambdamart.py` 등 없음 | P2-7 |
| **M-11** | **G-04** | Tooling | **`npm run eval` 깨짐** | `package.json` `"eval": "tsx scripts/run-eval.ts"` — 파일 **부재** | §31 |
| **M-12** | **G-06·G-22** | CI | `verify-splits` / semgrep / e2e **미실행** | `ci.yml` — lint, tsc, test, build만 | §15 |
| **M-13** | **G-06** | Lint | CI 전체 `eslint .` | `ci.yml` 14–15행 | §14 |
| **M-14** | **G-07** | DevX | `test-search-direct.ts` ESLint project **밖** | 파싱 에러 | §13 |
| **M-15** | **G-01** | Planner | JSDoc “constraints placeholder” **거짓** | `planner.ts` 114행 | §12 |
| **M-16** | **G-13** | Pairing | `extractPairingConstraint` **미배선** | `rg extractPairingConstraint src` → 정의만 | §32 |
| **M-17** | **G-14** | Index | Vespa `pairing` + `pairing_tags` — 매핑은 `pairing`만 | `wine_entity.sd` 85·187; `mapping.ts` 125행 | §32 보강 |
| **M-18** | **G-20** | Ranking | `wine-attribute-encoder.ts` **import 0건** | `rg wine-attribute-encoder` → 0; `ranker` → `label-encoder.js` | §33 |
| **M-19** | **G-12** | API | top-level **`retrieval_mode`** 없음 | `search.schema.ts` — `options.mode`만 | §G2 |
| **M-20** | **G-05** | API | 쿼리 **2000 vs sanitizer 500** | `search.schema.ts` 30행 vs `query-sanitizer` | §24 |
| **M-21** | **G-15** | Batch | 정책 실패도 **`succeeded`** | `batch-search.usecase.ts` 312–316 | §C |
| **M-22** | **G-16** | HTTP | Injection 시에도 **200** | `search.route.ts` 44행 | §C |
| **M-23** | **G-27** | ONNX | Drinking window **stub** | `drinking-window-predictor.ts` 65–71 | §19 |
| **M-24** | **G-28** | Claude | `check_drinking_window` placeholder | `tool-executor.ts` 215–230 | §20 |
| **M-25** | **G-14** | Vespa | `critic_proxy_*` 스키마 vs 도메인 normalized만 | `wine_entity.sd` / `mapping.ts` / `retrieval-document.ts` | §B 보강 |
| **M-26** | **G-23** | Watchlist | UUID 스키마 vs **nanoid** | `BACKLOG` §34 | §34 |
| **M-27** | **G-24** | Watchlist | Redis subscriber / DB **미완** | `BACKLOG` §35 | §35 |
| **M-28** | **G-25** | NL | `drinking_window_now` NL 없음 | `BACKLOG` §36 | §36 |
| **M-29** | **G-26** | Server | `EVAL_RUN_AT_STARTUP` | `server.ts` 144–167 | §37 |
| **M-30** | **G-41** | Response | `missingInformation` 없음 | `rg missingInformation src/domain/response` → 0 | §25 |
| **M-31** | **G-35** | LTR | Vespa native LTR rank-profile 없음 | `rg ltr_v1 vespa` → 0 | §26 |
| **M-32** | **G-30** | Security | `LLMInjectionJudge` fail-open | `BACKLOG` §30 | §30 |
| **M-33** | **G-40** | Security | Hybrid/Interpret/Resolve에 **QuerySanitizer 없음** | `BACKLOG` §38, `rg QuerySanitizer src/application` | §38 |
| **M-34** | **G-42** | API | **`POST /v1/search/hybrid`** vs **`POST /v1/search`** + `options.mode: hybrid` — **서로 다른 파이프라인** | `HybridUseCase`는 resolver **스킵** (`hybrid.usecase.ts` 55–93); 일반 검색은 planner+`resolveRoute` | `TASKS` §L |
| **M-35** | **G-43** | API | **`POST /v1/entity/resolve`**가 **`requestId`** 를 유스케이스에 전달하지 않음 | `resolve.route.ts` 12–19; `resolve.usecase.ts` `execute` 시그니처에 request id 없음 | `TASKS` §L |
| **M-36** | **G-46** | HTTP | **CORS 미등록** | `rg -i cors src` → **0건** | §39 |
| **M-37** | **G-47** | Config | **`HTTP_RATE_LIMIT_MAX=0`** → rate limit 플러그인 **미등록** | `env.ts` 15–16 · `server.ts` 92–96 | §40 |
| **M-38** | **G-48** | Docs | **OpenAPI/Swagger 없음** | `rg -i "openapi|swagger" src` → **0건** | §41 |
| **M-39** | **G-55** | Plans | **`docs/plans` Deliverables `- [ ]`** vs 이미 존재하는 스크립트·타입 — **문서만 미갱신** | `PLANS-GAP-AUDIT` §5차 · `Glob`/`rg` | — |
| **M-40** | **G-56** | Epic 14 | **`retrieval_mode_source` / `api_override`** — 응답에 없음 | `rg retrieval_mode_source src` → **0건** | `G-12` |

행 **M-33** (`G-40`)은 §38 injection 우회 — [`BACKLOG.md`](./BACKLOG.md) 본문 §38.  
**M-34–M-35** §L. **M-27**/`G-24`에 watchlist Redis·DB 미완(§35) 상세. **M-36–M-38** §39–§41 (CORS·rate limit 0·OpenAPI). **M-39–M-40** `PLANS-GAP-AUDIT` §5차 (`G-55`·`G-56`).

---

## 재현 커맨드 묶음 (로컬)

```bash
# 깨진 npm script
test -f scripts/run-eval.ts && echo ok || echo MISSING

# Planner 모드
rg "return '(producer_browse|region_browse|no_match_detection)'" src/domain/query/service/planner.ts

# Browse/Compare 배선
rg "BrowseRetriever|CompareRetriever" src/application --glob "*.ts"

# ResultGrouper
rg "ResultGrouper" src --glob "*.ts"

# Pairing 쿼리 타임
rg "extractPairingConstraint" src --glob "*.ts"

# wine-attribute-encoder 데드 코드
rg "wine-attribute-encoder" --glob "*.ts"

# CI 범위
cat .github/workflows/ci.yml

# Golden 파일
ls -1 data/golden-queries*.jsonl data/splits/*.jsonl 2>/dev/null

# CORS / OpenAPI / rate limit (§39–41)
rg -i cors src
rg -i "openapi|swagger" src
rg HTTP_RATE_LIMIT src/config/env.ts

# Epic 14 플랜 메타 (G-56)
rg retrieval_mode_source src
```

---

## 다음에 매트릭스만 갱신할 때

1. 위 **검증 스냅샷** 표의 숫자·파일 존재 여부를 다시 실행해 갱신한다.  
2. 새 행은 **`M-41`…** 순으로 추가하고, 가능하면 [`GAPS.md`](./GAPS.md)에 `G-xx` 한 줄을 맞춘다.  
3. 상세 서술·완료 정의는 **BACKLOG §에만** 두고, 여기서는 **한 줄 + 포인터**로 둔다.

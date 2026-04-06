# 실제 빵꾸만 (SSOT)

**검증:** 저장소 코드·워크플로 재대조 (정적 `rg`/파일 읽기).  
**전체 ID 색인(역사 포함):** [`GAPS.md`](./GAPS.md)  
**플랜 대비 서술:** [`PLANS-GAP-AUDIT.md`](./PLANS-GAP-AUDIT.md) — 본 파일 갱신에 맞춰 일부 행 수정됨.  
**보완 계획 (난이도·규모·웨이브):** [`REMEDIATION-PLAN.md`](./REMEDIATION-PLAN.md)

---

## 해소됨 — 더 이상 “기능 빵꾸”로 두지 않음 (2026-04-06)

| ID | 한 줄 |
|----|--------|
| **G-04** | `npm run eval` → `scripts/eval/run-offline-eval.ts` 존재 |
| **G-05** | `MAX_QUERY_LENGTH` 2000 — `constants`·`QuerySanitizer`·`QueryStringSchema` 정렬 (구 “500자” 감사는 구식) |
| **G-06** | `npm run lint` 통과 |
| **G-10** | `ConstraintSAT` (`constraint-sat.ts`) + `SearchUseCase` 프리루트 배선 |
| **G-22** | CI `.github/workflows/ci.yml`에 **`verify-splits` 잡** (`npx tsx scripts/eval/verify-splits.ts`) |
| **G-40** | `HybridUseCase`·`InterpretUseCase`·`ResolveUseCase` 모두 **`QueryEntrySecurityGate`** |
| **G-43** | `toResolveRequest(..., requestId)` + `ResolveUseCase`에서 trace/`request_id` 반영 |
| **G-48** | **`GET /openapi.json`** (`openapi.route.ts`) — 잔여 갭은 “계약 커버리지·문서화 수준” 수준 |
| **G-01** | `Planner` 클래스·`parseConstraints` JSDoc — **NLMapper + 룰 추출**으로 정렬됨 (구 “placeholder” 서술 제거) |
| **G-02** | `determineRetrievalMode`가 **`producer_browse` / `region_browse` / `no_match_detection`** 등 반환 (`planner.ts`) |
| **G-08** | `BrowseRetriever` / `CompareRetriever` — **Vespa 필터·오버페치·다양성** 등 실제 검색 경로 (스텁 아님) |
| **G-64** | 하이브리드 `CandidatePoolService`가 **`hardConstraintsToSparseFilterTokens`**로 Vespa 필터 토큰 정렬 (`browse`/`compare`와 동일 계약) |

---

## 실제 빵꾸 — 우선순위 높음 (동작/측정)

| ID | 한 줄 |
|----|--------|
| **G-03** | 골든 행에 **`retrieval_mode` 누락** 시 시나리오 문자만으로는 producer/region browse와 구분 불가 — `scripts/eval/entity-type.ts`는 **모드 우선**; 골든 데이터에 모드 채우기 권장 |
| **G-09** | `ResultGrouper` — **정의만**, 응답 빌더/HTTP 경로 **미연결** |
| **G-13** | `extractPairingConstraint` — **`pairing-extractor.ts` 정의만**, 검색 파이프라인 **미import** |
| **G-14** | `mapping.ts` 등 Vespa 요약 필드 ↔ Epic 12 필드(`critic_proxy`·`pairing_tags` 등) **정합 미검/미매핑** 가능 |
| **G-18** | `parsedConstraints.unparsed` **항상 `[]`** (`response-builder.ts`) |
| **G-19** | Epic 4 문서(Python/Vespa LETOR) vs **TS 앱 레이어 LTR** — **문서·스키마 불일치** |
| **G-21** | ~~단일 npm 스크립트 없음~~ → **`npm run eval:offline:with-splits`** (`--verify-splits`) 추가됨. 기본 `eval`은 여전히 검증 생략(속도). |

---

## 실제 빵꾸 — 보안·배치·운영 (의도적 설계일 수 있음)

| ID | 한 줄 |
|----|--------|
| **G-15**–**G-17** | 배치 `succeeded`/병렬 `fail_fast` 시맨틱, injection 시 HTTP 200 등 — **TASKS §C** |
| **G-16** | Injection 차단 시에도 **`POST /v1/search` 200** (본문 failed) — 정책 결정 필요 |
| **G-23**–**G-24**, **G-49**–**G-51** | Watchlist UUID vs nanoid·subscriber·인메모리 CRUD 등 |
| **G-25**–**G-28** | `drinking_window_now` NL 매핑, ONNX 배포, `EVAL_RUN_AT_STARTUP`, tool 주석 vs 구현 차이 **일부 완화됨** — 운영 확인 필요 |
| **G-29**–**G-30** | 검색 캐시 활성화 정도, `LLMInjectionJudge` fail-open |
| **G-42** | `/v1/search/hybrid` vs `/v1/search`+`mode:hybrid` **파이프라인 차이** |
| **G-57**–**G-63** | PG 필수성·전역 config·`/ready` 등 부트스트랩/계약 이슈 |

---

## 실제 빵꾸 — 문서·정리·P2

| ID | 한 줄 |
|----|--------|
| **G-07** | 루트 `test-search-direct.ts` — ESLint **ignore** (구 “파싱 에러”보다 **무시 파일**에 가깝) |
| **G-11** | Entropy `AbstainPolicy` — 플랜 대비 **미구현/부분** |
| **G-12** | top-level `retrieval_mode`·override 메타 — **스키마 없음** |
| **G-20** | `WineAttributeEncoders` 등 **이중 정의·미사용** 정리 |
| **G-31**–**G-33** | `mode-metrics.ts` 파일명 vs `metrics.ts` 통합, Golden 명명, Reranker README |
| **G-34**–**G-36** | 비교 응답 구조, Vespa LTR vs 앱 LTR, tsconfig 빌드 |
| **G-37** | PG 미연결 시 stub 광의 |
| **G-38** | `LLMDecomposerPort` / `llm-decomposer` **미구현** |
| **G-39** | 플랜 “BK-tree+Soundex” — 별칭 경로에는 **char-ngram·phonetic** 등 **다른 구현**; 플랜 문구와 1:1 아님 |
| **G-41** | `missingInformation` — **응답 스키마에 없음** |
| **G-45** | Epic 15 플랜 파일명·`scripts/ml/` vs 실제 `drinking-window-backfill.ts` 등 **경로 불일치** |
| **G-46**–**G-47** | CORS·rate limit 0 동작 |
| **G-55**–**G-56** | `docs/plans` 체크박스 드리프트·`retrieval_mode_source` 등 |
| **G-52** | domain↔infra 계약 잔여 |

---

## 재현 (빠른 확인)

```bash
# G-02: planner가 browse/no_match 모드를 반환하는지
rg "producer_browse|region_browse|no_match_detection" src/domain/query/service/planner.ts

# G-64: CandidatePool이 sparse 필터 토큰 매퍼를 쓰는지
rg "hardConstraintsToSparseFilterTokens" src/domain/retrieval/service/candidate-pool.ts

# G-09: Grouper 연결 여부
rg "ResultGrouper" src --glob '*.ts'

# G-13: 페어링 추출기 배선
rg "extractPairingConstraint|pairing-extractor" src --glob '*.ts'

# G-21: eval이 verify-splits 부르는지
rg "verify-splits|verifySplits" scripts/eval/run-offline-eval.ts
```

---

**최종 갱신:** 2026-04-06

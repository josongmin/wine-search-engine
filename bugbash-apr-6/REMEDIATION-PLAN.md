# 실제 빵꾸 보완 계획 (난이도 · 규모)

**근거:** [`ACTUAL-GAPS.md`](./ACTUAL-GAPS.md)  
**규모 표기:** XS(&lt;0.5d) · S(0.5–1d) · M(2–4d) · L(1–2주) · XL(2주+) — 1인 기준 가이드.

**난이도:** 낮음(기계적/문서) · 중간(설계·다파일) · 높음(아키텍처·인프라·스키마)

### Epic 15 (L15) — 노 휴리스틱 / 런타임 노 폴백 — **완료 (코드)**

| 항목 | 내용 |
|------|------|
| 부팅 | `NODE_ENV=production` + ONNX 미로드 + `ALLOW_HEURISTIC_DRINKING_WINDOW` 미설정 → 기존처럼 **시작 거부** |
| `predict()` | `DrinkingWindowPredictor({ allowHeuristicFallback })` — 프로덕션·휴리스틱 비허용 시 ONNX 없으면 **throw** (조용한 규칙 기반 경로 없음) |
| 컨테이너 | `allowHeuristicFallback` = non-production **또는** `ALLOW_HEURISTIC_DRINKING_WINDOW=true` |
| TDD | `src/infrastructure/ml/__tests__/drinking-window-predictor.test.ts` (휴리스틱 off 시 throw) |
| 문서 | `models/drinking-window/README.md` |

개발·테스트(`NODE_ENV !== production`)는 기본적으로 휴리스틱 허용(로컬 ONNX 없이 개발 가능).

---

## Wave A — 측정·문서만 맞추면 되는 것 (빠른 승리)

| ID | 보완 내용 | 난이도 | 규모 | 비고 |
|----|-----------|--------|------|------|
| **G-01** | `Planner` JSDoc·주석을 `parseConstraints` 실제 흐름에 맞게 수정 | 낮음 | XS | 파일 1–2곳 |
| **G-03** | `ENTITY_TARGET_TYPE_MAP`를 Epic 2 시나리오 정의와 정렬, 주석·테스트 갱신 | 낮음 | S | 슬라이스 메트릭 의미가 바뀜 → baseline 재기록 필요할 수 있음 |
| **G-19** | `epic-4-ltr.md` 등을 **TS 앱 LTR + PG 레지스트리** 기준으로 재서술, Vespa second-phase는 “옵션/미도입” 명시 | 낮음 | S–M | 코드 변경 없이도 가능 |
| **G-21** | `run-offline-eval` 시작 시 `verify-splits` 호출 옵션(`--verify-splits`) 또는 `npm run eval:full` 스크립트로 묶기 | 낮음 | S | **완료:** `--verify-splits`·`eval:full`·병렬 게이트 `npm run eval:sota:parallel` (`scripts/eval/run-sota-parallel.sh`) |
| **G-31**–**G-33** | Epic 11 문서 ↔ `metrics.ts` 경로 정리, Golden 명명 RUNBOOK 한 줄, `services/reranker/README.md` | 낮음 | XS–S 각 | |
| **G-45** | Epic 15 플랜의 스크립트 경로를 실제 파일명으로 수정 | 낮음 | XS | |
| **G-55** | `docs/plans` 체크박스·Epic 9 표를 코드와 동기화 (`missingInformation`만 갭으로 남김) | 낮음 | M | 표가 많으면 반나절~하루 |
| **G-07** | `test-search-direct.ts`를 `scripts/`로 옮기거나 eslint include·ignore 정책 명시 | 낮음 | XS | **완료:** [`scripts/dev/test-search-direct.ts`](../scripts/dev/test-search-direct.ts) |

---

## Wave B — 검색 파이프라인·플래너 (핵심 제품 동작)

| ID | 보완 내용 | 난이도 | 규모 | 비고 |
|----|-----------|--------|------|------|
| **G-02** | `determineRetrievalMode`에 producer/region browse·`no_match_detection` 분기 (의도·골든·`MODE_RELEASE_GATES`와 합의 후) | 중간 | M–L | 앵커/엔티티 타입 추론·테스트·골든 재검증 |
| **G-08** | `BrowseRetriever`/`CompareRetriever`에 `SearchIndexPort`(또는 기존 hybrid 쿼리) 연결, 빈 배열 제거 | 중간 | L | Vespa 쿼리 설계·다양성 규칙 |
| **G-09** | `ResultGrouper`를 `ResponseBuilder` 또는 매핑 단계에 연결, 스키마 필드 합의 | 중간 | M–L | API 응답 형태 변경 가능 |
| **G-13** | `extractPairingConstraint` → Planner 후보 제약 또는 Vespa `pairing` 필터로 연결 | 중간 | M | G-14와 함께 잡는 편이 효율적 |
| **G-14** | `mapping.ts`·요약 필드에 `critic_proxy`·`pairing_tags` 등 반영 여부 확정 후 매핑·테스트 | 중간 | M | 스키마에 필드 없으면 ETL/Vespa 선행 |
| **G-18** | NLMapper/룰이 못 짚은 구문을 `unparsed`에 누적 (빌더에서 `[]` 고정 해제) | 중간 | S–M | 스키마는 이미 `unparsed` 배열 있음 |
| **G-41** | `SearchResponseV1`·Zod에 `missingInformation` 추가, 빌더에서 채움 | 중간 | M | 클라이언트 계약 변경 |
| **G-12** | (선택) HTTP top-level `retrieval_mode` 또는 응답에 `retrieval_mode_source` — 제품 합의 후 | 높음 | L | Epic 14·OpenAPI·클라 연동 |

---

## Wave C — 고급 검색·분해·랭킹 (연구·설계 비중 큼)

| ID | 보완 내용 | 난이도 | 규모 | 비고 |
|----|-----------|--------|------|------|
| **G-11** | Entropy 기반 `AbstainPolicy` — planner·resolver와 중복 없게 설계 | 높음 | L | 캘리브레이션·오프라인 지표 |
| **G-38** | `LLMDecomposerPort` + 폴백 구현체, 컨테이너 배선 | 높음 | L | 비용·지연·실패 모드 정의 |
| **G-35** / **G-36** | Vespa rank profile·ONNX LTR vs 앱 LTR — 로드맵 택1 또는 병행 역할 분리 문서화 | 높음 | XL | 인프라·재인덱싱 |
| **G-39** | 플랜을 “char-ngram·phonetic 구현됨”으로 갱신하거나, Soundex/BK-tree를 **의도적으로 추가** | 중간 | M (문서) / L (신규 알고) | 중복 가치 검토 |
| **G-34** | 비교 응답에 테이블 축·`ComparisonCandidate` 정렬 — 제품 스펙 필요 | 중간 | M–L | |

---

## Wave D — 보안·배치·운영 (정책 선행)

| ID | 보완 내용 | 난이도 | 규모 | 비고 |
|----|-----------|--------|------|------|
| **G-15**–**G-17** | 배치 집계·`fail_fast` 문서화 vs 구현 맞추기 | 낮음–중간 | S–M | 동작 변경 시 클라 영향 |
| **G-16** | injection 시 HTTP 4xx vs 200+본문 failed — **API 정책 결정** 후 구현 | 중간 | S–M | 하위 호환 |
| **G-42** | hybrid 전용 라우트와 통합 검색의 차이를 문서·OpenAPI에 명시, 필요 시 파이프라인 통합 | 중간 | M | |
| **G-29**–**G-30** | 캐시 플래그·judge fail-open 정책 명문화 | 중간 | S 각 | |
| **G-46**–**G-47** | CORS·rate limit 0 — 배포 형태(역프록시 여부)에 맞게 문서 또는 `@fastify/cors` | 낮음–중간 | S | |
| **G-23**–**G-24**, **G-49**–**G-51** | Watchlist ID·subscriber·마이그레이션 — 운영 스택에 맞춰 순차 | 높음 | L–XL | |

---

## Wave E — 부트스트랩·관측 가능성 (플랫폼)

| ID | 보완 내용 | 난이도 | 규모 | 비고 |
|----|-----------|--------|------|------|
| **G-57**–**G-63** | PG optional 설계 정리, `/ready`가 의존성 probe 반영, 전역 config 주입 | 높음 | L | 배포 환경별 분기 |
| **G-20** | `WineAttributeEncoders` vs `label-encoder` 통합 또는 단일 SSOT | 중간 | M | 리팩터 충돌 주의 |
| **G-52** | domain→infra 역참조 잔여 제거 | 중간 | M | |
| **G-37** | stub vs prod 경고·문서 | 낮음 | S | |

---

## 권장 순서 (의존성)

1. **Wave A** (문서·맵·eval 묶음) — 리스크 낮고 지표부터 바로 고침.  
2. **G-02 + G-08** — 모드 선택과 리트리버를 같이 설계하면 중복 작업 감소.  
3. **G-13 + G-14** — 페어링·필드 매핑 한 번에.  
4. **G-09 + G-41** — 응답 형태 합의 후 진행.  
5. **Wave D/E** — 제품·운영 합의와 병행.

---

## SOTA++ 병렬 실행에 대해 (현실적인 기대치)

한 번에 “전 웨이브·노 휴리스틱·노 폴백·전 에픽”은 **아티팩트(ONNX/LTR)·스키마·제품 합의** 없이는 불가능하다. 권장 전략:

1. **Wave A + TDD**로 측정·계약·split 검증을 먼저 고정한다 (`--verify-splits`, `npm run eval:full`, **`npm run eval:sota:parallel`** — typecheck·splits·smoke·noisy 병렬, entity-type, Planner 주석 등).
2. **드링킹 윈도우 (L15)**: 위 표 **완료** — 부팅 가드 + `predict()` 런타임 가드. 프로덕션 ONNX 경로는 **`DRINKING_WINDOW_MODEL_DIR` + `load()` 성공** 전제.
3. **Wave B/C**는 브랜치·피처 플래그로 나눠 병렬 리뷰.

**최종 갱신:** 2026-04-06

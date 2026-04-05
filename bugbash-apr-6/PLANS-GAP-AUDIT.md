# `docs/plans/*` 대비 구현 갭 감사

**기준 시점:** 저장소 정적 대조 (코드·스크립트 존재, 주요 심볼 `rg`).  
**범위:** `docs/plans/apr-5-v0.1/*`, `docs/plans/apr-5-v0.2/*`, **`docs/plans/apr-6-v0.3/*` (Epic 18 요약)**  
**용도:** 플랜 문서와 실제 구현의 빵꾸를 한곳에 모음. 상세 근거·행 번호는 [`BACKLOG.md`](./BACKLOG.md)·[`TASKS.md`](./TASKS.md)·[`GAPS.md`](./GAPS.md)와 교차 참고.  
**최종 갱신:** 2026-04-06 (6차: **`npm run eval`·Epic 9 본문 표·v0.3 Epic 18 Track A/B** 재대조)

---

## `00-overview.md` — §「구현 필요」표 ↔ 코드 (한 장)

마스터 플랜 표의 “갭 | Phase | Epic” 열이 아래 매트릭스와 대응한다. (세부는 위 표와 동일 주제.)

| 플랜 행 (요약) | Epic | 빵꾸 요약 |
|----------------|------|-----------|
| 10K ETL | 1 | 스크립트·스키마 있음; 품질·10K는 운영 데이터로 재확인 |
| Golden 500 | 2 | `bronze`+`splits`; 파일명·`ENTITY_TARGET_TYPE_MAP` → `G-03`, `G-32` |
| Eval | 3 | `npm run eval` → `scripts/eval/run-offline-eval.ts` **존재** (과거 `run-eval.ts` 가정 **해소**); `verify-splits`·eval 연동·CI **없음** → `G-21`, `G-22` |
| LTR | 4 | TS LTR vs 문서 Python/Vespa → `G-19` |
| Reranker | 5 | 서비스 있음; README 없음 → `G-33` |
| Embedding FT | 6 | 스크립트 있음; 커밋 모델 없음 → `BACKLOG` §11 |
| retrieval_mode 10종 | 7 | 타입 있음; planner 미선택 → `G-02` |
| Entity surface | 8 | `ResultGrouper` 미연결 → `G-09` |
| LLM envelope | 9 | **필드 대부분 구현**; 플랜 체크리스트 `[ ]` **문서 미갱신** + `missingInformation` 없음 → §25 |
| Browse/Compare | 10 | 스텁 → `G-08` |
| Mode eval | 11 | `metrics.ts` 통합 → `G-31` |

---

## apr-5-v0.1 — 요약 매트릭스

| Epic | 플랜 핵심 | 구현 상태 (요약) | 비고 |
|------|-----------|------------------|------|
| 1 ETL | Silver·별칭·Vespa 인덱싱 | 스크립트 세트 존재 | 운영 데이터·품질 게이트는 런타임 확인 |
| 2 Golden | 500·leakage·3-tier | `golden-queries-bronze` 500 + `splits/*` | 루트 `golden-queries-{silver,gate}.jsonl` 명명은 문서와 다름 |
| 3 Eval | 메트릭·게이트·significance | `metrics.ts`·`run-offline-eval.ts` 등 | sparse/dense 분리·blocker recall·eval↔verify 연동 갭 → BACKLOG §16–17, §6 |
| 4 LTR | LightGBM·LETOR·Vespa 2nd phase | **TS 앱 레이어 LTR**·PG 레지스트리 | 문서 파일명·Python 경로 불일치 → BACKLOG §5, §26 |
| 5 Rerank | FastAPI·compose·`buildWineText` | 서비스·어댑터·랭커 있음 | README 없음·passage 필드 차이 → BACKLOG §9, 선택 P2 |
| 6 Fine-tune | py triplets·distill·reindex | `scripts/ltr/*.py` 등 | 커밋된 `models/*` 없음 → §11 |
| 7 RetrievalMode | 10 모드·플래너 | 타입·가중치·골든 태그 | **`producer_browse`/`region_browse`/`no_match_detection` 미선택** → §2, TASKS §I |
| 8 Entity surface | QueryTarget·grouper | 추론·`ResultGrouper` 구현 | **응답 파이프라인 미연결** → §4 |
| 9 LLM envelope | 필드 확장 | **`retrievalMode` / `resultType` / `parsedConstraints` / `matchReasons` / `violatedConstraints` / `abstainReason` 구현** | `missingInformation` 없음 → §25·`G-41`; **`epic-9-llm-envelope.md` 본문 표·작업 `[ ]`는 문서 드리프트** (표가 여전히 ❌로 표기) |
| 10 Browse/Compare | 전용 리트리버 | **스텁** | §3 |
| 11 Mode eval | mode slice·게이트 | `metrics`에 통합 | 별도 `mode-metrics.ts` 없음 → §7 |

---

## apr-5-v0.2 — Epic 12–17 요약 매트릭스

플랜 출처: `docs/plans/apr-5-v0.2/00-overview.md` 및 각 epic 문서.

### Epic 12 — Data enrichment (critic proxy, certification, pairing)

| 플랜 항목 | 확인 | 갭 |
|-----------|------|-----|
| `scripts/etl/generate-critic-proxy.ts` | **파일 존재** | Vespa 필드·`mapping.ts`·도메인 노출 일치는 별도 검증 (TASKS §B `critic_proxy` 등) |
| `scripts/etl/enrich-certifications.ts` | **파일 존재** | 동일 |
| `scripts/etl/generate-pairings.ts` + query-time pairing | ETL는 `PAIRING_TAXONOMY` import | **`extractPairingConstraint` 검색 경로 미배선** → BACKLOG §32 |
| Wikidata SPARQL | 스크립트 존재 가정 | 런타임·커버리지는 미검 |

### Epic 13 — Query intelligence (ConstraintSAT, entropy abstain, typo+phonetic)

| 플랜 항목 | 확인 | 갭 |
|-----------|------|-----|
| `src/domain/query/service/constraint-sat.ts` / `ConstraintSAT` | `rg ConstraintSAT src` → **매칭 없음** | **미구현** — 플랜 Step 13.1과 불일치 |
| Calibrated entropy abstain (top-K 분산) | planner에 entropy 분기 없음 | **미구현/부분** → BACKLOG §29 |
| BK-tree + Soundex 통합 | `rg` BK-tree / Soundex (별칭 경로) → **의미 있는 구현 없음** | **미구현** |
| Planner 직후 모순 탐지 | `extractRuleBasedConstraints` if/else if 체인만 (dry/sweet 등) | TASKS §A “dry sweet” 모순 한계 |

### Epic 14 — Decomposition API + `retrieval_mode` override

| 플랜 항목 | 확인 | 갭 |
|-----------|------|-----|
| `decomposition-detector.ts` | **존재**, `search.route`에서 사용 | 부분 충족 |
| `llm-decomposer.ts` / `LLMDecomposerPort` | `rg llm-decomposer src` → **없음** | **플랜 폴백 레이어 미구현** |
| `DecomposedSearchUseCase` | **존재**, 컨테이너·tool 연결 | 비교 플로우 부분 충족 |
| HTTP `retrieval_mode` top-level | `search.schema.ts`에 **필드 없음** (`options.mode`만) | TASKS §I, Epic 14 Step 14.2 갭 |

### Epic 15 — Drinking window

| 플랜 항목 | 확인 | 갭 |
|-----------|------|-----|
| `scripts/etl/collect-drinking-windows.ts` (플랜 Step 15.1) | **`Glob` 0건** | 플랜 파일명·경로와 **불일치** — 대안으로 `scripts/etl/drinking-window-backfill.ts` 존재 |
| `scripts/ml/drinking-window-features.ts` (플랜 Step 15.2) | **`scripts/ml/` 디렉터리 없음** | 플랜의 ML 파이프라인 분리 구조 **미반영** (피처는 인프라/도메인 코드에 흡수되었을 수 있음 → 문서 정합성 검토) |
| LightGBM 회귀·ONNX 서빙 | `drinking-window-predictor.ts` **TODO·스텁** | [`BACKLOG.md`](./BACKLOG.md) §19 |
| NL 매핑 `drinking_window_now` | Vespa `mapping.ts`만 분기 | [`TASKS.md`](./TASKS.md) §H (`nl-mapper` 단절) |

### Epic 16 — Security & batch

| 플랜 항목 | 확인 | 갭 |
|-----------|------|-----|
| Query sanitizer + judge | 구현·테스트 존재 | “100% block”은 정책 검토 → BACKLOG §30 |
| `/v1/batch-search` | 구현 존재 | partial failure·`succeeded` 시맨틱 → TASKS §C |
| Injection 시 HTTP 400 vs 200 | 검색 라우트 **200** 응답 | TASKS §C |

### Epic 17 — Agentic & async (watchlist, tools)

| 플랜 항목 | 확인 | 갭 |
|-----------|------|-----|
| Watchlist + Redis pub/sub + webhook | 라우트·Redis 어댑터 존재 | **subscriber 서버 기동·DB 마이그레이션·id 타입** 등 → [`TASKS.md`](./TASKS.md) §H · [`BACKLOG.md`](./BACKLOG.md) §34–§37 |
| Hallucination verify (Epic 17 overview §완료 기준) | `confidence-refusal.ts`·`admission-gate`에 **저신뢰 refusal** 로직 존재 | 플랜의 “LLM 검증 루프”와 동일한지 **제품 문서화** 필요; 별도 `HallucinationVerifier` 모듈은 없음 |
| Agentic multi-step / tool 체인 | `AdaptiveToolExecutor`·Claude 라우트 존재 | 플랜의 “5-step 성공률” **자동 지표·E2E**는 저장소에 **고정 스위트 없음** (수동/옵션) |
| `Hybrid`/`Interpret`/`Resolve` injection 방어 | [`GAPS.md`](./GAPS.md) **G-40** | [`BACKLOG.md`](./BACKLOG.md) §38 — `/v1/search` 외 경로 샌itizer 미적용 가능성 |
| `check_drinking_window` | **플레이스홀더 에러** | [`BACKLOG.md`](./BACKLOG.md) §20 |

---

## apr-6-v0.3 — Epic 18 (Robust Entity Lookup)

플랜: `docs/plans/apr-6-v0.3/00-overview.md`, `epic-18-robust-entity-lookup.md`, `epic-18-execution-plan.md`.

| 트랙 / 플랜 키워드 | 코드 대조 (2026-04-06) | 갭 |
|--------------------|------------------------|-----|
| **Track A** — `noisy-entity-benchmark.jsonl`, `run-noisy-entity-eval.ts` | `data/noisy-entity-benchmark.jsonl` **존재**; `scripts/eval/run-noisy-entity-eval.ts` **존재**; `package.json`에 `eval:noisy` / `eval:noisy:smoke` 등 | **부분 충족** — 벤치·러너 스켈레톤은 있음. North Star 수치(Recall@3≥0.92 등)·feedback flywheel·alias mining은 **플랜 대비 미완 또는 별도 검증 필요** |
| **Track B** — `NormalizedQueryViews`, `query-normalizer.ts` | `src/domain/query/model/query-views.ts`, `query-normalizer.ts`, `buildNormalizedQueryViews`가 **resolver·alias matcher·planner 경로에 존재** | 실행 계획의 “신규 구현” 체크와 어긋남 → **문서를 구현 상태에 맞게 갱신** 권장 (기능 빵꾸로 보이기 쉬움) |
| **Track C–G** — 편집거리 funnel, phonetic, learned entity matcher, 운영 루프 | BK-tree/Soundex·`ConstraintSAT` 등은 **v0.2 Epic 13과 동일하게 미구현/부분** | Epic 18은 Epic 13·14·16과 **같은 기술 부채 축**을 공유; 독립 완료는 **추가 구현** 필요 |

---

## 재현 커맨드 (플랜 대비 빠른 체크)

```bash
# v0.2 Epic 13 ConstraintSAT
rg "ConstraintSAT|constraint-sat" src || echo "없음"

# v0.2 Epic 14 LLM decomposer
rg "llm-decomposer|LLMDecomposer" src || echo "없음"

# Epic 14 retrieval_mode in HTTP schema
rg "retrieval_mode|retrievalMode" src/interface/http/schemas/search.schema.ts

# v0.1 Epic 4 문서상 스크립트
ls scripts/ltr/feature-schema.ts 2>/dev/null || echo "없음"

# npm script eval (현재는 run-offline-eval.ts)
grep '"eval"' package.json
test -f scripts/eval/run-offline-eval.ts && echo "run-offline-eval.ts ok" || echo "missing run-offline-eval.ts"

# Epic 15 플랜 스크립트 존재 여부
ls scripts/etl/collect-drinking-windows.ts 2>/dev/null || echo "collect-drinking-windows.ts 없음"
ls scripts/ml/drinking-window-features.ts 2>/dev/null || echo "scripts/ml/ 없음"
ls scripts/etl/drinking-window-backfill.ts 2>/dev/null && echo "backfill 스크립트 있음"
```

---

## 플랜 문서 체크리스트 드리프트 (`[ ]` 남음 ↔ 코드는 이미 있음)

아래는 **`docs/plans/**/*.md` 안의 `- [ ]`가 구현과 어긋나는 대표 케이스**다. 기능 빵꾸가 아니라 **문서 미갱신**이 우선이다. (실제 갭은 위 매트릭스·[`GAPS.md`](./GAPS.md)·[`FINDINGS-MATRIX.md`](./FINDINGS-MATRIX.md) 참고.)

| 플랜 | 문서 상태 | 코드/저장소 실제 | 조치 |
|------|-----------|------------------|------|
| **Epic 9** `epic-9-llm-envelope.md` | 본문 표에 `retrievalMode`/`resultType`/`parsedConstraints`/`matchReasons`/`violatedConstraints` ❌, 작업 항목 전부 `[ ]` | `SearchResponseV1`·`ResultItem`·`EngineDecision`에 위 필드 **대부분 구현** (`search-response.ts`, `result-item.ts`, `response-builder.ts`); `abstainReason` **존재** | 플랜 표·작업 목록을 **구현에 맞게 갱신** — **남은 진짜 갭은 `missingInformation`뿐** |
| **Epic 9** 동일 | `missingInformation` ❌ | 타입에 **여전히 없음** → 진짜 갭 | [`GAPS.md`](./GAPS.md) **G-41** · `BACKLOG` §25 |
| **Epic 6** `epic-6-embedding-finetune.md` | Deliverables `- [ ] scripts/ltr/finetune_embedding.py` 등 | `scripts/ltr/finetune_embedding.py`, `distill_cross_encoder.py` **존재**; 추가로 `scripts/embedding/finetune-bge-m3.ts` 존재 | Deliverables 체크·경로를 **현재 트리에 맞게** 수정; 커밋 모델 `models/*` 없음은 §11과 동일 |
| **Epic 15** `epic-15-drinking-window.md` | `collect-drinking-windows.ts`, `scripts/ml/drinking-window-features.ts` | 해당 경로 **없음**; `drinking-window-backfill.ts` 등 **대체 스크립트** 존재 | 플랜의 파일명을 실제로 바꾸거나 “대체: …” 주석 |
| **Epic 4** 등 | 문서상 `feature-schema.ts`, `train_lambdamart.py` 등 | 메인 트리에 **없음** — TS LTR·`scripts/eval/run-eval-and-train-ltr.ts` 등 | 이미 [`GAPS.md`](./GAPS.md) **G-19**; 플랜 Deliverables 표 갱신 권장 |

**재현 (드리프트만 빠르게):**

```bash
# Epic 9 본문 표와 타입 불일치 여부
rg "retrievalMode|resultType|parsedConstraints" src/domain/response/model/search-response.ts

# Epic 6 플랜에 적힌 파일 존재
ls scripts/ltr/finetune_embedding.py scripts/ltr/distill_cross_encoder.py 2>/dev/null

# Epic 15 플랜 경로 vs 실제
ls scripts/etl/collect-drinking-windows.ts 2>/dev/null || echo "플랜 이름 없음"
ls scripts/etl/drinking-window-backfill.ts 2>/dev/null && echo "backfill 있음"
```

---

## 5차 패스 — `docs/plans/*` 파일별 (2026-04-06)

아래는 **플랜 원문의 `- [ ]` / 완료 기준**을 `test -f`, `rg`, `wc -l`로 다시 맞춘 결과다. “빵꾸”가 **구현 부족**인지 **문서만 미갱신**인지 구분한다.

### v0.1

| 문서 | 플랜에 남은 `[ ]` 요지 | 재확인 결과 |
|------|------------------------|-------------|
| `epic-1-etl-pipeline.md` Deliverables | 전 항목 `[ ]` | `vivino-to-silver.ts`·`generate-aliases.ts`·…·`index-to-vespa.ts`·`silver-quality-report.json` **존재** → **문서 체크박스만 미갱신**; 10K/≥8000·품질 수치는 **운영 데이터**로 별도 검증 |
| `epic-2-golden-query-set.md` | silver/gate JSONL, Gate≥50 human 등 `[ ]` | `golden-queries-bronze.jsonl` **500행**·스크립트 존재; 루트 `golden-queries-silver/gate.jsonl` **없음** (`data/splits/*`로 대체) → **일부 진짜 갭** (`G-32`) |
| `epic-3-eval-pipeline.md` | `metrics.ts` 등 | 스크립트 **존재**; sparse/dense 분리·blocker·`verify-splits` 연동 → **BACKLOG** §6·§16·§17 |
| `epic-4-ltr.md` | Python·Vespa GBDT 경로 `[ ]` | TS LTR·`run-eval-and-train-ltr.ts` 등 **다른 구현** → **`G-19`** · §5·§26 |
| `epic-5-cross-encoder.md` | `services/reranker/README.md` | **`services/reranker/README.md` 없음** (`Glob` 0) — **`G-33`** 유지; `main.py`·`Dockerfile`·`compose` reranker **있음** |
| `epic-6-embedding-finetune.md` | py/ts Deliverables `[ ]` | `finetune_embedding.py`·`distill_cross_encoder.py`·`scripts/embedding/finetune-bge-m3.ts` **존재** → 문서 체크박스 갱신 권장; 커밋 `models/*` 없음 → §11 |
| `epic-9-llm-envelope.md` | 작업 `[ ]`·“이미 존재” 표 | **`retrievalMode`·`resultType`·`parsedConstraints`·`matchReasons`·`violatedConstraints`·`abstainReason`는 코드에 있음** — 플랜 **표가 구식**; **`missingInformation`만 미구현** (`G-41`) |
| `epic-7` … `epic-11` | (본문 표 상단 매트릭스와 동일) | §2·§3·§4·§7·§25 등과 정렬 — 변경 없음 |

### v0.2

| 문서 | 플랜 완료 기준 / 키워드 | 코드 대조 |
|------|-------------------------|-----------|
| `epic-12-data-enrichment.md` | critic·cert·pairing | 스크립트·`wine_entity.sd` 필드 **있음**; `mapping.ts`·쿼리 배선 → **§B·§32** |
| `epic-13-query-intelligence.md` | ConstraintSAT, entropy, BK-tree+Soundex | **`constraint-sat` 없음** · planner entropy 없음 · **G-39** — 플랜과 일치하게 **미구현** |
| `epic-14-decomposition-api.md` | `retrieval_mode_source`, `api_override` | **`rg retrieval_mode_source src` → 0건** — 플랜 응답 필드 **미구현** (`TASKS` §I) |
| `epic-15-drinking-window.md` | `collect-drinking-windows.ts`, `scripts/ml/…` | 경로 **없음**; `drinking-window-backfill.ts` 등 **대체** — **G-45** |
| `epic-16-security-batch.md` Completion | injection → **HTTP 400** | 실제 **`POST /v1/search` 200** + 본문 `failed` — 플랜과 **불일치** (`TASKS` §C); batch `fail_fast` abort 시맨틱 → §C |
| `epic-17-agentic-async.md` | watchlist·webhook·도구 체인 `[ ]` | 부분 구현; subscriber·DB·ID → **§34–§35**; `CONFIDENCE_BELOW_THRESHOLD`는 **타입에 존재** (`failure-reason.ts`) |

### 마스터 `00-overview.md`

- Phase 1–3 에픽 표는 위 매트릭스·[`BACKLOG`](./BACKLOG.md)와 동일 주제로 수렴.
- **비목표** 표(RFC 가드레일)는 코드 변경 없이 **문서만** 유지.

### 메타 (문서 vs 구현)

| ID | 한 줄 |
|----|--------|
| **`G-55`** | `docs/plans` **Epic 1·2·6·9** 등 Deliverables가 전부 `- [ ]`인데 스크립트·타입은 이미 있음 — **체크리스트·표 갱신** 필요 (기능 빵꾸와 혼동 주의) |
| **`G-56`** | Epic 14 플랜의 **`retrieval_mode_source` / `api_override`** 메타 — **응답·스키마에 없음** (`rg` 0) |

---

## 유지보수

- 플랜 문서를 고치거나 구현을 맞출 때 **이 파일의 해당 행**을 함께 갱신하면 추적이 쉬움.
- 세부 수정 항목은 [`BACKLOG.md`](./BACKLOG.md) §… · [`GAPS.md`](./GAPS.md) `G-xx`로 쌓는 것을 권장.
- **한 줄 색인:** [`GAPS.md`](./GAPS.md) (`G-01` … — 최신 ID는 해당 파일 헤더/말미 확인).
- **`docs/plans/*` 전수 빠른 스캔:** 아래 블록 + 본 문서 **§5차 패스** 표.

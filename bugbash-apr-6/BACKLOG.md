# Bugbash — apr-6 (apr-5-v0.1 구현 점검 후속)

**작성 기준:** `docs/plans/apr-5-v0.1/*`와 저장소 코드·데이터를 대조한 감사 결과.  
**목적:** 계획 대비 갭·버그·부채를 **근거와 함께** 추적해 다음 스프린트에서 처리한다.  
**최종 갱신:** 2026-04-06

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

## 제안 작업 순서

1. **P0-1** (ENTITY_TARGET_TYPE_MAP) — 수정·재실행 비용 낮고 메트릭 영향 큼.  
2. **P0-2** + **P1-3** + **P1-4** — browse/compare·모드·응답이 한 번에 맞물림.  
3. **P1-5** ~ **P1-7**, **P2-8~11** — 문서/린트/운영 편의. (선택 항목은 별도)

---

## 인덱스

| 파일 | 역할 |
|------|------|
| `BACKLOG.md` (본 문서) | apr-5-v0.1 대비 갭·버그·부채 목록 + 근거 |
| `README.md` | 이 폴더 안내 |

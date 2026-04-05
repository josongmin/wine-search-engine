# Bug bash 작업 목록 (근거 포함)

## 범위

- **기준 플랜**: `docs/plans/apr-5-v0.1/00-overview.md` 및 epic-1 … epic-11, `docs/plans/apr-5-v0.2/00-overview.md` 및 epic-12 … epic-17.
- **검증 시점**: 저장소 정적 분석 + 대표 파일 내용 확인. CI는 `npm run typecheck` / `npm run test` 통과 전제.

---

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

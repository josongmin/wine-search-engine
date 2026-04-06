# Epic 4: Learning to Rank (LambdaMART)

**Phase:** 1 (IR Core)
**RFC:** RFC-017 §4 Epic 4
**의존성:** Epic 1 (features), Epic 2 (labels), Epic 3 (eval)
**블록하는 Epic:** 6 (간접)

---

## 목표

수동 `scoring-weights.ts` → LambdaMART 학습 가중치 대체.
NDCG@10 baseline + 0.05 이상 개선.

---

## 구현 현황 (저장소 기준)

원 계획은 `scripts/ltr/train_lambdamart.py` + Vespa `lightgbm()` second-phase였으나, **실제 구현은 TypeScript 애플리케이션 레이어 LTR**이다. 훈련·추론이 같은 feature 추출(`extractLTRFeatures`)을 공유해 train-serve skew를 줄인다.

| 역할 | 실제 경로 |
|------|-----------|
| Feature 추출 (추론·학습 공용) | [`src/domain/ranking/service/ltr-feature-extractor.ts`](../../../src/domain/ranking/service/ltr-feature-extractor.ts) |
| LambdaMART 점수 / 학습 헬퍼 | [`src/domain/ranking/service/lambdamart-ranker.ts`](../../../src/domain/ranking/service/lambdamart-ranker.ts) |
| 런타임 rerank | [`src/domain/ranking/service/ltr-ranker.ts`](../../../src/domain/ranking/service/ltr-ranker.ts), [`search-usecase-ltr-rerank.ts`](../../../src/application/search/search-usecase-ltr-rerank.ts) |
| Eval → 학습 예제 | [`src/domain/ranking/service/ltr-training-service.ts`](../../../src/domain/ranking/service/ltr-training-service.ts) |
| Training barrel export | [`src/domain/ranking/training.ts`](../../../src/domain/ranking/training.ts) |
| Eval + 학습 오케스트레이션 | [`scripts/eval/run-eval-and-train-ltr.ts`](../../../scripts/eval/run-eval-and-train-ltr.ts) |
| 모델 레지스트리 (PG) | [`src/infrastructure/adapter/pg-ltr-model-registry.ts`](../../../src/infrastructure/adapter/pg-ltr-model-registry.ts), [`container-runtime-support.ts`](../../../src/config/container-runtime-support.ts) |

**서빙 결정:** Vespa native GBDT rank-profile(`ltr_v1`)는 **미적용**. **Option B — 애플리케이션 레이어 스코어링**이 채택된 상태다.

---

## 이미 존재하는 것

| 컴포넌트 | 상태 |
|---|---|
| `src/domain/ranking/service/signal-computer.ts` | ✅ 10-component signal |
| `src/domain/ranking/model/scoring-weights.ts` | ✅ 수동 가중치 (baseline) |
| Vespa match-features | ✅ BM25 per-field + closeness |
| Query-class weight overrides (6 profiles) | ✅ |

## 작업 항목 (설계 참고 — 구현은 TS 경로로 대체됨)

### 4.1 Feature Vector

Feature 정의는 `ltr-feature-extractor.ts` / `lambdamart-ranker.ts`의 `RankingFeatures` 및 학습 파이프라인을 본다. 원문 27차원 스키마 문서(`feature-schema.ts`)는 **작성되지 않음** — 대신 코드가 단일 출처다.

### 4.2 Training Data 수집

- `run-eval-and-train-ltr.ts` + `PgGoldSetStore` / eval 결과가 학습 입력.
- gate holdout은 DB·eval 설정에서 분리 유지 (기존 원칙 동일).

### 4.3 LambdaMART 학습

- Python LightGBM 스크립트 대신 **`trainLambdaMARTModel`** 등 TS 경로 (`lambdamart-ranker.ts`, `ltr-training-service.ts`).
- `models/lambdamart_v1.txt` 대신 **Postgres 레지스트리에 저장되는 모델 blob**을 사용한다.

**Feature Provenance:** eval/학습 파이프라인 확장 시 RFC-015 provenance 블록은 eval 출력 메타에 추가하는 것이 권장된다.

### 4.4 서빙 통합

**채택:** Option B — 애플리케이션 레이어에서 LTR rerank (`search-usecase-ltr-rerank.ts`).

**미구현:** Option A — Vespa `rank-profile` + `lightgbm("…")` second-phase.

---

## Deliverables (실제)

- [x] Feature / 학습 / 추론: `ltr-feature-extractor.ts`, `lambdamart-ranker.ts`, `ltr-ranker.ts`, `ltr-training-service.ts`, `training.ts`
- [x] Eval 연동 학습: `scripts/eval/run-eval-and-train-ltr.ts`
- [x] 모델 저장·로드: `pg-ltr-model-registry.ts`, 컨테이너 LTR 로드
- [ ] Vespa rank-profile `ltr_v1` (Option A) — **의도적으로 미구현**; 앱 레이어 LTR 사용

## 완료 기준

- [ ] NDCG@10 ≥ baseline + 0.05 (gate tier, significance p < 0.05)
- [ ] wrong_top1_rate 악화 없음
- [ ] feature importance 분석 완료 (필요 시 학습 출력에서 도출)
- [ ] Decision Utility 악화 없음

위 수치 기준은 **오프라인 eval 실행**으로 검증한다.

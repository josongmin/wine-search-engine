# Epic 4: Learning to Rank (LambdaMART)

**Phase:** 1 (IR Core)
**RFC:** RFC-017 §4 Epic 4
**의존성:** Epic 1 (features), Epic 2 (labels), Epic 3 (eval)
**블록하는 Epic:** 6 (간접)

---

## 목표

수동 `scoring-weights.ts` → LambdaMART 학습 가중치 대체.
NDCG@10 baseline + 0.05 이상 개선.

## 이미 존재하는 것

| 컴포넌트 | 상태 |
|---|---|
| `src/domain/ranking/service/signal-computer.ts` | ✅ 10-component signal |
| `src/domain/ranking/model/scoring-weights.ts` | ✅ 수동 가중치 (baseline) |
| Vespa match-features | ✅ BM25 per-field + closeness |
| Query-class weight overrides (6 profiles) | ✅ |

## 작업 항목

### 4.1 Feature Vector (27개)

**파일:** `scripts/ltr/feature-schema.ts`

```
Vespa match (8): bm25 × 5 fields + closeness + bm25_producer + bm25_appellation
Signal computer (7): entity_integrity, semantic, soft_constraint, attribute_alignment,
                      popularity, availability, uncertainty_penalty
Wine domain (4): vintage_freshness, drinking_window, critic_score, price_band_match
Query-candidate (4): query_length, exact_phrase_match, vintage_in_query, producer_in_query
Query target (4): target_type_wine/producer/region, scenario_set_retrieval
```

### 4.2 Training Data 수집

**파일:** `scripts/ltr/collect-training-data.ts`

- golden-queries-bronze + silver의 train/val split
- 각 query → hybrid retrieval top-100 candidate
- candidate별 27-feature vector 추출
- grade를 label로 설정
- LETOR format 출력
- **gate holdout은 절대 포함하지 않음**

### 4.3 LambdaMART 학습

**파일:** `scripts/ltr/train_lambdamart.py`

```python
params = {
    'objective': 'lambdarank',
    'metric': 'ndcg',
    'ndcg_eval_at': [5, 10],
    'learning_rate': 0.05,
    'num_leaves': 31,
    'min_data_in_leaf': 20,       # overfitting 방어
    'feature_fraction': 0.8,
    'bagging_fraction': 0.8,
    'lambda_l1': 0.1,
    'lambda_l2': 1.0,
    'n_estimators': 500,
    'early_stopping_rounds': 50,
}
```

- temporal split (random 금지, RFC-017 §6.4)
- same query family cross-split 금지 (epic-2 §2.5 leakage contract)
- **gate holdout은 절대 학습/validation에 포함하지 않음**
- feature importance 분석 필수 → `models/feature_importance_v1.json`
- RFC-010 §2.1: Vivino ratings_average는 popularity signal 초기값으로만. canonical 덮어쓰기 금지.

**Feature Provenance (재현성 필수, RFC-015 연동):**

LETOR 출력 각 query group에 provenance 블록 첨부:
```json
{
  "dataset_version": "golden-v1-bronze",
  "embedding_model_id": "BAAI/bge-m3",
  "embedding_model_digest": "sha256:...",
  "retrieval_index_version": "vespa-wine-entity@2026-04-05",
  "signal_computer_version": "signal-compute-v1",
  "feature_extractor_version": "ltr-feature-v1",
  "feature_extracted_at": "2026-04-07T12:00:00Z"
}
```
2주 후 재현 시 provenance mismatch → 재추출 필요 여부 즉시 판단 가능.

### 4.4 서빙 통합

**Option A (권장):** Vespa native GBDT

```
rank-profile ltr_v1 inherits hybrid {
  second-phase {
    rerank-count: 50
    expression: lightgbm("lambdamart_v1.json")
  }
}
```

**Option B:** Application-layer scoring (유연성 우선 시)

**결정 기준:** latency budget < 50ms → A. 모델 교체 빈도 높으면 → B.

## Deliverables

- [ ] `scripts/ltr/feature-schema.ts`
- [ ] `scripts/ltr/collect-training-data.ts`
- [ ] `scripts/ltr/train_lambdamart.py`
- [ ] `models/lambdamart_v1.txt`
- [ ] `models/feature_importance_v1.json`
- [ ] Vespa rank-profile `ltr_v1` (Option A 시)

## 완료 기준

- [ ] NDCG@10 ≥ baseline + 0.05 (gate tier, significance p < 0.05)
- [ ] wrong_top1_rate 악화 없음
- [ ] feature importance 분석 완료
- [ ] Decision Utility 악화 없음

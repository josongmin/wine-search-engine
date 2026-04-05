# Epic 6: Embedding Fine-tuning & Distillation

**Phase:** 1 (IR Core)
**RFC:** RFC-017 §4 Epic 6
**의존성:** Epic 2 (golden queries), Epic 5 (cross-encoder scores)
**블록하는 Epic:** 없음 (Phase 1 마지막)

---

## 목표

Recall@100 자체를 넓히기.
LTR은 recall 안에서만 reorder. fine-tune은 recall을 넓힌다.

## 근거

LambdaMART (Epic 4)보다 embedding fine-tune이 더 큰 NDCG 점프를 줄 수 있는 이유:
- LTR: Recall@100에 들어온 candidate의 **순서** 최적화
- Fine-tune: Recall@100 **자체**를 확장
- 놓친 candidate는 아무리 좋은 LTR도 살릴 수 없음

## 작업 항목

### 6.1 Contrastive Fine-tuning

**파일:** `scripts/ltr/finetune_embedding.py`

```python
from sentence_transformers import SentenceTransformer, losses

model = SentenceTransformer('BAAI/bge-m3')

# (query, positive_doc_text, hard_negative_doc_text) triplets
# golden queries + hard negatives → ~2000 triplets
train_loss = losses.MultipleNegativesRankingLoss(model)
```

- 500 golden queries + hard negatives → (query, positive, negative) triplets
- In-batch negatives로 학습 효율 극대화
- Fine-tune 후 전체 인덱스 re-embedding 필요 (10K → ~30분 CPU)

### 6.2 Cross-Encoder → Bi-Encoder Distillation

**파일:** `scripts/ltr/distill_cross_encoder.py`

```
1. Golden queries top-100에 cross-encoder score 수집
2. (query, doc, cross_encoder_score) triplet 구성
3. Bi-encoder MSE loss: cos_sim(q_emb, d_emb) → cross_encoder_score
4. 결과: retrieval 단계에서 cross-encoder 수준 품질
```

### 6.3 Re-indexing

- Fine-tuned model로 10K 전체 re-embed
- Vespa 인덱스 갱신 (같은 entity_id로 upsert → 무중단)
- instruction prefix 유지

## Deliverables

- [ ] `scripts/ltr/finetune_embedding.py`
- [ ] `scripts/ltr/distill_cross_encoder.py`
- [ ] `models/bge-m3-wine-ft-v1/` (fine-tuned weights)
- [ ] Re-indexed Vespa (fine-tuned embeddings)

## 완료 기준

- [ ] Recall@100 ≥ baseline + 0.03 (gate tier, significance test)
- [ ] NDCG@10 ≥ baseline (악화 없음)
- [ ] wrong_top1_rate 악화 없음
- [ ] Re-indexing 완료, E2E 정상

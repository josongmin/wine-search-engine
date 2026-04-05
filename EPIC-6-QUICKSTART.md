# Epic 6: Embedding Fine-tuning — Quick Start

**Goal:** Improve Recall@100 from 0.5132 → ≥0.5432 (target: +0.03)

---

## One-Shot Command Sequence

```bash
# 1️⃣ Generate training triplets from golden queries
npx tsx scripts/ltr/generate-triplets.ts

# 2️⃣ Fine-tune BGE-M3 on wine domain (3 epochs, ~20 min)
python scripts/ltr/finetune_embedding.py

# 3️⃣ (Optional) Distill cross-encoder knowledge (~30 min)
python scripts/ltr/distill_cross_encoder.py

# 4️⃣ Start embedding service with new model
# Example: python -m sentence_transformers.server \
#   --model models/bge-m3-wine-ft-v1 \
#   --port 8000 &

# 5️⃣ Re-index Vespa with new embeddings (~30 min)
EMBEDDING_SERVICE_URL=http://localhost:8000 \
npx tsx scripts/ltr/reindex-embeddings.ts

# 6️⃣ Validate embedding improvement
npx tsx scripts/ltr/validate-embedding.ts --sample 100

# 7️⃣ Run full offline evaluation (with automatic validation)
npx tsx scripts/eval/run-offline-eval.ts --tier gate
```

---

## Quick Reference

### Files Created

| File | Purpose | Input | Output |
|------|---------|-------|--------|
| `scripts/ltr/generate-triplets.ts` | Generate training data | `data/golden-queries-bronze.jsonl` | `data/triplets-train.jsonl` |
| `scripts/ltr/finetune_embedding.py` | Fine-tune BGE-M3 | `data/triplets-train.jsonl` | `models/bge-m3-wine-ft-v1/` |
| `scripts/ltr/distill_cross_encoder.py` | Distill cross-encoder (optional) | `models/bge-m3-wine-ft-v1/` | `models/bge-m3-wine-distilled-v1/` |
| `scripts/ltr/reindex-embeddings.ts` | Re-index Vespa | Embedding service + Vespa | Updated index |
| `scripts/ltr/validate-embedding.ts` | Measure improvement | Golden queries + API | Report |
| `scripts/eval/run-offline-eval.ts` | Full eval + validation | (updated) | Results + validation |

### Expected Metrics

**Baseline (current):**
- Recall@100: 0.5132
- NDCG@10: 0.3902

**Target (after Epic 6):**
- Recall@100: ≥0.5432 (+0.03)
- NDCG@10: ≥0.3902 (no regression)

---

## Validation Output Example

```
================================================================================
📊 EMBEDDING VALIDATION RESULTS
================================================================================

📌 Recall@100 (Primary metric — target: ≥ +0.03):
   Baseline: 0.5132 → New: 0.5456 (📈 +0.0324)
   Target: ✅ MET

📌 NDCG@10 (Ranking quality — should not regress):
   Baseline: 0.3902 → New: 0.3968 (📈 +0.0066)
   Regression: ✅ NONE

================================================================================
🎉 VALIDATION PASSED: Embedding improvement meets targets!
================================================================================
```

---

## Environment Variables

```bash
# Required for re-indexing
export EMBEDDING_SERVICE_URL=http://localhost:8000

# Optional (default values shown)
export VESPA_URL=http://localhost:18080
export SEARCH_API_URL=http://localhost:3000
export EVAL_SEARCH_TIMEOUT_MS=60000
export EVAL_SEARCH_CONCURRENCY=12
```

---

## Troubleshooting

**Q: ImportError: No module named 'sentence_transformers'**
```bash
pip install sentence-transformers torch
```

**Q: CUDA out of memory**
```bash
# Use smaller batch size
python scripts/ltr/finetune_embedding.py --batch-size 8
```

**Q: All queries failed (API not running)**
```bash
npm run dev &  # Start search API
npx tsx scripts/ltr/validate-embedding.ts
```

**Q: How do I skip distillation?**
```bash
# Use fine-tuned model directly
EMBEDDING_SERVICE_URL=http://localhost:8000 \
npx tsx scripts/ltr/reindex-embeddings.ts
```

---

## Detailed Documentation

See: `docs/EPIC-6-EMBEDDING-FINETUNING.md`

---

**Status:** ✅ Implementation Complete

**Estimated Total Time:** 2-3 hours (training + re-indexing + validation)

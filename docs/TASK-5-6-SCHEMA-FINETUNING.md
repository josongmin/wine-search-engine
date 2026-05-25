# Task 5 & 6: Schema Structuring & Embedding Fine-tuning

## Overview

Task 5 and Task 6 improve wine entity matching and embedding quality through schema enhancements and fine-tuning data preparation.

**Task 5:** Schema structuring improvements to `wine_entity.sd`  
**Task 6:** Embedding fine-tuning data preparation for BGE-M3

## Task 5: Schema Structuring Improvements (wine_entity.sd)

### Current Contract

이 문서의 초기 초안은 `grape_hierarchy`, `producer_aliases`, `flavor_profile_structured` 같은 실험 스키마를 전제로 썼지만, 현재 운영 계약은 그 대신 retrieval contract와 Vespa mapping SSOT에 맞춘 아래 필드를 사용합니다.

#### 1. Retrieval Summary / Attribute Fields

현재 검색 계약에서 운영하는 구조화 필드는 다음 축입니다.

- `grape_family`
- `region_hierarchy`
- `soil_type`
- `producer_type`
- `price_band_numeric`
- `flavor_profiles`

도메인 계약은 camelCase (`grapeFamily`, `regionHierarchy`, `soilType`, `producerType`)를 쓰고, Vespa field mapping에서 snake_case로 변환합니다.

#### 2. No Heuristic Synthetic Population

- `grape_family` / `region_hierarchy`는 authoritative upstream 값이 있을 때만 기록합니다.
- `soil_type` / `producer_type`도 synthetic default를 만들지 않고, upstream 값이 없으면 omit가 정식 동작입니다.
- 과거 문서에 있던 heuristic synonym expansion이나 first-token fallback은 현재 기준 계약이 아닙니다.

#### 3. Price / Flavor Fields

- `price_band_numeric`는 `value=1`, `mid=2`, `premium=3`, `luxury=4` ordinal encoding입니다.
- flavor 쪽은 `flavor_profile_structured` 단일 문자열이 아니라 `flavor_profiles` 배열 계약을 사용합니다.

### Deployment

After updating `wine_entity.sd`, the schema must be re-deployed to the
self-hosted Vespa cluster via the config-server REST API (the `vespa` CLI
is not used here — its default target on developer machines is Vespa
Cloud, which silently misdirects ops away from the self-hosted cluster):

```bash
# Build the application package zip and POST it to the config server.
cd vespa/app && zip -r /tmp/app.zip . \
  && curl -sS -X POST --data-binary @/tmp/app.zip \
       -H 'Content-Type: application/zip' \
       http://<config-server>:19071/application/v2/tenant/default/prepareandactivate

# Re-index wine documents with new fields
pnpm run ingest  # Or appropriate re-indexing command
```

### Impact

- **Grape Matching:** Queries for "Pinot wines" now match all Pinot family varieties
- **Regional Search:** Hierarchical region queries enable browse-based discovery
- **Producer Clarity:** Standardized producer names reduce entity ambiguity
- **Filtering:** Price band numeric field enables precise range queries

## Task 6: Embedding Fine-tuning Data Preparation

### Overview

Fine-tuning BGE-M3 embeddings on the wine domain improves retrieval quality by adapting the base model to wine-specific semantics.

### Data Pipeline

#### 1. Load Golden Queries & Wine Documents

```bash
pnpm run finetuning:prepare
```

This script:
- Loads 500 golden queries from `data/golden-queries-bronze.jsonl`
- Loads 7040 wine documents from `data/silver-docquery.ndjson`
- Extracts expected entity IDs for ground truth matching

**Result:** 460 valid triplets from ~115 unique queries

#### 2. Create Triplet Dataset

For each golden query:

1. **Positive document:** Wine semantic summary of the correct wine
   - Includes: canonical label, producer, region, wine type, body/acidity/tannin descriptors
   - Example: "2020 Peirson Meyer Cabernet Sauvignon. by Peirson Meyer. from United States / Napa Valley... red wine. characteristics: medium-bodied. price tier: premium"

2. **Hard negatives:** Wines semantically similar but wrong
   - Same country, same wine type, different producer
   - Similar price point
   - 2 hard negatives per query

3. **Easy negatives:** Wines from different countries
   - Random selection for diversity
   - 2 easy negatives per query

**Difficulty Distribution:**
- Hard negatives: 50% (confuse untrained models)
- Easy negatives: 50% (basic contrastive signal)

#### 3. Dataset Split

- **Train:** 322 triplets (70%)
- **Validation:** 68 triplets (15%)
- **Test:** 70 triplets (15%)

Stratified by difficulty to ensure balanced splits.

### Output Files

Generated in `data/fine-tune-dataset/`:

```
train.jsonl      # 322 triplets for training
val.jsonl        # 68 triplets for validation
test.jsonl       # 70 triplets for evaluation
metadata.json    # Dataset statistics
```

### Triplet Format

Each line in JSONL files:

```json
{
  "query": "2020 peirson meyer cabernet sauvignon 20",
  "positiveDoc": "2020 Peirson Meyer Cabernet Sauvignon. by Peirson Meyer. from United States / Napa Valley... red wine. characteristics: medium-bodied. price tier: premium",
  "negativeDoc": "2020 Berthet-Rayne Châteauneuf-du-Pape Rouge...",
  "domain": "wine_semantic",
  "difficulty": "easy"
}
```

### Fine-tuning with Python

Requirements:
```bash
pip install torch transformers sentence-transformers datasets
```

Run fine-tuning:
```bash
python scripts/fine-tune/bge-m3-finetune.py \
  --train-path data/fine-tune-dataset/train.jsonl \
  --val-path data/fine-tune-dataset/val.jsonl \
  --output-dir models/bge-m3-wine-finetuned \
  --batch-size 16 \
  --learning-rate 1e-5 \
  --epochs 3 \
  --triplet-margin 0.3
```

### Configuration

**Fine-tuning Hyperparameters:**
- Learning rate: 1e-5
- Batch size: 16
- Epochs: 3
- Warmup steps: 100 (auto-adjusted based on dataset size)
- Triplet margin: 0.3
- Loss: Triplet loss (InfoNCE)

**Expected Metrics (after fine-tuning):**
- MRR@10: ~0.80-0.85 (mean reciprocal rank)
- NDCG@10: ~0.80-0.85 (normalized discounted cumulative gain)
- Recall@50: ~0.95+ (recall at top 50)

### Output

Fine-tuning produces:
- Tuned model weights: `models/bge-m3-wine-finetuned/`
- Training metadata: `models/bge-m3-wine-finetuned/training_metadata.json`

### Deployment

After fine-tuning:

1. **Update Embedding Service Configuration**

   In `src/config/env.ts`:
   ```typescript
   embedding: {
     url: process.env.EMBEDDING_SERVICE_URL,
     model: "bge-m3-wine-finetuned",  // Use fine-tuned model
   }
   ```

2. **Deploy Fine-tuned Model**

   Point the embedding service to the fine-tuned model directory or upload to model registry.

3. **Re-index Wine Embeddings**

   ```bash
   pnpm run ingest  # Generate new embeddings with fine-tuned model
   ```

### Next Steps

1. Run data preparation: `pnpm run finetuning:prepare`
2. Verify generated JSONL files in `data/fine-tune-dataset/`
3. Install Python dependencies and run fine-tuning script
4. Deploy fine-tuned model to embedding service
5. Re-index 7040 wines with new embeddings
6. Evaluate retrieval quality using Task 2 evaluation metrics

### Files Modified

- `vespa/app/schemas/wine_entity.sd` — Added new fields and synonyms
- `package.json` — Added `finetuning:prepare` script
- `scripts/fine-tune/prepare-finetuning-data.ts` — Data preparation logic
- `scripts/fine-tune/bge-m3-finetune.py` — Fine-tuning script

### Related RFCs

- RFC-017: Query Decomposition & Retrieval Modes
- RFC-018: Embedding Architecture & HNSW Indexing
- RFC-020: Data Enrichment Strategy

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Wine Search Pipeline                     │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Task 5: Schema Improvements                                │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ wine_entity.sd                                       │  │
│  │ - Grape hierarchy (Pinot family)                     │  │
│  │ - Region hierarchy (France regions)                  │  │
│  │ - Producer aliases (Château/Domaine)                │  │
│  │ - Price band numeric field                          │  │
│  │ - Flavor profile structured field                   │  │
│  └──────────────────────────────────────────────────────┘  │
│           ↓                                                   │
│  Task 6: Fine-tuning Data                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Golden Queries (500)                                │  │
│  │      ↓                                               │  │
│  │ Wine Documents (7040)                               │  │
│  │      ↓                                               │  │
│  │ Create Triplets (460)                               │  │
│  │ - Query text                                        │  │
│  │ - Positive wine semantic summary                    │  │
│  │ - Hard/easy negative wines                          │  │
│  │      ↓                                               │  │
│  │ Split Dataset (Train/Val/Test)                      │  │
│  │      ↓                                               │  │
│  │ Fine-tune BGE-M3 (Python)                           │  │
│  │      ↓                                               │  │
│  │ Deploy Fine-tuned Model                             │  │
│  │      ↓                                               │  │
│  │ Re-index 7040 Wines                                 │  │
│  └──────────────────────────────────────────────────────┘  │
│           ↓                                                   │
│  Improved Retrieval Quality                                 │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Hybrid Search with Fine-tuned Embeddings            │  │
│  │ - Better semantic understanding of wine queries     │  │
│  │ - More accurate hard negative distinction           │  │
│  │ - Improved recall and ranking                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

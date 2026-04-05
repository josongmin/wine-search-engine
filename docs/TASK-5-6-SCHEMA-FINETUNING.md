# Task 5 & 6: Schema Structuring & Embedding Fine-tuning

## Overview

Task 5 and Task 6 improve wine entity matching and embedding quality through schema enhancements and fine-tuning data preparation.

**Task 5:** Schema structuring improvements to `wine_entity.sd`  
**Task 6:** Embedding fine-tuning data preparation for BGE-M3

## Task 5: Schema Structuring Improvements (wine_entity.sd)

### Changes

#### 1. Grape Variety Hierarchy

Added fields for hierarchical grape matching to enable queries like "Pinot" to match Pinot Noir, Pinot Grigio, Pinot Blanc:

```sd
field grape_family type string {
  indexing: summary | attribute | index
  index: enable-bm25
}

field grape_hierarchy type array<string> {
  indexing: summary | attribute | index
  index: enable-bm25
}
```

**Synonyms defined in `search {}` block:**
- pinot-family: "pinot noir", "pinot grigio", "pinot gris", "pinot blanc", "pinot"
- cabernet-family: "cabernet sauvignon", "cabernet franc", "cabernet"
- merlot-family, tempranillo-family, etc.

#### 2. Region Hierarchical Matching

Added fields and synonyms for regional matching:

```sd
field region_hierarchy type array<string> {
  indexing: summary | attribute | index
  index: enable-bm25
}
```

**Region synonyms:**
- france-regions: Bordeaux, Burgundy, Loire Valley, Alsace, Rhone, Provence, Champagne
- italy-regions: Tuscany, Piedmont, Veneto, Umbria, Sicily
- spain-regions: Rioja, Ribera del Duero, Priorat, Penedes
- usa-regions: Napa Valley, Sonoma, Paso Robles, Santa Barbara

#### 3. Producer Synonyms

Added standardized producer name mappings:

```sd
field producer_aliases type array<string> {
  indexing: summary | attribute | index
  index: enable-bm25
}
```

**Producer honorific synonyms:**
- Château = Domaine = Bodega = Cantina = Azienda = Estate

#### 4. Explicit Price Band & Flavor Profile Fields

Added numeric and structured fields for better filtering and matching:

```sd
# Price band numeric field for range queries
field price_band_numeric type int {
  indexing: summary | attribute
}

# Flavor profile categories — structured format
field flavor_profile_structured type string {
  indexing: summary | attribute
}
```

### Deployment

After updating `wine_entity.sd`, Vespa must be re-deployed:

```bash
# Deploy to Vespa
vespa deploy vespa/app

# Re-index wine documents with new fields
npm run ingest  # Or appropriate re-indexing command
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
npm run finetuning:prepare
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
   npm run ingest  # Generate new embeddings with fine-tuned model
   ```

### Next Steps

1. Run data preparation: `npm run finetuning:prepare`
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

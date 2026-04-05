# Task 7: Learning-to-Rank (LTR) 準備 — Complete Analysis & Roadmap

**Date**: 2026-04-06  
**Goal**: LambdaMART 모델 학습으로 NDCG@10 개선  
**Status**: Infrastructure Ready, Implementation Plan Complete

---

## Current State Analysis

### Data & Infrastructure Available

#### 1. Golden Query Dataset
- **Location**: `data/golden-queries-bronze.jsonl` (500 queries)
- **Size**: 364,889 bytes (~500 queries)
- **Format**: JSONL with comprehensive labels
- **Structure**:
  ```json
  {
    "qid": "q-a-0000",
    "query": "2013 Villa Poggio Salvi Brunello di Montalcino",
    "query_class": "exact_entity",
    "scenario": "A-H",
    "language": "en/ko/mixed",
    "retrieval_labels": {
      "relevant": [
        { "entity_id": "vivino-...", "grade": 0-3 }
      ]
    },
    "decision_labels": { ... },
    "retrieval_mode": "entity_lookup/entity_resolution/attribute_search/..."
  }
  ```

#### 2. Evaluation Infrastructure
- **Evaluation Metrics**: RFC-017 compliant (NDCG, MRR, Recall, Decision Utility, AURC, ECE)
- **Eval Results**: `data/eval-results.json` (baseline metrics established)
- **Test Splits**: `data/splits/` (test-bronze-0.jsonl, etc.)
- **Scripts Location**: `scripts/eval/`
  - `run-offline-eval.ts` — Compute metrics on golden queries
  - `metrics.ts` — 17 metrics implementations
  - `run-eval-and-train-ltr.ts` — Main LTR orchestrator (exists but incomplete)

#### 3. LTR Infrastructure (Already in Place)
- **Files Prepared**:
  - `src/domain/ranking/service/lambdamart-ranker.ts` — LambdaMART training (8-feature model)
  - `src/domain/ranking/service/ltr-training-service.ts` — Example building, model registry
  - `src/domain/ranking/service/ltr-ranker.ts` — Production reranker
  - `src/infrastructure/vespa/reranker.ts` — Vespa integration
  - `scripts/ltr/` — Python scripts for cross-encoder distillation

#### 4. Database Schema
- **Tables Ready**:
  - `eval_cases` (case_id, query_class, expected_entity_id, label_tier)
  - `eval_results` (result_id, case_id, decision_confidence, utility_score, etc.)
  - LTR model registry tables (schema defined but not yet populated)

### Current Limitations

1. **Feature Extraction**: Currently synthetic (random noise added)
   - `ltr-training-service.ts` line 15-40: Mock features
   - Needs: Real BM25, embedding similarity, popularity, attribute matching

2. **Training Data**: Only pairwise examples, no per-document ranking context
   - Current: Creates 3 synthetic pairwise comparisons per case
   - Needs: Top-20 retrieved wines per query with actual retrieval scores

3. **No Evaluation Pipeline Integration**:
   - `run-eval-and-train-ltr.ts` loads eval cases but doesn't fetch actual search results
   - Needs: Integration with search pipeline to capture real retrieval scores

4. **Missing Components**:
   - Feature engineering layer (extract real scores from search pipeline)
   - Ranking context builder (top-20 for each query)
   - Cross-validation harness
   - Feature importance analysis
   - Model serialization for production

---

## Implementation Roadmap (Parallel Execution)

### Phase 1: Data Preparation (Days 1-2)

#### 1.1 Build Ranking Context Dataset
**File**: `scripts/ltr/build-ranking-context.ts` (NEW)

Generate for each golden query:
- Query ID, query text, query class
- Top-20 retrieved wines (entity_id, retrieval_score, rank)
- Ground truth labels (0/1 or 0-3 grade)
- Retrieval mode (entity_lookup, attribute_search, etc.)

**Input**: `data/golden-queries-bronze.jsonl` + search results from `eval-results.json`  
**Output**: `data/ltr-training-context.jsonl`

```typescript
interface RankingContext {
  qid: string;
  query: string;
  queryClass: string;
  retrievalMode: RetrievalMode;
  topResults: Array<{
    entityId: string;
    rank: number;
    retrievalScore: number; // BM25 + semantic
    label: 0 | 1 | 2 | 3;  // relevance grade
  }>;
}
```

#### 1.2 Feature Engineering Pipeline
**File**: `scripts/ltr/extract-features.ts` (NEW)

For each (query, result) pair, extract:

1. **Retrieval Scores** (from search pipeline)
   - bm25Score: Full-text BM25 from Vespa
   - semanticScore: Dense embedding similarity
   - Combined retrieval score

2. **Popularity Features**
   - popularityScore: (reviews + view count) / max normalized
   - recencyScore: exp(-days_since_release / 365)

3. **Query-Entity Matching**
   - classMatchScore: Query class == entity type matching
   - attributeMatchScore: Query attribute overlap (vintage, region, price, etc.)
   - varietyMatchScore: Grape variety mention in query

4. **Diversity & Multilingual**
   - diversityScore: Distance from top results
   - multilingualScore: Language alignment (en/ko)
   - priceAlignmentScore: Query price range overlap

**Input**: `data/ltr-training-context.jsonl` + Wine entities + Search results  
**Output**: `data/ltr-training-features.jsonl`

```typescript
interface FeatureVector {
  qid: string;
  entityId: string;
  rank: number;
  label: 0 | 1 | 2 | 3;
  features: RankingFeatures; // 12-16 features
  groupId: string; // for LambdaMART
}
```

#### 1.3 Pairwise Example Generation
**File**: `scripts/ltr/generate-pairwise-examples.ts` (NEW)

From ranking contexts, generate pairwise examples for LambdaMART:

For each query with 2+ results:
- Pair every doc with a higher label with every doc with lower label
- Generate ~5K-10K pairwise examples total

```typescript
interface LambdaMARTExample {
  query: string;
  queryClass: string;
  label1: 0 | 1 | 2 | 3;
  features1: RankingFeatures;
  label2: 0 | 1 | 2 | 3;
  features2: RankingFeatures;
}
```

**Input**: `data/ltr-training-features.jsonl`  
**Output**: `data/ltr-pairwise-examples.jsonl`

### Phase 2: Feature Engineering (Days 2-3) — PARALLEL

#### 2.1 Real Feature Extraction
**Files to Modify**:
- `src/domain/ranking/service/ltr-training-service.ts` — Replace synthetic features
- `src/infrastructure/adapter/search-result-featurizer.ts` (NEW)

Add adapters for:
- Vespa search result → BM25 + semantic scores
- Entity → popularity features
- Wine entity → attribute matching
- Query → attribute matching

#### 2.2 Feature Importance Analysis
**File**: `scripts/ltr/analyze-features.ts` (NEW)

After training, compute:
- Per-feature contribution to ranking
- Correlation with relevance labels
- Feature statistics (mean, std, range)

**Output**: `data/ltr-feature-importance.json`

```json
{
  "features": [
    {
      "name": "bm25Score",
      "weight": 0.25,
      "importance": 0.35,
      "correlation_with_relevance": 0.68,
      "mean": 0.54,
      "std": 0.21
    }
  ],
  "top_5_features": ["bm25Score", "semanticScore", ...]
}
```

### Phase 3: LTR Model Training (Days 3-4) — CORE

#### 3.1 Enhanced LambdaMART Trainer
**File**: `src/domain/ranking/service/lambdamart-enhanced.ts` (NEW)

Improvements over current `lambdamart-ranker.ts`:

1. **Proper LambdaMART Loss**:
   - Compute NDCG@K gradient for each pair
   - Use log(1 + exp(...)) stable sigmoid
   - Per-group normalization

2. **Cross-Validation**:
   - 5-fold CV on query classes
   - Validation NDCG@10 (not @5)
   - Early stopping by validation metric

3. **Feature Weighting**:
   - Learn per-feature weights (already done)
   - Also learn per-query-class weights
   - Support feature subset selection

4. **Model Serialization**:
   - Save to JSON with metadata
   - Load with type safety
   - Version tracking

```typescript
interface LTRModel {
  modelId: string;
  version: string;
  trainedAt: Date;
  models: Map<string, QueryClassWeights>;
  metadata: {
    trainingExamples: number;
    cvFolds: 5;
    validationNdcg10: number;
    trainingTime: number;
    featureImportance: Record<string, number>;
  };
}
```

#### 3.2 Training Script
**File**: `scripts/ltr/train-lambdamart.ts` (NEW)

```bash
npm run ltr:train -- --input data/ltr-pairwise-examples.jsonl \
  --output data/models/lambdamart-v1.json \
  --cv-folds 5 \
  --test-split 0.2
```

Outputs:
- `data/models/lambdamart-v1.json` — Trained model
- `data/ltr-training-report.json` — CV results, feature importance
- `data/ltr-validation-predictions.jsonl` — Test set scores

### Phase 4: Integration & Evaluation (Days 4-5)

#### 4.1 Production Reranker Integration
**File**: `src/domain/ranking/service/ltr-reranker.ts` (ENHANCE)

Modify `search.usecase.ts`:
```typescript
// In final response building:
const topResults = await vespaSearch(...); // top 100
if (ltrModel.available) {
  const reranked = LTRReranker.rerank(topResults, queryClass, ltrModel);
  return reranked.slice(0, 20); // return top 20
}
```

#### 4.2 Evaluation on Test Set
**File**: `scripts/ltr/eval-with-ltr.ts` (NEW)

Compare:
- Baseline (no reranking)
- LTR reranking
- Per-scenario breakdown

**Metrics**:
- NDCG@10, NDCG@20
- MRR@10
- Recall@10, Recall@20
- Reranking shift (how much positions changed)

**Output**: `data/ltr-eval-results.json`

```json
{
  "baseline": { "ndcg_at_10": 0.42, ... },
  "with_ltr": { "ndcg_at_10": 0.58, ... },
  "improvement": {
    "ndcg_at_10_delta": 0.16,
    "mrr_at_10_delta": 0.12,
    "queries_improved": 0.67,
    "queries_regressed": 0.08
  }
}
```

#### 4.3 Feature Impact Ablation
**File**: `scripts/ltr/ablation-study.ts` (NEW)

Train models with subsets of features:
- Without BM25 → NDCG@10 delta
- Without semantic → NDCG@10 delta
- Without popularity → NDCG@10 delta
- etc.

**Output**: `data/ltr-ablation-study.json`

---

## Detailed File Structure

### New TypeScript Files to Create

```
scripts/ltr/
├── build-ranking-context.ts      # Phase 1.1 - Generate top-20 per query
├── extract-features.ts           # Phase 1.2 - Feature engineering
├── generate-pairwise-examples.ts # Phase 1.3 - Training pair generation
├── analyze-features.ts           # Phase 2.2 - Feature importance
├── train-lambdamart.ts           # Phase 3.2 - Main training loop
├── eval-with-ltr.ts              # Phase 4.2 - Evaluation
└── ablation-study.ts             # Phase 4.3 - Feature ablation

src/domain/ranking/
├── service/lambdamart-enhanced.ts # Enhanced LambdaMART trainer
├── service/ltr-reranker.ts        # Production reranker
└── model/ranking-features.ts      # Feature definitions (const FEATURE_NAMES, etc.)

src/infrastructure/
└── adapter/
    └── search-result-featurizer.ts # Vespa → Features converter
```

### Files to Modify

```
scripts/eval/
├── run-eval-and-train-ltr.ts      # Integrate new pipeline
└── run-offline-eval.ts            # Add LTR eval mode

src/application/search/
└── search.usecase.ts              # Add LTR reranking step

src/config/
└── container.ts                   # Register LTR services

src/domain/ranking/
└── index.ts                       # Export new services
```

### Data Files Generated

```
data/
├── ltr-training-context.jsonl    # Phase 1.1 output (top-20 per query)
├── ltr-training-features.jsonl   # Phase 1.2 output (with features)
├── ltr-pairwise-examples.jsonl   # Phase 1.3 output (training data)
├── models/
│   └── lambdamart-v1.json        # Phase 3.2 output (trained model)
├── ltr-feature-importance.json   # Phase 2.2 output (feature analysis)
├── ltr-training-report.json      # Phase 3.2 output (training metrics)
├── ltr-validation-predictions.jsonl # Phase 3.2 output (test preds)
├── ltr-eval-results.json         # Phase 4.2 output (eval metrics)
└── ltr-ablation-study.json       # Phase 4.3 output (ablation results)
```

---

## Technical Implementation Details

### Feature Vector Specification

**Total Features: 12-16**

```typescript
interface RankingFeatures {
  // Retrieval scores (2)
  bm25Score: number;                    // [0, 1] normalized
  semanticScore: number;                 // [0, 1] cosine similarity

  // Popularity (2)
  popularityScore: number;               // review count + views
  recencyScore: number;                  // exp(-years since release)

  // Query-entity matching (3)
  classMatchScore: number;               // entity type == query class
  attributeMatchScore: number;           // attribute overlap % 
  varietyMatchScore: number;             // grape mention

  // Diversity (2)
  diversityScore: number;                // [0, 1] from top-k results
  multilingualScore: number;             // language alignment

  // Advanced (optional)
  priceAlignmentScore?: number;          // query price range match
  regionAlignmentScore?: number;         // query region specificity
  vintageRangeCoverage?: number;         // vintage diversity
}
```

### LambdaMART Training Algorithm

```
Input: Pairwise examples {(d_i1, d_i2, label_delta)}
Output: Weight vector w, bias b

Initialize:
  w = [1/k, 1/k, ..., 1/k] for k features
  b = 0.5
  
For iteration t = 1 to T:
  1. Shuffle examples
  2. For batch of pairs:
     - score_1 = dot(w, features_1) + b
     - score_2 = dot(w, features_2) + b
     - label_delta = label_1 - label_2
     - lambda = label_delta / (1 + exp(score_1 - score_2))
     
  3. Accumulate gradients:
     - dw = sum_pairs lambda * (features_1 - features_2)
     - db = sum_pairs lambda
     
  4. Update weights (with L2 regularization):
     - w_new = w_old + lr * dw - lambda_reg * w_old
     - b_new = b_old + lr * db
     
  5. Clip to [-1, 1] range
  
6. Compute validation NDCG@10 on held-out queries
7. Early stopping if no improvement for 10 iterations

Return: (w, b, validation_ndcg)
```

### Cross-Validation Strategy

```
Data Split:
  - 500 golden queries (all query classes mixed)
  - 5-fold CV: 400 train, 100 validation per fold
  
Per fold:
  1. Build pairwise examples from 400 train queries
  2. Train LambdaMART model
  3. Evaluate on 100 validation queries (compute NDCG@10)
  
Final metrics:
  - Mean NDCG@10 across 5 folds
  - Std dev
  - Per-query-class breakdown
```

### Feature Importance Ranking

After training, compute:

```typescript
// For each feature f:
for (let f = 0; f < 8; f++) {
  // Importance = how much NDCG changes if we zero out w[f]
  const weights_with_zero = [...weights];
  weights_with_zero[f] = 0;
  
  const ndcg_with_zero = computeValidationNdcg(examples, weights_with_zero);
  const importance = baseline_ndcg - ndcg_with_zero;
  
  // Normalized importance
  const normalized = importance / sum_of_all_importances;
}
```

---

## Expected Outcomes & Success Criteria

### Phase 1 Outputs (Data Preparation)
- ✓ `ltr-training-context.jsonl`: 500 queries × 20 results each = 10K docs
- ✓ `ltr-training-features.jsonl`: 10K feature vectors
- ✓ `ltr-pairwise-examples.jsonl`: ~5K-10K pairwise training examples

### Phase 2 Outputs (Feature Engineering)
- ✓ Real BM25 + semantic scores (not synthetic)
- ✓ Feature importance report showing top features
- ✓ Feature statistics (mean, std, correlation with labels)

### Phase 3 Outputs (Training)
- ✓ Trained LambdaMART model (serialized JSON)
- ✓ 5-fold CV results: Mean NDCG@10 ≥ 0.55 (target)
- ✓ Per-query-class model weights
- ✓ Training report with convergence plots

### Phase 4 Outputs (Integration & Eval)
- ✓ LTR-enabled search pipeline
- ✓ Eval comparison: baseline vs. with LTR
- ✓ **Success Target**: NDCG@10 improvement of 15-20%
- ✓ Ablation study showing feature contributions

---

## Timeline & Parallelization

### Week 1: Data & Feature Engineering
- **Mon**: Phase 1.1-1.3 (build training data, features, examples)
- **Tue**: Phase 2.1-2.2 (real feature extraction, importance analysis)
- **Parallel**: Start Phase 3.1 (enhanced trainer implementation)

### Week 2: Training & Integration
- **Wed**: Phase 3.2 (training script + model serialization)
- **Thu**: Phase 4.1-4.2 (integrate reranker, eval on test set)
- **Fri**: Phase 4.3 (ablation study, final report)

### Dependencies
- Phase 1 → Phase 3 (training data)
- Phase 2 → Phase 3 (feature importance)
- Phase 3 → Phase 4 (trained model)

---

## Risk Mitigation

### Risk: Poor Feature Quality
**Mitigation**: Feature importance analysis (Phase 2.2) will identify weak features early  
**Fallback**: Switch to simpler features (BM25 + semantic only)

### Risk: Overfitting in Training
**Mitigation**: 5-fold cross-validation with early stopping  
**Fallback**: Increase L2 regularization (lambda_reg > 0.01)

### Risk: LTR Doesn't Improve Metrics
**Mitigation**: Ablation study to identify which features help  
**Fallback**: Combine with other ranking strategies (ensemble)

### Risk: Reranking Changes Too Many Results
**Mitigation**: Monitor "reranking shift" metric  
**Fallback**: Blend retrieval + LTR scores (alpha=0.3 favors retrieval)

---

## Post-Launch Roadmap (Future)

### Long-Term Improvements
1. **User Feedback Loop**: Collect click/conversion signals
2. **Online Learning**: Periodic retraining with new feedback
3. **Multi-Objective**: Optimize for both NDCG and diversity
4. **Query-Specific Calibration**: Different weights per query pattern
5. **Integration with Vespa RankProfile**: Native LTR scoring in Vespa

### Monitoring
- Track NDCG@10, MRR@10 in production
- A/B test LTR vs. baseline
- Monitor feature distributions (data drift detection)
- Rerank latency impact (~10ms per query)

---

## References & Standards

- **RFC-009**: SOTA++ learning-to-rank design
- **RFC-017**: Evaluation framework § 3.2
- **LambdaMART**: Burges et al. (2010) "Learning to rank using gradient boosting"
- **NDCG**: Järvelin & Kekäläinen (2002)
- **5-Fold CV**: Standard ML best practice

---

## Checklist for Implementation

- [ ] Phase 1.1: Build ranking context (top-20 per query)
- [ ] Phase 1.2: Feature engineering (real scores)
- [ ] Phase 1.3: Pairwise example generation
- [ ] Phase 2.1: Real feature extraction adapters
- [ ] Phase 2.2: Feature importance analysis
- [ ] Phase 3.1: Enhanced LambdaMART trainer
- [ ] Phase 3.2: Training script & model serialization
- [ ] Phase 4.1: Reranker integration
- [ ] Phase 4.2: Evaluation on test set
- [ ] Phase 4.3: Ablation study
- [ ] Code review & TypeScript strict mode
- [ ] Integration tests
- [ ] Documentation & deployment guide

---

**Next Steps**: Start Phase 1 parallel tasks (data preparation + feature extraction)

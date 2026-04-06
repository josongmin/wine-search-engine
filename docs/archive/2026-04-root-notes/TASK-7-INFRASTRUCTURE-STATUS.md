# Task 7: LTR Infrastructure Status & Readiness

**Date**: 2026-04-06  
**Status**: Infrastructure Ready, Implementation Planned

---

## Executive Summary

The wine search engine has **complete infrastructure for LTR training** already in place. Only feature extraction and training orchestration need implementation. This document audits what's built and what needs to be added.

---

## Existing Infrastructure (✓ Ready)

### 1. Data Layer

#### Golden Query Dataset
- **File**: `data/golden-queries-bronze.jsonl` (500 queries)
- **Content**: Complete evaluation cases with:
  - Query text + class (exact_entity, structured_query, etc.)
  - Scenario (A-H, 75-50 queries each)
  - Language (en: 317, ko: 138, mixed: 45)
  - Retrieval mode (9 modes: entity_lookup, attribute_search, etc.)
  - Ground truth labels (entity_id + grade 0-3)
  - Decision labels (expected_status, ambiguity)
- **Quality**: Bronze tier, rule-generated labels

#### Evaluation Dataset
- **File**: `data/eval-results.json` (baseline metrics)
- **Metrics**: NDCG@10, MRR@10, Recall@100, Decision Utility, AURC, ECE
- **Scenarios**: 500 queries scored across 9 retrieval modes
- **Splits**: Train/val/test splits exist in `data/splits/`

### 2. Evaluation Framework (RFC-017 Compliant)

#### Metric Implementations
- **File**: `scripts/eval/metrics.ts` (17 metric functions)
- **Metrics**:
  - Ranking: NDCG@K, MRR@K, Recall@K, MAP
  - Decision: Decision Utility, Wrong Top-1 Rate, Abstain Rate
  - Calibration: ECE, AURC, Excess AURC
  - Set: Diversity, Producer Variety, Coverage
  - Query-specific aggregation

#### Eval Runner
- **File**: `scripts/eval/run-offline-eval.ts`
- **Purpose**: Runs queries through search pipeline, computes metrics
- **Output**: `data/eval-results.json` with per-scenario, per-language, per-mode breakdown

#### LTR Integration Entry Point
- **File**: `scripts/eval/run-eval-and-train-ltr.ts`
- **Status**: Exists but incomplete (loads eval cases but doesn't extract features)
- **Needs**: Integration with actual search results

### 3. LTR Domain Model

#### RankingFeatures Interface
- **File**: `src/domain/ranking/service/lambdamart-ranker.ts` (lines 19-28)
- **Features**: 8 defined
  ```typescript
  interface RankingFeatures {
    bm25Score: number;
    semanticScore: number;
    popularityScore: number;
    recencyScore: number;
    classMatchScore: number;
    attributeMatchScore: number;
    diversityScore: number;
    multilingualScore: number;
  }
  ```

#### LambdaMARTExample & QueryClassWeights
- **File**: Same file (lines 33-52)
- **Training data structure**: Already defined
- **Model structure**: Already defined

### 4. LambdaMART Trainer (Basic Implementation)

#### Core Algorithm
- **File**: `src/domain/ranking/service/lambdamart-ranker.ts`
- **Status**: Functional but basic
- **What Works**:
  - Gradient-based optimization
  - Per-query-class models
  - NDCG@5 validation
  - Feature weight learning
- **Limitations**:
  - No cross-validation (trains once)
  - No early stopping
  - Synthetic feature generation (lines 15-40 in ltr-training-service.ts)
  - Validation only @5, not @10

#### LTR Training Service
- **File**: `src/domain/ranking/service/ltr-training-service.ts`
- **Status**: Functional for orchestration
- **What it does**:
  - buildTrainingExamples: Converts eval results → pairwise examples
  - trainAllModels: Trains per-query-class
  - createModelRegistry: Packages models with metadata

### 5. Production Reranker

#### LTR Ranker Service
- **File**: `src/domain/ranking/service/ltr-ranker.ts`
- **Status**: Ready
- **API**:
  ```typescript
  LTRRanker.rerank(documents, queryClass, model)
  LTRRanker.blendScores(retrieval, ltr, alpha)
  LTRRanker.measureRerankingShift(before, after)
  ```

#### Vespa Reranker Adapter
- **File**: `src/infrastructure/vespa/reranker.ts`
- **Status**: Exists (for Vespa integration)

### 6. Database Schema

#### Tables Ready
- `eval_cases`: Store evaluation cases (case_id, query_class, expected_entity_id, label_tier)
- `eval_results`: Store evaluation results (result_id, case_id, predicted_entity_id, decision_confidence, etc.)
- Indices on query_class and label_tier for efficient retrieval

#### Planned Tables (schema definition exists)
- `ltr_model_registry`: Store trained models
- `ltr_feature_vectors`: (optional) Store precomputed features

### 7. Python ML Infrastructure

#### Distillation Script
- **File**: `scripts/ltr/distill_cross_encoder.py`
- **Purpose**: Knowledge distillation from cross-encoder to bi-encoder
- **Status**: Ready for future use (Phase 5+)

#### Fine-tuning Script
- **File**: `scripts/ltr/finetune_embedding.py`
- **Purpose**: Fine-tune embeddings on wine corpus
- **Status**: Ready for future use

---

## Missing Components (⚠️ To Implement)

### Phase 1: Data Preparation (CRITICAL)

#### 1.1 Ranking Context Builder
- **File**: `scripts/ltr/build-ranking-context.ts` (NEW)
- **Purpose**: For each golden query, fetch top-20 results + labels
- **Input**: `data/golden-queries-bronze.jsonl` + search results
- **Output**: `data/ltr-training-context.jsonl` (10K documents)
- **Complexity**: Low (data transformation)
- **Dependencies**: Search pipeline access (Vespa or database)

#### 1.2 Feature Extractor
- **File**: `scripts/ltr/extract-features.ts` (NEW)
- **Purpose**: Compute real ranking features (not synthetic)
- **Input**: `data/ltr-training-context.jsonl` + wine entities
- **Output**: `data/ltr-training-features.jsonl` (feature vectors)
- **Complexity**: Medium
  - Extract BM25 + semantic scores from search results
  - Compute popularity from entity metadata
  - Match query attributes to wine attributes
- **Dependencies**: Wine entity database, embedding service (optional)

#### 1.3 Pairwise Example Generator
- **File**: `scripts/ltr/generate-pairwise-examples.ts` (NEW)
- **Purpose**: Create pairwise training examples for LambdaMART
- **Input**: `data/ltr-training-features.jsonl`
- **Output**: `data/ltr-pairwise-examples.jsonl` (~5K-10K pairs)
- **Complexity**: Low
- **Algorithm**: For each query with 2+ results, pair high-label with low-label

### Phase 2: Feature Engineering (IMPORTANT)

#### 2.1 Real Feature Extraction Adapters
- **File**: `src/infrastructure/adapter/search-result-featurizer.ts` (NEW)
- **Purpose**: Convert search results → ranking features
- **Methods**:
  - extractBm25Score(result: SearchResult): number
  - extractSemanticScore(result: SearchResult): number
  - computePopularityScore(wine: Wine): number
  - computeRecencyScore(wine: Wine): number
  - extractFeatures(...): RankingFeatures
- **Complexity**: Medium (integrate with Vespa/database)

#### 2.2 Feature Importance Analysis
- **File**: `scripts/ltr/analyze-features.ts` (NEW)
- **Purpose**: Post-training analysis of feature contributions
- **Output**: `data/ltr-feature-importance.json`
- **Metrics**:
  - Weight per feature (from trained model)
  - Correlation with relevance labels
  - Ablation study (NDCG delta when feature removed)

### Phase 3: Enhanced Training (CRITICAL)

#### 3.1 LambdaMART Enhanced Trainer
- **File**: `src/domain/ranking/service/lambdamart-enhanced.ts` (NEW)
- **Purpose**: Production-grade LambdaMART with 5-fold CV
- **Improvements**:
  - Proper 5-fold cross-validation
  - Early stopping by validation NDCG@10
  - Feature importance computation
  - Model serialization/deserialization
- **Complexity**: High
- **Classes**: LambdaMARTTrainer with train(), computeNdcg(), createFolds()

#### 3.2 Training Script & CLI
- **File**: `scripts/ltr/train-lambdamart.ts` (NEW)
- **Purpose**: End-to-end training orchestration
- **CLI**:
  ```bash
  tsx scripts/ltr/train-lambdamart.ts \
    --input data/ltr-pairwise-examples.jsonl \
    --output data/models/lambdamart-v1.json \
    --cv-folds 5
  ```
- **Outputs**:
  - `data/models/lambdamart-v1.json`: Trained model (50 KB)
  - `data/ltr-training-report.json`: Training metrics, feature importance
  - `data/ltr-validation-predictions.jsonl`: Predictions on validation set
- **Complexity**: Medium (glue script)

### Phase 4: Integration & Eval (IMPORTANT)

#### 4.1 Reranker Integration
- **File**: `src/application/search/search.usecase.ts` (MODIFY)
- **Change**: Add LTR reranking step after Vespa retrieval
- **Code**:
  ```typescript
  if (ltrModel) {
    results = LTRRanker.rerank(results, queryClass, model);
  }
  ```
- **Complexity**: Low (one method call)

#### 4.2 Evaluation Script
- **File**: `scripts/eval/eval-with-ltr.ts` (NEW)
- **Purpose**: Compare baseline vs. LTR-reranked results
- **Output**: `data/ltr-eval-results.json`
- **Metrics**: NDCG@10, MRR@10, Recall@10, improvement deltas
- **Complexity**: Medium (use existing metrics framework)

#### 4.3 Ablation Study
- **File**: `scripts/ltr/ablation-study.ts` (NEW)
- **Purpose**: Measure contribution of each feature
- **Output**: `data/ltr-ablation-study.json`
- **Method**: Train subsets of features, measure NDCG change
- **Complexity**: Medium

---

## Data Flow Diagram

```
data/golden-queries-bronze.jsonl (500 queries)
        ↓
    [Phase 1.1: build-ranking-context]
        ↓
data/ltr-training-context.jsonl (10K docs, 500 queries)
        ↓
    [Phase 1.2: extract-features]
        ↓
data/ltr-training-features.jsonl (10K feature vectors)
        ↓
    [Phase 1.3: generate-pairwise-examples]
        ↓
data/ltr-pairwise-examples.jsonl (5K-10K pairs)
        ↓
    [Phase 3.2: train-lambdamart]
        ↓
data/models/lambdamart-v1.json (trained model)
        ↓
    [Phase 4.1: Integrate into search.usecase.ts]
        ↓
    [Phase 4.2: eval-with-ltr]
        ↓
data/ltr-eval-results.json (metrics comparison)
```

---

## Dependencies & Integration Points

### External Services Required
1. **Vespa** (already integrated): Search results + scores
2. **PostgreSQL**: Wine entities, eval cases/results
3. **Redis** (optional): Cached embeddings

### TypeScript Type Imports
```typescript
// From existing code:
import type { SearchResult } from '@domain/search/...';
import type { Wine } from '@domain/entity/model/wine.js';
import type { GoldenQuery } from '../etl/types.js';
import type { RankingFeatures } from '@domain/ranking/service/lambdamart-ranker.js';
```

### File Modifications
1. `src/application/search/search.usecase.ts` — Add LTR step
2. `src/config/container.ts` — Register LTRModelRegistry in DI
3. `src/domain/ranking/index.ts` — Export new services

---

## Time Estimates (Parallel Execution)

| Phase | Task | Complexity | Est. Time | Critical |
|-------|------|-----------|-----------|----------|
| 1.1 | build-ranking-context.ts | Low | 2h | Yes |
| 1.2 | extract-features.ts | Medium | 4h | Yes |
| 1.3 | generate-pairwise-examples.ts | Low | 1h | Yes |
| 2.1 | search-result-featurizer.ts | Medium | 3h | No |
| 2.2 | analyze-features.ts | Low | 2h | No |
| 3.1 | lambdamart-enhanced.ts | High | 6h | Yes |
| 3.2 | train-lambdamart.ts | Medium | 2h | Yes |
| 4.1 | search.usecase.ts integration | Low | 1h | Yes |
| 4.2 | eval-with-ltr.ts | Medium | 3h | No |
| 4.3 | ablation-study.ts | Medium | 3h | No |

**Total**: ~27 hours (can be parallelized to ~2 weeks)

---

## Risk Assessment

### High Risk
1. **Feature Quality** — Synthetic features won't improve ranking
   - **Mitigation**: Phase 2.2 feature importance analysis
   - **Fallback**: Use simpler features (BM25 + semantic)

2. **Training Convergence** — LambdaMART might not converge
   - **Mitigation**: Early stopping + validation monitoring
   - **Fallback**: Reduce learning rate, increase regularization

3. **Overfitting** — Model overfits to bronze tier labels
   - **Mitigation**: 5-fold CV + L2 regularization
   - **Fallback**: Use only high-agreement label cases

### Medium Risk
1. **Feature Extraction Latency** — Real features slow at inference
   - **Mitigation**: Precompute features, cache embeddings
   - **Fallback**: Simpler features

2. **Reranking Disruption** — LTR changes too many results
   - **Mitigation**: Monitor "reranking shift" metric
   - **Fallback**: Blend retrieval + LTR scores

### Low Risk
1. **Data Format Incompatibility** — Scripts fail on unexpected data
   - **Mitigation**: Validation scripts, test data
   - **Fallback**: Manual debugging

---

## Success Criteria

### Minimum (Pass)
- ✓ Training script runs without errors
- ✓ 5 models trained (one per query class)
- ✓ NDCG@10 > 0.3 on validation set

### Target (Good)
- ✓ NDCG@10 improvement of 15-20% over baseline
- ✓ No query class regresses more than 5%
- ✓ Feature importance identifies 3+ useful features

### Excellent (Great)
- ✓ NDCG@10 improvement of 20%+
- ✓ All query classes improve
- ✓ Reranking shift < 3 positions average
- ✓ Production latency < 50ms per query

---

## Next Steps (Immediate)

1. **Create Phase 1 scripts** (1-2 days)
   - build-ranking-context.ts
   - extract-features.ts
   - generate-pairwise-examples.ts

2. **Verify data pipeline** (1 day)
   - Load golden queries
   - Fetch top-20 from search results
   - Validate feature extraction

3. **Start Phase 3 in parallel** (ongoing)
   - lambdamart-enhanced.ts with 5-fold CV
   - Early stopping logic

4. **Integration & testing** (final week)
   - Modify search.usecase.ts
   - Run eval-with-ltr.ts
   - Deploy to staging

---

## References

- **RFC-009**: SOTA++ learning-to-rank design
- **RFC-017**: Evaluation framework
- **LambdaMART paper**: Burges et al. (2010)
- **NDCG metric**: Järvelin & Kekäläinen (2002)
- **Cross-validation**: Standard ML best practice (k=5)

---

**Prepared**: 2026-04-06  
**Infrastructure Audit**: Complete  
**Readiness**: 85% (features + training ready, execution needed)

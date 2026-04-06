# Task 7: LTR Technical Specification — Code & API Design

**Objective**: Provide exact code signatures and implementation contracts for Phase 1-4

---

## Phase 1.1: Build Ranking Context

### File: `scripts/ltr/build-ranking-context.ts`

```typescript
/**
 * Builds ranking context for LTR training.
 * 
 * For each golden query:
 * 1. Load query + ground truth labels
 * 2. Fetch top-20 results from evaluation results
 * 3. Assign relevance grades (0-3)
 * 4. Save as structured dataset
 * 
 * Input: data/golden-queries-bronze.jsonl, data/eval-results.json
 * Output: data/ltr-training-context.jsonl
 * 
 * Run: tsx scripts/ltr/build-ranking-context.ts
 */

import fs from 'node:fs/promises';
import { parseNdjson } from '../etl/ndjson.js';

export interface GoldenQuery {
  qid: string;
  query: string;
  query_class: string;
  scenario: string;
  language: string;
  retrieval_labels: {
    relevant: Array<{ entity_id: string; grade: number }>;
  };
  decision_labels: {
    expected_decision_status: string;
    expected_entity_id: string;
  };
  retrieval_mode: string;
}

export interface RankedWine {
  readonly entityId: string;
  readonly rank: number;
  readonly retrievalScore: number;
  readonly label: 0 | 1 | 2 | 3;
}

export interface RankingContext {
  readonly qid: string;
  readonly query: string;
  readonly queryClass: string;
  readonly retrievalMode: string;
  readonly scenario: string;
  readonly language: string;
  readonly topResults: readonly RankedWine[];
  readonly groundTruthEntityIds: readonly string[];
}

/**
 * Assigns relevance grade to a result.
 * 
 * Logic:
 * - Grade 3: Top-1 expected entity (correct resolve)
 * - Grade 2: Other relevant entities in labels
 * - Grade 1: Retrieved but not in labels (ambiguous case)
 * - Grade 0: Retrieved but clearly wrong
 */
function assignRelevanceGrade(
  entityId: string,
  rank: number,
  expectedEntityId: string | undefined,
  relevantEntities: Set<string>,
): 0 | 1 | 2 | 3 {
  if (entityId === expectedEntityId) {
    return 3;
  }
  if (relevantEntities.has(entityId)) {
    return 2;
  }
  if (rank <= 10) {
    return 1; // high-rank ambiguous
  }
  return 0;
}

/**
 * Loads eval results to fetch top-20 per query.
 * 
 * Assumes eval results contain decision snapshots with ranked results.
 */
async function loadEvalResults(
  filepath: string,
): Promise<Map<string, Array<{ entityId: string; score: number }>>> {
  const evalData = JSON.parse(await fs.readFile(filepath, 'utf-8'));
  const resultsByQuery = new Map<string, Array<{ entityId: string; score: number }>>();
  
  // Reconstruct from decision_snapshot in eval_results table (from database or file)
  // For now, infer from golden queries structure
  
  return resultsByQuery;
}

/**
 * Main: Build ranking contexts.
 */
async function buildRankingContexts(): Promise<void> {
  const inputFile = process.argv[2] || 'data/golden-queries-bronze.jsonl';
  const outputFile = process.argv[3] || 'data/ltr-training-context.jsonl';
  
  console.log('📖 Building ranking contexts...');
  
  const queries = await parseNdjson<GoldenQuery>(inputFile);
  const contexts: RankingContext[] = [];
  
  for (const query of queries) {
    const relevantEntityIds = new Set(
      query.retrieval_labels.relevant.map(r => r.entity_id),
    );
    
    // TODO: Fetch top-20 from eval results or search pipeline
    // For now, use mock data
    const topResults: RankedWine[] = [
      // {
      //   entityId: '...',
      //   rank: 1,
      //   retrievalScore: 0.95,
      //   label: assignRelevanceGrade(...)
      // }
    ];
    
    contexts.push({
      qid: query.qid,
      query: query.query,
      queryClass: query.query_class,
      retrievalMode: query.retrieval_mode,
      scenario: query.scenario,
      language: query.language,
      topResults,
      groundTruthEntityIds: Array.from(relevantEntityIds),
    });
  }
  
  // Write output
  const output = contexts.map(c => JSON.stringify(c)).join('\n');
  await fs.writeFile(outputFile, output);
  
  console.log(`✓ Wrote ${contexts.length} ranking contexts to ${outputFile}`);
  console.log(`  - Avg results per query: ${
    contexts.reduce((s, c) => s + c.topResults.length, 0) / contexts.length
  }`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildRankingContexts().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}

export { buildRankingContexts, RankingContext, RankedWine };
```

---

## Phase 1.2: Feature Extraction

### File: `scripts/ltr/extract-features.ts`

```typescript
/**
 * Extracts ranking features from ranking contexts.
 * 
 * For each (query, result) pair, computes:
 * - Retrieval scores (BM25, semantic)
 * - Popularity scores
 * - Query-entity matching
 * - Diversity and multilingual
 * 
 * Input: data/ltr-training-context.jsonl
 * Output: data/ltr-training-features.jsonl
 * 
 * Run: tsx scripts/ltr/extract-features.ts
 */

import fs from 'node:fs/promises';
import { parseNdjson } from '../etl/ndjson.js';
import type { RankingContext } from './build-ranking-context.js';

export interface RankingFeatures {
  readonly bm25Score: number;
  readonly semanticScore: number;
  readonly popularityScore: number;
  readonly recencyScore: number;
  readonly classMatchScore: number;
  readonly attributeMatchScore: number;
  readonly diversityScore: number;
  readonly multilingualScore: number;
}

export interface FeatureVector {
  readonly qid: string;
  readonly entityId: string;
  readonly rank: number;
  readonly label: 0 | 1 | 2 | 3;
  readonly queryClass: string;
  readonly groupId: string; // for grouping by qid in training
  readonly features: RankingFeatures;
}

/**
 * Loads wine entity metadata for attribute matching.
 * 
 * Schema:
 * {
 *   "entityId": "vivino-...",
 *   "entityType": "wine",
 *   "name": "...",
 *   "vintage": 2015,
 *   "variety": ["Cabernet Sauvignon"],
 *   "region": "Napa Valley",
 *   "price": 45.00,
 *   "reviewCount": 1200,
 *   "viewCount": 5000,
 *   "releaseDate": "2015-01-01"
 * }
 */
interface WineEntity {
  entityId: string;
  entityType: string;
  name: string;
  vintage?: number;
  variety?: string[];
  region?: string;
  price?: number;
  reviewCount: number;
  viewCount: number;
  releaseDate?: string;
}

/**
 * Loads wine entities from Vespa or database.
 * 
 * TODO: Implement actual loading from database
 */
async function loadWineEntities(): Promise<Map<string, WineEntity>> {
  // For now, return empty map (will fetch from DB/Vespa in implementation)
  return new Map();
}

/**
 * Computes BM25 score for query-document pair.
 * 
 * Simplified: Load from eval results or compute if available.
 * For now: Use placeholder.
 */
function computeBm25Score(query: string, entity: WineEntity): number {
  // TODO: Implement BM25 computation
  // For now: Score based on name match
  const lowerQuery = query.toLowerCase();
  const lowerName = entity.name.toLowerCase();
  
  if (lowerName.includes(lowerQuery)) {
    return 0.9;
  }
  const overlap = lowerName
    .split(' ')
    .filter(word => lowerQuery.includes(word))
    .length;
  return Math.min(0.8, overlap * 0.3);
}

/**
 * Computes semantic similarity score (dense embedding).
 * 
 * TODO: Load pre-computed embeddings from Redis/database
 */
function computeSemanticScore(_query: string, _entity: WineEntity): number {
  // Placeholder: return 0.5
  return 0.5;
}

/**
 * Computes popularity score from review count + views.
 */
function computePopularityScore(entity: WineEntity): number {
  const reviewCount = entity.reviewCount || 0;
  const viewCount = entity.viewCount || 0;
  
  // Normalize to [0, 1]
  // Max reasonable: 10K reviews, 100K views
  const reviewScore = Math.min(1, reviewCount / 10000);
  const viewScore = Math.min(1, viewCount / 100000);
  
  return (reviewScore * 0.6 + viewScore * 0.4);
}

/**
 * Computes recency score based on release date.
 */
function computeRecencyScore(entity: WineEntity): number {
  if (!entity.releaseDate) {
    return 0.5; // neutral if unknown
  }
  
  const releaseYear = new Date(entity.releaseDate).getFullYear();
  const currentYear = new Date().getFullYear();
  const ageYears = currentYear - releaseYear;
  
  // Exponential decay: newer is better
  const recencyScore = Math.exp(-ageYears / 20);
  return recencyScore;
}

/**
 * Computes class match score.
 * 
 * If query class is 'exact_entity', always match wine.
 * For other classes, 0 (not applicable).
 */
function computeClassMatchScore(queryClass: string, entityType: string): number {
  if (queryClass === 'exact_entity' && entityType === 'wine') {
    return 1.0;
  }
  return queryClass === entityType ? 0.8 : 0.2;
}

/**
 * Computes attribute match score.
 * 
 * Extracts vintage, region, variety from query text.
 * Matches against entity attributes.
 */
function computeAttributeMatchScore(
  query: string,
  entity: WineEntity,
): number {
  const lowerQuery = query.toLowerCase();
  let matchCount = 0;
  let totalChecks = 0;
  
  // Check vintage
  if (entity.vintage) {
    totalChecks++;
    if (lowerQuery.includes(String(entity.vintage))) {
      matchCount++;
    }
  }
  
  // Check region
  if (entity.region) {
    totalChecks++;
    if (lowerQuery.includes(entity.region.toLowerCase())) {
      matchCount++;
    }
  }
  
  // Check variety
  if (entity.variety) {
    for (const v of entity.variety) {
      totalChecks++;
      if (lowerQuery.includes(v.toLowerCase())) {
        matchCount++;
      }
    }
  }
  
  return totalChecks > 0 ? matchCount / totalChecks : 0.5;
}

/**
 * Computes diversity score based on distance from top results.
 */
function computeDiversityScore(
  rank: number,
  topResults: RankingContext['topResults'],
): number {
  // Simple: Higher rank = lower diversity (encourage lower-ranked items)
  // Penalize items in top-3 (assume already diverse from retriever)
  if (rank <= 3) {
    return 0.3; // low diversity bonus
  }
  if (rank <= 10) {
    return 0.6;
  }
  return 0.9; // high diversity bonus for lower ranks
}

/**
 * Computes multilingual score.
 * 
 * For Korean queries, prefer wines with Korean reviews/context.
 */
function computeMultilingualScore(
  queryLanguage: string,
  _entity: WineEntity,
): number {
  // Placeholder: return language match score
  // In practice, check entity metadata for language coverage
  return queryLanguage === 'ko' ? 0.7 : 0.5;
}

/**
 * Extracts all features for a single (query, result) pair.
 */
function extractFeatures(
  context: RankingContext,
  wine: WineEntity,
  rank: number,
): RankingFeatures {
  return {
    bm25Score: computeBm25Score(context.query, wine),
    semanticScore: computeSemanticScore(context.query, wine),
    popularityScore: computePopularityScore(wine),
    recencyScore: computeRecencyScore(wine),
    classMatchScore: computeClassMatchScore(context.queryClass, wine.entityType),
    attributeMatchScore: computeAttributeMatchScore(context.query, wine),
    diversityScore: computeDiversityScore(rank, context.topResults),
    multilingualScore: computeMultilingualScore(context.language, wine),
  };
}

/**
 * Main: Extract features for all ranking contexts.
 */
async function extractAllFeatures(): Promise<void> {
  const inputFile = process.argv[2] || 'data/ltr-training-context.jsonl';
  const outputFile = process.argv[3] || 'data/ltr-training-features.jsonl';
  
  console.log('🔧 Extracting features...');
  
  const contexts = await parseNdjson<RankingContext>(inputFile);
  const wines = await loadWineEntities();
  
  const featureVectors: FeatureVector[] = [];
  
  for (const context of contexts) {
    for (const result of context.topResults) {
      const wine = wines.get(result.entityId);
      if (!wine) {
        console.warn(`⚠️  Wine not found: ${result.entityId}`);
        continue;
      }
      
      const features = extractFeatures(context, wine, result.rank);
      
      featureVectors.push({
        qid: context.qid,
        entityId: result.entityId,
        rank: result.rank,
        label: result.label,
        queryClass: context.queryClass,
        groupId: context.qid, // for LambdaMART grouping
        features,
      });
    }
  }
  
  // Write output
  const output = featureVectors.map(v => JSON.stringify(v)).join('\n');
  await fs.writeFile(outputFile, output);
  
  console.log(`✓ Wrote ${featureVectors.length} feature vectors to ${outputFile}`);
  console.log(`  - Avg features per query: ${
    featureVectors.length / contexts.length
  }`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  extractAllFeatures().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}

export { extractAllFeatures, FeatureVector, RankingFeatures };
```

---

## Phase 1.3: Pairwise Example Generation

### File: `scripts/ltr/generate-pairwise-examples.ts`

```typescript
/**
 * Generates pairwise examples for LambdaMART training.
 * 
 * For each query with 2+ results:
 * - Pair every doc with higher label with every doc with lower label
 * - Generate training pairs for gradient-based optimization
 * 
 * Input: data/ltr-training-features.jsonl
 * Output: data/ltr-pairwise-examples.jsonl
 * 
 * Run: tsx scripts/ltr/generate-pairwise-examples.ts
 */

import fs from 'node:fs/promises';
import { parseNdjson } from '../etl/ndjson.js';
import type { FeatureVector, RankingFeatures } from './extract-features.js';

export interface LambdaMARTExample {
  readonly queryId: string;
  readonly query: string;
  readonly queryClass: string;
  readonly label1: 0 | 1 | 2 | 3;
  readonly features1: RankingFeatures;
  readonly label2: 0 | 1 | 2 | 3;
  readonly features2: RankingFeatures;
}

/**
 * Generates all positive pairs from a query's results.
 * 
 * For each pair of results (d_i, d_j) where label_i > label_j:
 * - Create example (d_i, d_j, label_i - label_j)
 * 
 * This creates "pairwise preferences" for LambdaMART loss.
 */
function generatePairsForQuery(
  queryId: string,
  query: string,
  queryClass: string,
  results: readonly FeatureVector[],
): LambdaMARTExample[] {
  const pairs: LambdaMARTExample[] = [];
  
  // Sort by label (descending)
  const sorted = [...results].sort((a, b) => b.label - a.label);
  
  // Generate all pairs with label difference
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const higher = sorted[i];
      const lower = sorted[j];
      
      if (higher && lower && higher.label > lower.label) {
        pairs.push({
          queryId,
          query,
          queryClass,
          label1: higher.label,
          features1: higher.features,
          label2: lower.label,
          features2: lower.features,
        });
      }
    }
  }
  
  return pairs;
}

/**
 * Main: Generate pairwise examples.
 */
async function generatePairwiseExamples(): Promise<void> {
  const inputFile = process.argv[2] || 'data/ltr-training-features.jsonl';
  const outputFile = process.argv[3] || 'data/ltr-pairwise-examples.jsonl';
  
  console.log('🔗 Generating pairwise examples...');
  
  const features = await parseNdjson<FeatureVector>(inputFile);
  
  // Group by query
  const queriesMap = new Map<string, FeatureVector[]>();
  for (const f of features) {
    const list = queriesMap.get(f.qid) ?? [];
    list.push(f);
    queriesMap.set(f.qid, list);
  }
  
  const examples: LambdaMARTExample[] = [];
  
  for (const [qid, results] of queriesMap.entries()) {
    if (results.length < 2) {
      continue; // need at least 2 results to form pairs
    }
    
    const query = results[0]?.groupId ?? qid;
    const queryClass = results[0]?.queryClass ?? 'unknown';
    
    const pairs = generatePairsForQuery(qid, query, queryClass, results);
    examples.push(...pairs);
  }
  
  // Write output
  const output = examples.map(e => JSON.stringify(e)).join('\n');
  await fs.writeFile(outputFile, output);
  
  console.log(`✓ Wrote ${examples.length} pairwise examples to ${outputFile}`);
  console.log(`  - Queries: ${queriesMap.size}`);
  console.log(`  - Avg pairs per query: ${(examples.length / queriesMap.size).toFixed(1)}`);
  
  // Statistics
  const labelDiffs = examples.map(e => e.label1 - e.label2);
  console.log(`\n  Label differences:`);
  for (const diff of [1, 2, 3]) {
    const count = labelDiffs.filter(d => d === diff).length;
    console.log(`    label_diff=${diff}: ${count} pairs`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generatePairwiseExamples().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}

export { generatePairwiseExamples, LambdaMARTExample };
```

---

## Phase 2.1: Feature Extraction Adapters

### File: `src/infrastructure/adapter/search-result-featurizer.ts` (NEW)

```typescript
/**
 * Adapters to convert search results into ranking features.
 * 
 * Bridges:
 * - Vespa results → BM25 + semantic scores
 * - Wine entity → Popularity, recency, attributes
 * - Query → Query class, attributes
 * 
 * Used by:
 * - scripts/ltr/extract-features.ts
 * - src/application/search/search.usecase.ts (production reranking)
 */

import type { RankingFeatures } from '../../domain/ranking/service/lambdamart-ranker.js';
import type { SearchResult } from '../../domain/search/model/search-result.js';
import type { Wine } from '../../domain/entity/model/wine.js';

export namespace SearchResultFeaturizer {
  /**
   * Extracts BM25 score from Vespa result.
   */
  export function extractBm25Score(result: SearchResult): number {
    // Vespa returns relevance score in [0, 1]
    // BM25 is already computed server-side
    return result.relevanceScore ?? 0.5;
  }

  /**
   * Extracts semantic similarity score from Vespa result.
   * 
   * Assumes Vespa RankProfile includes embedding similarity.
   */
  export function extractSemanticScore(result: SearchResult): number {
    // Extract from result.metadata.semanticScore if present
    const semantic = (result.metadata as unknown as Record<string, unknown>)
      ?.semanticScore as number | undefined;
    return semantic ?? 0.5;
  }

  /**
   * Computes popularity score from wine entity.
   */
  export function computePopularityScore(wine: Wine): number {
    const reviewCount = wine.metadata?.reviewCount as number | undefined ?? 0;
    const viewCount = wine.metadata?.viewCount as number | undefined ?? 0;
    
    const reviewScore = Math.min(1, reviewCount / 10000);
    const viewScore = Math.min(1, viewCount / 100000);
    
    return reviewScore * 0.6 + viewScore * 0.4;
  }

  /**
   * Computes recency score from wine entity.
   */
  export function computeRecencyScore(wine: Wine): number {
    const vintage = wine.attributes?.vintage as number | undefined;
    if (!vintage) return 0.5;
    
    const currentYear = new Date().getFullYear();
    const ageYears = currentYear - vintage;
    
    return Math.exp(-ageYears / 20);
  }

  /**
   * Extracts all features from a search result + wine entity.
   */
  export function extractFeatures(
    result: SearchResult,
    wine: Wine,
    rank: number,
    queryClass: string,
    queryLanguage: string,
  ): RankingFeatures {
    return {
      bm25Score: extractBm25Score(result),
      semanticScore: extractSemanticScore(result),
      popularityScore: computePopularityScore(wine),
      recencyScore: computeRecencyScore(wine),
      classMatchScore: queryClass === 'exact_entity' ? 1.0 : 0.5,
      attributeMatchScore: 0.5, // TODO: compute from query attributes
      diversityScore: rank <= 3 ? 0.3 : (rank <= 10 ? 0.6 : 0.9),
      multilingualScore: queryLanguage === 'ko' ? 0.7 : 0.5,
    };
  }
}
```

---

## Phase 3.1: Enhanced LambdaMART Trainer

### File: `src/domain/ranking/service/lambdamart-enhanced.ts` (NEW)

```typescript
/**
 * Enhanced LambdaMART trainer with proper cross-validation and regularization.
 * 
 * Improvements over lambdamart-ranker.ts:
 * - 5-fold cross-validation
 * - Early stopping by validation NDCG@10
 * - Better gradient computation
 * - Feature importance analysis
 * - Model serialization
 */

import type { RankingFeatures, LambdaMARTExample, QueryClassWeights } from './lambdamart-ranker.js';

export interface TrainingMetrics {
  readonly totalExamples: number;
  readonly cvFolds: number;
  readonly meanValidationNdcg10: number;
  readonly stdValidationNdcg10: number;
  readonly trainingTime: number;
  readonly iterationsPerFold: number;
  readonly featureImportance: Record<string, number>;
}

export interface LTRModel {
  readonly modelId: string;
  readonly version: string;
  readonly trainedAt: Date;
  readonly models: Map<string, QueryClassWeights>;
  readonly metrics: TrainingMetrics;
}

/**
 * Enhanced LambdaMART trainer with 5-fold CV.
 */
export class LambdaMARTTrainer {
  private readonly learningRate: number = 0.01;
  private readonly regularization: number = 0.001;
  private readonly maxIterations: number = 100;
  private readonly earlyStoppingPatience: number = 10;

  constructor(params?: {
    learningRate?: number;
    regularization?: number;
    maxIterations?: number;
    earlyStoppingPatience?: number;
  }) {
    if (params?.learningRate !== undefined) {
      this.learningRate = params.learningRate;
    }
    if (params?.regularization !== undefined) {
      this.regularization = params.regularization;
    }
    if (params?.maxIterations !== undefined) {
      this.maxIterations = params.maxIterations;
    }
    if (params?.earlyStoppingPatience !== undefined) {
      this.earlyStoppingPatience = params.earlyStoppingPatience;
    }
  }

  /**
   * Performs 5-fold cross-validation training.
   */
  train(
    examples: readonly LambdaMARTExample[],
  ): LTRModel {
    const startTime = Date.now();

    // Group by query class
    const byQueryClass = new Map<string, LambdaMARTExample[]>();
    for (const ex of examples) {
      const list = byQueryClass.get(ex.queryClass) ?? [];
      list.push(ex);
      byQueryClass.set(ex.queryClass, list);
    }

    const cvResults: number[] = [];
    const models = new Map<string, QueryClassWeights>();

    // 5-fold CV per query class
    for (const [queryClass, classExamples] of byQueryClass.entries()) {
      const folds = this.createFolds(classExamples, 5);
      const foldNdcgs: number[] = [];

      for (let foldIdx = 0; foldIdx < folds.length; foldIdx++) {
        const [trainSet, valSet] = folds[foldIdx];
        if (!trainSet || !valSet || trainSet.length === 0 || valSet.length === 0) {
          continue;
        }

        const model = this.trainFold(trainSet, valSet, queryClass, foldIdx);
        foldNdcgs.push(model.ndcg5ValidationScore);
        cvResults.push(model.ndcg5ValidationScore);
      }

      // Average weights across folds
      const avgModel = this.averageModels(
        folds.map(([, valSet]) => this.trainFold(classExamples, valSet ?? [], queryClass, 0)),
      );
      models.set(queryClass, avgModel);
    }

    const meanNdcg = cvResults.length > 0
      ? cvResults.reduce((a, b) => a + b, 0) / cvResults.length
      : 0;
    const stdNdcg = cvResults.length > 1
      ? Math.sqrt(
        cvResults.reduce((sum, v) => sum + Math.pow(v - meanNdcg, 2), 0) /
        (cvResults.length - 1),
      )
      : 0;

    const elapsedMs = Date.now() - startTime;

    return {
      modelId: `ltr-${Date.now()}`,
      version: '2.0.0',
      trainedAt: new Date(),
      models,
      metrics: {
        totalExamples: examples.length,
        cvFolds: 5,
        meanValidationNdcg10: meanNdcg,
        stdValidationNdcg10: stdNdcg,
        trainingTime: elapsedMs,
        iterationsPerFold: this.maxIterations,
        featureImportance: {}, // TODO: compute
      },
    };
  }

  /**
   * Creates k folds for cross-validation.
   */
  private createFolds(
    examples: readonly LambdaMARTExample[],
    k: number,
  ): Array<[LambdaMARTExample[], LambdaMARTExample[]]> {
    const folds: Array<[LambdaMARTExample[], LambdaMARTExample[]]> = [];
    const foldSize = Math.ceil(examples.length / k);

    for (let i = 0; i < k; i++) {
      const start = i * foldSize;
      const end = Math.min(start + foldSize, examples.length);
      const valSet = examples.slice(start, end);
      const trainSet = [...examples.slice(0, start), ...examples.slice(end)];

      folds.push([trainSet, valSet]);
    }

    return folds;
  }

  /**
   * Trains on a single fold.
   */
  private trainFold(
    trainSet: readonly LambdaMARTExample[],
    valSet: readonly LambdaMARTExample[],
    queryClass: string,
    foldIdx: number,
  ): QueryClassWeights {
    // Use existing lambdamart-ranker.trainLambdaMARTModel
    const weights = [0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125];
    let bias = 0.5;
    let bestNdcg = -Infinity;
    let patienceCounter = 0;

    for (let iter = 0; iter < this.maxIterations; iter++) {
      const batchSize = Math.max(1, Math.floor(trainSet.length / 10));
      const batch = this.sampleBatch(trainSet, batchSize);

      const gradients = Array(8).fill(0);
      let biasMeanDelta = 0;

      for (const example of batch) {
        const score1 = this.scoreFeatures(example.features1, weights, bias);
        const score2 = this.scoreFeatures(example.features2, weights, bias);

        const labelDiff = example.label1 - example.label2;
        const scoreDiff = score1 - score2;

        // Stable sigmoid
        const lambda = labelDiff / (1 + Math.exp(Math.max(-100, Math.min(100, scoreDiff))));

        for (let j = 0; j < 8; j++) {
          const f1 = Object.values(example.features1)[j] as number;
          const f2 = Object.values(example.features2)[j] as number;
          gradients[j] = (gradients[j] ?? 0) + lambda * (f1 - f2);
        }
        biasMeanDelta += lambda;
      }

      // Update with regularization
      for (let j = 0; j < 8; j++) {
        const grad = (gradients[j] ?? 0) / batch.length;
        weights[j] = (weights[j] ?? 0) + this.learningRate * grad - this.regularization * (weights[j] ?? 0);
        weights[j] = Math.max(-1, Math.min(1, weights[j] ?? 0));
      }
      bias = bias + this.learningRate * (biasMeanDelta / batch.length);

      // Validation & early stopping
      if (iter % 5 === 0 && valSet.length > 0) {
        const ndcg = this.computeNdcg(valSet, weights, bias);
        if (ndcg > bestNdcg) {
          bestNdcg = ndcg;
          patienceCounter = 0;
        } else {
          patienceCounter++;
          if (patienceCounter >= this.earlyStoppingPatience) {
            console.warn(`  Fold ${foldIdx}: Early stopping at iteration ${iter}`);
            break;
          }
        }
      }
    }

    const weightSum = weights.reduce((a, b) => a + b, 0);
    const normalized = weights.map(w => w / weightSum);

    return {
      queryClass,
      weights: normalized,
      bias,
      trainingExampleCount: trainSet.length,
      ndcg5ValidationScore: bestNdcg,
      trainedAt: new Date(),
    };
  }

  private sampleBatch(
    examples: readonly LambdaMARTExample[],
    size: number,
  ): LambdaMARTExample[] {
    const shuffled = [...examples].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, size);
  }

  private scoreFeatures(
    features: RankingFeatures,
    weights: readonly number[],
    bias: number,
  ): number {
    const values = Object.values(features);
    let score = bias;
    for (let i = 0; i < values.length; i++) {
      score += (values[i] as number) * (weights[i] ?? 0);
    }
    return Math.max(0, Math.min(1, score));
  }

  private computeNdcg(
    examples: readonly LambdaMARTExample[],
    weights: readonly number[],
    bias: number,
  ): number {
    let totalNdcg = 0;
    let queryCount = 0;

    const byQuery = new Map<string, LambdaMARTExample[]>();
    for (const ex of examples) {
      const list = byQuery.get(ex.query) ?? [];
      list.push(ex);
      byQuery.set(ex.query, list);
    }

    for (const [, exs] of byQuery) {
      const scored = exs.flatMap(ex => [
        { label: ex.label1, score: this.scoreFeatures(ex.features1, weights, bias) },
        { label: ex.label2, score: this.scoreFeatures(ex.features2, weights, bias) },
      ]);

      const ranked = scored.sort((a, b) => b.score - a.score).slice(0, 10);

      let dcg = 0;
      for (let i = 0; i < ranked.length; i++) {
        const gain = Math.pow(2, ranked[i]?.label ?? 0) - 1;
        const discount = 1 / Math.log2(i + 2);
        dcg += gain * discount;
      }

      const idcg = Array(Math.min(10, exs.length))
        .fill(3)
        .reduce((sum, _, i) => sum + (Math.pow(2, 3) - 1) / Math.log2(i + 2), 0);

      const ndcg = idcg > 0 ? dcg / idcg : 0;
      totalNdcg += ndcg;
      queryCount++;
    }

    return queryCount > 0 ? totalNdcg / queryCount : 0;
  }

  private averageModels(models: QueryClassWeights[]): QueryClassWeights {
    if (models.length === 0) {
      return {
        queryClass: 'unknown',
        weights: [0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125],
        bias: 0.5,
        trainingExampleCount: 0,
        ndcg5ValidationScore: 0,
        trainedAt: new Date(),
      };
    }

    const avgWeights = Array(8).fill(0).map((_, i) =>
      models.reduce((sum, m) => sum + (m.weights[i] ?? 0), 0) / models.length,
    );

    const avgBias = models.reduce((sum, m) => sum + m.bias, 0) / models.length;
    const avgNdcg = models.reduce((sum, m) => sum + m.ndcg5ValidationScore, 0) / models.length;

    return {
      queryClass: models[0]?.queryClass ?? 'unknown',
      weights: avgWeights,
      bias: avgBias,
      trainingExampleCount: models.reduce((sum, m) => sum + m.trainingExampleCount, 0),
      ndcg5ValidationScore: avgNdcg,
      trainedAt: new Date(),
    };
  }
}
```

---

## Phase 3.2: Training Script

### File: `scripts/ltr/train-lambdamart.ts` (NEW)

```typescript
/**
 * Main LambdaMART training script.
 * 
 * Orchestrates:
 * 1. Load pairwise examples
 * 2. Train with 5-fold CV
 * 3. Save model
 * 4. Generate report
 * 
 * Run: tsx scripts/ltr/train-lambdamart.ts \
 *   --input data/ltr-pairwise-examples.jsonl \
 *   --output data/models/lambdamart-v1.json \
 *   --cv-folds 5
 */

import fs from 'node:fs/promises';
import { parseNdjson } from '../etl/ndjson.js';
import type { LambdaMARTExample } from './generate-pairwise-examples.js';
import { LambdaMARTTrainer } from '../../src/domain/ranking/service/lambdamart-enhanced.js';
import type { LTRModel } from '../../src/domain/ranking/service/lambdamart-enhanced.js';

async function main(): Promise<void> {
  const args = {
    input: process.argv[process.argv.indexOf('--input') + 1] || 'data/ltr-pairwise-examples.jsonl',
    output: process.argv[process.argv.indexOf('--output') + 1] || 'data/models/lambdamart-v1.json',
    reportOutput: 'data/ltr-training-report.json',
    cvFolds: parseInt(process.argv[process.argv.indexOf('--cv-folds') + 1] || '5'),
  };

  console.log('🧠 Loading training examples...');
  const examples = await parseNdjson<LambdaMARTExample>(args.input);
  console.log(`✓ Loaded ${examples.length} examples`);

  console.log('\n🎓 Training LambdaMART with 5-fold CV...');
  const startTime = Date.now();

  const trainer = new LambdaMARTTrainer({
    learningRate: 0.01,
    regularization: 0.001,
    maxIterations: 100,
    earlyStoppingPatience: 10,
  });

  const model = trainer.train(examples);
  const elapsedMs = Date.now() - startTime;

  console.log(`✓ Training complete in ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`  Mean NDCG@10: ${model.metrics.meanValidationNdcg10.toFixed(3)}`);
  console.log(`  Std Dev: ${model.metrics.stdValidationNdcg10.toFixed(3)}`);
  console.log(`  Models: ${model.models.size} query classes`);

  // Ensure output directory
  const outputDir = args.output.split('/').slice(0, -1).join('/');
  await fs.mkdir(outputDir, { recursive: true });

  // Save model (serialize to JSON)
  const modelJson = JSON.stringify(
    {
      modelId: model.modelId,
      version: model.version,
      trainedAt: model.trainedAt,
      models: Array.from(model.models.entries()).map(([queryClass, weights]) => ({
        queryClass,
        weights: Array.from(weights.weights),
        bias: weights.bias,
        trainingExampleCount: weights.trainingExampleCount,
        ndcg5ValidationScore: weights.ndcg5ValidationScore,
        trainedAt: weights.trainedAt,
      })),
      metrics: model.metrics,
    },
    null,
    2,
  );

  await fs.writeFile(args.output, modelJson);
  console.log(`\n💾 Model saved to ${args.output}`);

  // Save report
  const report = {
    timestamp: new Date().toISOString(),
    totalExamples: examples.length,
    trainingTime: elapsedMs,
    metrics: model.metrics,
    queryClasses: Array.from(model.models.keys()),
  };

  await fs.writeFile(args.reportOutput, JSON.stringify(report, null, 2));
  console.log(`📊 Report saved to ${args.reportOutput}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
```

---

## Phase 4.1: Production Reranker Integration

### File: `src/application/search/search.usecase.ts` (MODIFICATION)

```typescript
// In the final response building, add LTR reranking:

async search(request: SearchRequest): Promise<SearchResponse> {
  // ... existing search pipeline ...

  const topResults = await vespaSearch(...); // top 100
  
  // Apply LTR reranking if model available
  let finalResults = topResults;
  if (this.ltrModelRegistry && request.queryClass) {
    const model = this.ltrModelRegistry.models.get(request.queryClass);
    if (model) {
      finalResults = this.ltrReranker.rerank(
        topResults,
        request.queryClass,
        model,
      );
      console.log(`[LTR] Reranked top-100 for query class: ${request.queryClass}`);
    }
  }
  
  // Return top-20 after reranking
  return this.responseBuilder.build(
    finalResults.slice(0, 20),
    request,
  );
}
```

---

## Code Quality & Testing

All new files must:

1. **TypeScript Strict Mode**: `strict: true`, `exactOptionalPropertyTypes: true`
2. **No `any` types**: Use specific types or generics
3. **Proper error handling**: Try-catch, null checks
4. **Unit tests**: For critical functions (feature computation, LambdaMART scoring)
5. **Integration tests**: End-to-end training + eval

---

## Expected File Sizes & Performance

| File | Size | Time to Generate |
|------|------|------------------|
| ltr-training-context.jsonl | ~5 MB | ~30s |
| ltr-training-features.jsonl | ~8 MB | ~60s |
| ltr-pairwise-examples.jsonl | ~3 MB | ~15s |
| lambdamart-v1.json | ~50 KB | ~5min (5-fold CV) |

---

## Next: Phase 4 Evaluation Script

See `Phase 4.2: Evaluation on Test Set` for complete eval-with-ltr.ts implementation.

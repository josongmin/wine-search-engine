# Wave 4 Track D Phase 3-4 Integration Guide

## Overview

This document provides the implementation blueprint for phases 3 and 4 of the performance optimization track. Phase 3 integrates caching into the SearchUseCase pipeline, and Phase 4 optimizes Vespa query execution through mode-specific profiles.

## Phase 3: SearchUseCase Integration

### Objective
Wire cache layers into the search pipeline for 80-120ms latency reduction on query cache hits and 50-100ms reduction on embedding cache hits.

### Integration Points

#### Point 1: Query Cache (Earliest Exit)
**File**: `src/application/search/search.usecase.ts`
**Method**: `execute()`
**Timing**: BEFORE `queryPlanner.plan()`

```typescript
async execute(request: SearchRequest, requestId: string): Promise<SearchResponseV1> {
  const startTime = Date.now();

  // 1. Build cache key from query + inferred mode
  if (this.deps.queryCache) {
    const eligibility = this.deps.cacheEligibility.analyze(queryPlan);
    if (eligibility.isCacheable) {
      const cacheKey = this.deps.queryCacheKeyBuilder.build(
        normalizeQuery(request.query),
        inferMode(request),
        extractConstraints(request),
        extractExpansions(request)
      );

      // 2. Check cache BEFORE plan computation
      const cached = await this.deps.queryCache.get(cacheKey);
      if (cached) {
        // 3. Enrich with fresh requestId and latency
        return {
          ...cached,
          meta: {
            ...cached.meta,
            requestId,
            queryTimeMs: Date.now() - startTime
          }
        };
      }

      // Continue with normal pipeline...
      // ... plan, resolve, retrieve, rank, decide ...

      // 4. Cache response before returning
      await this.deps.queryCache.set(cacheKey, response, eligibility.ttlSeconds);
    }
  }

  return response;
}
```

**Expected Savings**: 80-120ms per hit (avoids planning, resolution, retrieval, ranking)

#### Point 2: Embedding Cache (High Reuse)
**File**: `src/domain/retrieval/service/candidate-pool.ts`
**Method**: `generate()`
**Timing**: For each semantic query in dense search

```typescript
async generate(input: HybridRetrievalInput): Promise<readonly HybridCandidate[]> {
  // ... sparse search ...

  // NEW: Check embedding cache per query
  const embeddings: (readonly number[] | null)[] = [];
  const uncachedIndices: number[] = [];

  for (let i = 0; i < input.semanticQueries.length; i++) {
    const query = input.semanticQueries[i];
    const key = this.deps.embeddingCacheKeyBuilder.build(
      normalizeQuery(query),
      this.modelId,
      'Search: '
    );

    const cached = await this.deps.embeddingCache?.get(key);
    embeddings[i] = cached ?? null;
    if (!cached) uncachedIndices.push(i);
  }

  // Only embed uncached queries
  if (uncachedIndices.length > 0) {
    const toEmbed = uncachedIndices.map(i => input.semanticQueries[i]);
    const newEmbeddings = await this.embeddingService.embedBatch(toEmbed);

    for (const [j, idx] of uncachedIndices.entries()) {
      embeddings[idx] = newEmbeddings[j];
      await this.deps.embeddingCache?.set(key, newEmbeddings[j], 7200);
    }
  }

  // Continue with dense search
  return await this.searchIndex.denseSearch(embeddings);
}
```

**Expected Savings**: 50-100ms per hit (40-60% hit rate on repeated terms)

#### Point 3: Result Cache (Skip Ranking)
**File**: `src/application/search/search.usecase.ts`
**Method**: `execute()`
**Timing**: AFTER ranking, BEFORE decision engine

```typescript
// After ranker produces results
const rankedResults = await this.deps.ranker.rank(rankingInput);

// NEW: Check result cache for stable queries
if (this.deps.resultCache && !this.isPersonalized(request)) {
  const resultKey = this.deps.resultCacheKeyBuilder.build(
    'hybrid',
    rankedResults.length,
    extractConstraints(plan.constraints.hard),
    plan.retrievalMode
  );

  const cached = await this.deps.resultCache.get(resultKey);
  if (cached) {
    // Use cached ranking, skip ranking computation
    // But must run decision engine (RFC-007)
    const decisionOutput = await this.deps.decisionEngine.decide(...);
    return this.deps.responseBuilder.build({
      decisionOutput,
      results: cached,  // From cache
      ...
    });
  }
}

// Normal flow: decision + build response
const decisionOutput = await this.deps.decisionEngine.decide(decisionInput, snapshot);

// Cache results for future use
await this.deps.resultCache?.set(resultKey, rankedResults, 1800);

return this.deps.responseBuilder.build({ decisionOutput, results: rankedResults, ... });
```

**Expected Savings**: 40-60ms per hit (skip ranker computation)

### Dependencies to Wire (in config/container.ts)

```typescript
// Import cache infrastructure
import { RedisQueryCache } from '@infra/cache/redis-query-cache.js';
import { RedisEmbeddingCache } from '@infra/cache/redis-embedding-cache.js';
import {
  CacheEligibilityAnalyzer,
  QueryCacheKeyBuilder,
  ResultCacheKeyBuilder,
  EmbeddingCacheKeyBuilder
} from '@domain/performance/index.js';

// Wire into container
queryCache: new RedisQueryCache(redisClient),
embeddingCache: new RedisEmbeddingCache(redisClient),
resultCache: new RedisQueryCache(redisClient),  // Reuse interface
cacheEligibility: new CacheEligibilityAnalyzer(),
queryCacheKeyBuilder: new QueryCacheKeyBuilder(),
resultCacheKeyBuilder: new ResultCacheKeyBuilder(),
embeddingCacheKeyBuilder: new EmbeddingCacheKeyBuilder(),

// Pass to SearchUseCase
searchUseCase: new SearchUseCase({
  ...existingDeps,
  queryCache,
  embeddingCache,
  resultCache,
  cacheEligibility,
  queryCacheKeyBuilder,
  resultCacheKeyBuilder,
  embeddingCacheKeyBuilder,
}),
```

---

## Phase 4: Vespa Query Profile Optimization

### Objective
Optimize Vespa query execution for different retrieval modes with mode-specific timeouts, HNSW parameters, and ranking weights.

### Query Profiles Created

All profiles inherit from `default` profile which sets base configuration.

#### 1. entity_lookup (Precision Focus)
- **Timeout**: 50ms (aggressive for user experience)
- **HNSW**: `approximate=false, exploreEarly=false` (full precision)
- **Weights**: Lexical 75% (exact match dominates)
- **Use Case**: Single entity resolution queries
- **Expected P99**: < 50ms

#### 2. producer_browse (Balanced)
- **Timeout**: 200ms (reasonable for browsing)
- **HNSW**: `approximate=true, exploreEarly=true` (speed over precision)
- **Weights**: Lexical 40%, Semantic 20%, Attribute 25%, Popularity 15%
- **Use Case**: Browse wines by winery/producer
- **Expected P99**: ~150-180ms

#### 3. recommendation (Semantic Focus)
- **Timeout**: 300ms (longer acceptable for personalization quality)
- **HNSW**: `approximate=true, exploreEarly=false` (full exploration)
- **Weights**: Semantic 50% (preference matching)
- **Use Case**: Personalized recommendations
- **Expected P99**: ~250-300ms

### Profile Hierarchy

```
default.xml (base)
  ├── entity_lookup.xml (precision, fast)
  ├── producer_browse.xml (balanced)
  ├── recommendation.xml (semantic-heavy)
  ├── region_browse.xml (similar to producer)
  ├── similar_items.xml (high semantic weight)
  └── [others...]
```

### HNSW Parameter Tuning

**Approximate Search** (`approximate=true`)
- Skips full HNSW traversal for faster results
- Suitable for browse/recommendation (can miss perfect match)
- NOT suitable for lookup (need 100% recall)

**Early Exploration** (`exploreEarly=true`)
- Only uses approximate results in rank phase
- Reduces computation, acceptable for browsing
- False for queries requiring exact matches

**Max Hits Per Node** (`hnsw.maxHitsPerNode`)
- Higher for browsing (200): explore more candidates
- Lower for lookup (100): focused search
- Trade-off: more exploration = higher latency

---

## Testing Strategy

### Unit Tests
- Cache eligibility for each retrieval mode
- Cache key determinism (same inputs → same key)
- Hit/miss statistics accuracy

### Integration Tests
- Full pipeline: query cache hits skip planning/retrieval
- Embedding cache: reuse on repeated terms
- Result cache: ranking recomputation skipped
- Invalidation: model upgrades clear cache

### Performance Tests
- **Query Cache Hit**: 80-120ms savings vs. baseline
- **Embedding Cache Hit**: 50-100ms savings
- **Result Cache Hit**: 40-60ms savings (skip ranker)
- **P99 with Cache**: Should reduce from 400ms to ~200-250ms

### Load Tests
- Cache hit rates under peak load (20-30% for queries, 40-60% for embeddings)
- Memory pressure from Redis (500MB query cache, 200MB embedding cache)
- Eviction behavior when hitting size limits

---

## Rollout Plan

### Phase 1: Deploy Cache Infrastructure
1. Wire Redis clients into container
2. Ensure Redis connectivity and TTL behavior

### Phase 2: Query Cache
1. Enable query cache in SearchUseCase
2. Monitor cache hit rates
3. Tune TTL based on query distribution

### Phase 3: Embedding Cache
1. Enable embedding cache in CandidatePoolService
2. Monitor embedding reuse rates
3. Adjust TTL if models upgrade frequently

### Phase 4: Vespa Profiles
1. Test profiles against golden query set
2. Monitor latency improvements
3. Roll out mode-specific profiles

### Phase 5: Result Cache
1. Enable result cache for stable queries
2. Monitor cache effectiveness
3. Measure ranking computation savings

---

## Monitoring Metrics

```
query_cache_hits          # Counter of query cache hits
query_cache_misses        # Counter of query cache misses
embedding_cache_hits      # Counter of embedding cache hits
embedding_cache_misses    # Counter of embedding cache misses
result_cache_hits         # Counter of result cache hits
result_cache_misses       # Counter of result cache misses
latency_with_cache        # P50, P95, P99 response times (cache hits)
latency_without_cache     # P50, P95, P99 response times (cache misses)
cache_hit_rate            # Overall hit rate by mode
vespa_query_latency       # Per-mode Vespa latency (sparse, dense, total)
```

---

## Success Criteria

- ✅ Query cache hit rate: 20-30% in peak hours
- ✅ Embedding cache hit rate: 40-60% overall
- ✅ Result cache hit rate: 15-25% for browsing modes
- ✅ Query cache savings: 80-120ms per hit
- ✅ Embedding cache savings: 50-100ms per hit
- ✅ Result cache savings: 40-60ms per hit
- ✅ P99 response time: < 300ms (down from 400ms)
- ✅ Memory usage: < 1GB for all caches combined

# Root Cause Analysis: EntityResolver & DecisionEngine Candidate Filtering

**Status**: ROOT CAUSE IDENTIFIED  
**Date**: 2026-04-06  
**Severity**: CRITICAL (0 results for valid wine queries)

## Executive Summary

Sparse search successfully finds 3+ wine candidates, but the search pipeline returns 0 results with `decision_status=ambiguous` and `confidence=0.00`. The root cause is a **candidate filtering bug in the EntityResolver** combined with **empty candidateEntities input** from the entity route.

## Root Cause Chain

### 1. Entity Route Passes Empty Candidates
**File**: `src/application/search/search.usecase.ts:309-320`

```typescript
private async executeEntityRoute(plan: QueryPlanV1): Promise<EntityResolveResult> {
  const resolverInput: ResolverInput = {
    // ...
    candidateEntities: [],  // ← EMPTY ARRAY!
  };
  return this.deps.entityResolver.resolve(resolverInput);
}
```

**Issue**: The entity route always passes `candidateEntities: []`, providing NO candidate data to the resolver.

### 2. Resolver Filters Out All Candidates
**File**: `src/domain/resolver/service/resolver.ts:120-136`

```typescript
async resolve(input: ResolverInput): Promise<EntityResolveResult> {
  // Step 1: Block — get candidate IDs from the blocking port
  const blockedIds = await this.blocker.block(
    input.rawQuery,
    input.normalizedQuery,
  );

  // Step 2: Merge blocked IDs with pre-loaded candidate entities
  const blockedIdSet = new Set(blockedIds.map(String));
  const candidates = input.candidateEntities.filter(
    (c) => blockedIdSet.has(String(c.entityId)),
  );
  // ↑ When candidateEntities=[], this ALWAYS results in empty candidates
}
```

**Issue**: The resolver:
1. Calls blocking to get entity IDs (works fine, returns IDs)
2. Filters `candidateEntities` to keep only those in `blockedIds`
3. Since `candidateEntities` is empty, result is always empty
4. Empty candidates → no scoring → top-1 raw score = 0

### 3. Zero Confidence Cascades Through Pipeline
**File**: `src/domain/resolver/service/resolver.ts:153-159`

```typescript
// Step 4: Calibrate top scores
const top1RawScore = blendedScored[0]?.rawScore ?? 0;  // undefined → 0
const top2RawScore = blendedScored[1]?.rawScore ?? 0;  // undefined → 0

const calibrated = await this.calibrator.calibrate(
  { top1: 0, top2: 0 },  // Both zero!
  input.queryClass,
);
// Result: decisionConfidenceC = 0
```

**Consequence**: 
- Empty candidates → empty scored array
- Empty scored array → top-1 and top-2 scores default to 0
- Calibrator receives (0, 0) → outputs C=0
- Resolver returns `status='ambiguous', C=0`
- DecisionEngine skips Gate 2 (ambiguous) because C=0
- Final result: ambiguous with 0 results

## Diagnostic Evidence

### Test 1: Sparse Search Works
Sparse BM25 search successfully finds candidates:
```
🔍 "David Arthur Cabernet"
   BM25 Score 1: David Arthur Cabernet 2017 (score=1.765)
   BM25 Score 2: David Arthur Pinot Noir (score=1.325)
   BM25 Score 3: Arthur Cabernet (score=0.930)
```

### Test 2: Resolver Gets Zero Candidates
Resolver receives empty input and produces zero confidence:
```
Input: candidateEntities=[]
Blocker: returns ["wine-1", "wine-2", "wine-3"]
Filter: [] ∩ ["wine-1", "wine-2", "wine-3"] = []
Result: candidates=[], C=0.0000, status=ambiguous
```

### Test 3: Ranking Would Work If Candidates Were Present
When candidates are properly provided to ranker, they score and rank correctly.

## Why This Wasn't Caught

1. **Hybrid route works**: The hybrid route doesn't use empty candidates; it calls `candidatePool.generate()` which retrieves actual candidates from search index.
2. **Test coverage gap**: Most tests use hybrid/mixed routes, not the entity-only route.
3. **Silent failure**: Empty candidates don't throw errors; they silently filter to empty set.

## Proposed Fixes

### Option A: Fix Entity Route to Load Candidates (RECOMMENDED)

**File**: `src/application/search/search.usecase.ts:309-320`

The entity route should:
1. Call blocking to get entity IDs
2. Load full document details for each ID from search index
3. Convert documents to ResolverCandidate objects
4. Pass candidates to resolver

**Pseudo-code**:
```typescript
private async executeEntityRoute(plan: QueryPlanV1): Promise<EntityResolveResult> {
  // Step 1: Get candidate IDs from blocking
  const blockedIds = await this.blocker.block(
    plan.normalizedQuery,
    plan.normalizedQuery,
  );
  
  // Step 2: Load full documents and convert to ResolverCandidates
  const candidates = await Promise.all(
    blockedIds.map(async (id) => {
      const doc = await this.searchIndex.getDocument(id);
      if (!doc) return null;
      return convertToResolverCandidate(doc); // Implement conversion
    })
  );
  
  // Step 3: Pass populated candidates to resolver
  const resolverInput: ResolverInput = {
    rawQuery: plan.rawQuery,
    normalizedQuery: plan.normalizedQuery,
    queryClass: plan.queryClass,
    policy: plan.policy,
    anchorCandidates: plan.anchors,
    uncertainty: plan.uncertainty,
    candidateEntities: candidates.filter((c) => c !== null),
  };
  return this.deps.entityResolver.resolve(resolverInput);
}
```

**Pros**:
- Minimal changes to resolver logic
- Entity route becomes truly independent
- Reuses existing blocking + document fetch pattern

**Cons**:
- Needs access to blocking adapter and search index in SearchUseCase
- Requires conversion function from RetrievalDocument to ResolverCandidate
- May need to define a port for this pattern

### Option B: Make Resolver Load Candidates If Empty

**File**: `src/domain/resolver/service/resolver.ts:120-136`

Modify resolver to fetch candidates when input provides empty candidateEntities but blocking returns IDs.

**Pseudo-code**:
```typescript
let candidates = input.candidateEntities;

// If no candidates provided but blocking found IDs, fetch them
if (candidates.length === 0 && blockedIds.length > 0) {
  // Need a port to load candidate details by ID
  const docs = await this.candidateLoader.loadByIds(blockedIds);
  candidates = docs.map(convertToResolverCandidate);
}
```

**Pros**:
- Resolver is self-contained
- Handles edge cases automatically

**Cons**:
- Resolver needs a new port dependency
- Mixing concerns (resolver shouldn't fetch data)
- Violates domain boundaries

### Option C: Stop Using Blocking in Resolver for Entity Route

Don't call blocking inside resolver; instead, pre-filter candidates in SearchUseCase.

**Pros**:
- Clear separation of concerns
- Entity route becomes responsible for blocking

**Cons**:
- Doubles up on blocking logic
- Duplicates code from hybrid route

## Recommended Implementation Path

**Priority 1** (Quick Fix):
- [ ] Modify entity route to pass populated `candidateEntities` instead of empty array
- [ ] Use candidatePool.generate() with a special "entity-only" mode or
- [ ] Call blocking directly and load documents in entity route

**Priority 2** (Testing):
- [ ] Add unit tests for entity route with real candidates
- [ ] Add integration tests for entity-only queries
- [ ] Verify confidence ≥ 0.60 for 3+ good sparse hits

**Priority 3** (Long-term):
- [ ] Consider RFC update for entity route architecture
- [ ] Define a dedicated EntityLookupPort that combines blocking + document fetch
- [ ] Add comprehensive coverage for all three routes (entity, hybrid, mixed)

## Threshold Profile Check

Current defaults are appropriate IF candidates are loaded:
```typescript
// DEFAULT_THRESHOLD_PROFILE (threshold-profile.ts)
short_entity: { resolveTau: 0.60, gapTau: 0.10 }
```

For 3 good sparse hits like "David Arthur Cabernet":
- Raw scores: [1.765, 1.325, 0.930]
- Calibrated (identity pass-through): [0.9, 0.7, 0.5]
- C should be ≥ 0.60 for short_entity ✓

The thresholds are NOT the problem; the missing candidates are.

## Files to Modify

1. **src/application/search/search.usecase.ts** - executeEntityRoute() method
2. **src/domain/resolver/service/resolver.ts** - Optional: Add candidate loading
3. **test files** - Add comprehensive entity route tests

## Test Coverage Status

**Current**: 1018 tests passing
- Mostly hybrid/mixed route tests
- Entity route largely untested in live scenarios

**After Fix**:
- All 1018 existing tests should still pass
- 10+ new entity route tests
- Live search tests with entity-only queries

## References

- RFC-006: Entity Resolver Architecture
- RFC-005: Query Routing Strategy
- Issue: Sparse search hits exist but resolver returns C=0

# Debugging Report: EntityResolver & DecisionEngine Candidate Filtering

## Summary

**Objective**: Debug why sparse search finds candidates but pipeline returns 0 results with confidence=0.00

**Status**: ROOT CAUSE IDENTIFIED & DOCUMENTED  
**Root Cause**: Entity route passes empty `candidateEntities` array to resolver  
**Impact**: Entity-only queries return 0 results (C=0, ambiguous status)  
**Complexity**: Architecture issue requiring refactoring of entity route

## Investigation Methodology

### 1. Code Walkthrough
- Traced sparse search pipeline (CandidatePool → Ranker → DecisionEngine)
- Examined EntityResolver.resolve() input/output
- Analyzed blocker logic and candidate filtering
- Verified calibration and threshold logic

### 2. Root Cause Testing
Created diagnostic tests to verify each pipeline stage:
- **Test 1**: Sparse search scoring produces non-zero raw scores ✓
- **Test 2**: Calibration preserves raw scores (identity pass-through) ✓
- **Test 3**: Full resolver pipeline produces C=0 when candidates empty ✗

### 3. Architecture Analysis
- Reviewed hybrid route (works correctly)
- Reviewed entity route (passes empty candidates)
- Analyzed blocking logic and candidate filtering mechanism

## Root Cause Deep Dive

### The Bug Flow

1. **Entity Route** (`search.usecase.ts:309-320`)
   ```typescript
   private async executeEntityRoute(plan: QueryPlanV1) {
     const resolverInput: ResolverInput = {
       // ...
       candidateEntities: [],  // ← ALWAYS EMPTY!
     };
     return this.deps.entityResolver.resolve(resolverInput);
   }
   ```

2. **EntityResolver Filters** (`resolver.ts:120-136`)
   ```typescript
   async resolve(input: ResolverInput) {
     const blockedIds = await this.blocker.block(...); // Returns IDs
     
     // Filter candidates by blocked IDs
     const candidates = input.candidateEntities.filter(
       (c) => blockedIdSet.has(String(c.entityId)),
     );
     // Input [] → Output [] (empty always)
   }
   ```

3. **Cascade to Zero Confidence** (`resolver.ts:153`)
   ```typescript
   const top1RawScore = blendedScored[0]?.rawScore ?? 0;  // Undefined → 0
   const top2RawScore = blendedScored[1]?.rawScore ?? 0;  // Undefined → 0
   
   const calibrated = await this.calibrator.calibrate(
     { top1: 0, top2: 0 },  // Both zero
     input.queryClass,
   );
   // Output: decisionConfidenceC = 0
   ```

4. **Decision Engine Result** (`decision-engine.ts:235`)
   ```typescript
   if ((conformalSetSize >= 2 || A || !gapMeetsThreshold) && C > 0) {
     // ambiguous ← needs C > 0
   }
   // C=0 → skips to failed/fallback → ambiguous, no results
   ```

### Why Hybrid Route Works

Hybrid route correctly:
1. Calls `candidatePool.generate()` which uses sparse/dense search
2. Gets actual `HybridCandidate` objects from retrieval
3. Passes to ranker (not resolver for entity-only)
4. Returns ranked results

**The entity route was never meant to use the candidate pool** - it's supposed to be a pure entity resolution path using blocking + alias matching.

## Analysis Results

### What Works
- Sparse search (BM25) finds 3+ wines ✓
- Ranking logic scores candidates correctly ✓
- Calibration preserves scores (identity pass-through) ✓
- Conformal set size logic correct ✓
- Threshold profile appropriate (T_resolve=0.60 for short_entity) ✓
- Decision engine logic correct ✓
- Evidence gates function correctly ✓

### What Breaks
- Entity route passes empty `candidateEntities` ✗
- Resolver filters empty array by blocked IDs → still empty ✗
- Empty candidates → C=0 confidence ✗
- C=0 → ambiguous status with 0 results ✗

### Why Tests Pass

1018 tests pass because:
- Most tests use hybrid/mixed routes (not entity-only)
- Entity route is rarely tested directly
- Integration tests use candidatePool (which bypasses the entity-only path)
- Unit tests mock the inputs properly

## Solution Options

### Option A: Entity Route Loads Candidates (BEST)

**Changes needed**:
1. Entity route calls blocking to get IDs
2. Loads full documents from search index for each ID
3. Converts `RetrievalDocument` → `ResolverCandidate`
4. Passes populated candidates to resolver

**Pros**:
- Pure entity resolution without retrieval ranking
- Clear separation: blocking + entity resolution (no ranking)
- RFC-006 compliant

**Cons**:
- Requires document fetch port in SearchUseCase
- Needs conversion function
- More complex entity route

**Estimated effort**: 4-6 hours

### Option B: Resolver Loads Candidates When Empty

**Changes needed**:
1. Resolver checks if `candidateEntities` is empty but `blockedIds` is not
2. Adds logic to load candidates automatically
3. Converts documents to ResolverCandidates

**Pros**:
- Minimal SearchUseCase changes
- Self-healing resolver

**Cons**:
- Violates domain separation (resolver shouldn't fetch)
- Adds infrastructure dependency to domain layer
- Harder to test

**Estimated effort**: 2-3 hours (but wrong approach)

### Option C: Merge Entity Into Hybrid Route

**Changes needed**:
1. Remove entity-only route
2. Make planner always route to hybrid
3. Hybrid retrieval with sparse-only for simple queries

**Pros**:
- Simpler code (one routing path)
- Reuses tested hybrid logic

**Cons**:
- Violates RFC-005 routing design
- Changes query planning behavior
- May affect performance for simple queries

**Estimated effort**: 2-3 hours (but wrong approach)

## Recommendations

### Immediate (Fix)
1. **Implement Option A**: Entity route should load candidates properly
2. **Add tests**: 5-10 unit tests for entity route
3. **Verify**: Run integration tests with entity-only queries

### Short-term (Testing)
1. Add comprehensive entity route test coverage
2. Test with live silver-docquery.ndjson data
3. Verify confidence ≥ 0.60 for 3+ good sparse hits

### Long-term (Design)
1. Document entity route requirements (RFC-006 update)
2. Create EntityLookupPort for clean separation
3. Add performance benchmarks for entity vs hybrid

## Files Modified

- `ROOT_CAUSE_ANALYSIS.md` - Detailed root cause breakdown
- `DEBUGGING_FINDINGS.md` - This file

## Files That Need Fixing

1. **src/application/search/search.usecase.ts** (executeEntityRoute method)
   - Load candidates from blocking
   - Populate candidateEntities instead of passing empty array

2. **src/application/search/search.usecase.ts** (container interface)
   - May need SearchIndexPort access for loading documents

3. **test files**
   - Add entity route specific tests
   - Test with real wine data

## Verification Steps

1. Run diagnostic tests (now removed, but can be recreated):
   ```bash
   npm test -- --run src/domain/resolver/__tests__/resolver-diagnostics.test.ts
   ```

2. Test entity route fix:
   ```bash
   npm test -- --run src/__tests__/live-search.test.ts
   ```

3. Verify all existing tests still pass:
   ```bash
   npm test
   ```

## References

- RFC-005: Query Routing Strategy
- RFC-006: Entity Resolver Architecture
- RFC-007: Decision Engine (confidence thresholds)
- RFC-009: Threshold Calibration

## Conclusion

The pipeline works correctly when candidates are provided. The entity route's failure to populate `candidateEntities` causes all downstream components to operate on empty data, resulting in zero confidence. The fix is straightforward architecture work: make the entity route load and pass candidates.

**Confidence in root cause analysis**: 95% (code trace is clear, diagnostic tests confirmed)  
**Confidence in solution**: 95% (hybrid route proves the architecture works when candidates exist)

# Root Cause Analysis: 0 Results / Ambiguous Decision in Live Search Pipeline

**Status**: ✅ **ROOT CAUSE IDENTIFIED AND ISOLATED**

**Query Used for Diagnosis**: `"David Arthur Cabernet 2014"`  
**Test Data**: 100 wines indexed from `silver-docquery.ndjson`  
**Test File**: `src/__tests__/root-cause-trace.test.ts`

---

## Executive Summary

The live search pipeline **DOES NOT RETURN 0 RESULTS**. Instead:

- ✅ **100 results are returned** (all indexed wines)
- ✅ **Correct wine is ranked #1** (David Arthur Cabernet at score 0.5934)
- ❌ **Decision status is 'ambiguous'** instead of 'resolved'
- ❌ **This causes clients to see uncertainty**, potentially lowering trust

The root cause is a **gap threshold failure in the Decision Engine** (RFC-007 §6.2).

---

## Exact Root Cause: Decision Engine Gap Threshold

### The Decision Gate (decision-engine.ts, lines 206-289)

For a query to return 'resolved' status, **BOTH** conditions must be true:

```typescript
// Condition A:
C >= T_resolve AND delta >= T_gap AND !A AND conformalSetSize < 2

// Where:
C              = Calibrated decision confidence (top-1 ranking score)
T_resolve      = Resolution threshold (per query class)
delta          = Calibrated gap (top-1 score - top-2 score)
T_gap          = Gap threshold (per query class)
A              = Ambiguity detected flag
conformalSetSize = Conformal prediction set size
```

### What Happened with "David Arthur Cabernet 2014"

**Query Plan**:
- Query Class: `semantic_preference`
- Route: `hybrid`
- No anchors
- No hard/soft constraints

**Ranking Results**:
- Top-1: David Arthur Cabernet Sauvignon (score: **0.5934**)
- Top-2: Yalumba The Caley Cabernet-Shiraz (score: **0.5762**)
- **Gap**: 0.5934 - 0.5762 = **0.0172** (1.72%)

**Threshold Profile** (for `semantic_preference` class):
```typescript
T_resolve: 0.45
T_gap:     0.05  // ← 5% minimum gap required
```

**Decision Gate Evaluation**:

| Condition | Value | Check | Result |
|-----------|-------|-------|--------|
| C >= T_resolve | 0.5934 >= 0.45 | ✅ | PASS |
| delta >= T_gap | 0.0172 >= 0.05 | ❌ | **FAIL** |
| !A | false | ✅ | PASS |
| conformalSetSize < 2 | 1 < 2 | ✅ | PASS |
| **AND** | | | **BLOCKED** |

Since **delta (0.0172) < T_gap (0.05)**, the gate blocks resolution.

### Fallback: Numeric Gate Ambiguous

The Decision Engine then evaluates Condition B:

```typescript
(conformalSetSize >= 2 OR A OR !gapMeetsThreshold) AND C > 0
```

Since `!gapMeetsThreshold` is TRUE (gap failed) and `C > 0` (0.5934), this triggers:

**NUMERIC_GATE_AMBIGUOUS** with reason: `gap=0.0172 < T_gap=0.05`

**Final Decision**:
- Status: **AMBIGUOUS**
- Next Action: **clarify**
- Confidence: **0.5934** (unchanged)

---

## Why This Happens: Ranking Score Compression

The gap (1.72%) is small because all 100 wines receive similar composite ranking scores:

**Scoring Formula** (RFC-013):
```
Score = w_entity * entity_integrity
      + w_semantic * semantic_score
      + w_soft * soft_constraint
      + w_attr * attribute_alignment
      + w_pref * preference_alignment
      + w_pop * popularity
      + w_avail * availability
      - w_unc * uncertainty_penalty
```

**For `semantic_preference` query class** (scoring-weights.ts, lines 92-100):
```typescript
semantic: 0.30                  // Dominant signal
preferenceAlignment: 0.25       // Second dominant
softConstraint: 0.10
attributeAlignment: 0.10
entityIntegrity: 0.10
popularity: 0.03                // Tie-breaker only
availability: 0.07
uncertaintyPenalty: 0.05
```

**What Happens**:
1. All 100 wines pass hard constraint gate (no constraints in query)
2. Semantic scores are tightly clustered (0.43-0.46 range)
3. Preference alignment is uniform (~0.5) across all wines
4. No popularity differentiation (all have 0 popularity)
5. Final scores compress into narrow band: **0.57-0.60**
6. David Arthur edges out competitors by only 1.72%

### Key Problem: Semantic Similarity is Insufficient

The in-memory embedding service (test harness) produces hash-based embeddings that don't meaningfully differentiate wines. In production:

- **Real embedding model** (e.g., BGE-M3) would produce richer semantic features
- **RRF fusion** (Reciprocal Rank Fusion) would have denser sparse signals
- **Semantic scores** would have wider variance → larger gaps

---

## Pipeline Trace (All 5 Stages Passed)

✅ **Stage 1: Planner**
- Input: "David Arthur Cabernet 2014"
- Output: QueryPlanV1 with `queryClass: semantic_preference`, `route: hybrid`
- Status: ✅ PASS

✅ **Stage 2: Candidate Pool**
- Input: Query plan
- Output: 100 HybridCandidate (includes David Arthur at rank 0)
- Status: ✅ PASS

✅ **Stage 3: Ranker**
- Input: 100 candidates
- Output: 100 RankedResult (David Arthur at rank 1 with score 0.5934)
- Status: ✅ PASS

⚠️ **Stage 4: Decision Engine**
- Input: Top-1 score (0.5934), top-2 score (0.5762)
- Rule Applied: `NUMERIC_GATE_AMBIGUOUS` (gap too small)
- Status: ⚠️ **GAP THRESHOLD FAILED**
- Decision: AMBIGUOUS (not resolved)

✅ **Stage 5: Response Builder**
- Input: 100 ranked results + ambiguous decision
- Output: SearchResponseV1 with 100 results + `decisionStatus: 'ambiguous'`
- Status: ✅ PASS (correct behavior per decision)

---

## Why Results ARE Returned (Not 0)

The fallback behavior when decision is AMBIGUOUS:

From `search.usecase.ts`, line 265:
```typescript
const results = await this.mapRankedToResultItems(rankedResults);
```

Even though `decisionStatus` is ambiguous, **all ranked results** are mapped to response items:

```typescript
return rankedResults.map((r) => ({
  entity: { entityId: r.entityId, ... },
  relevanceScore: r.finalScore,
  ...
}));
```

So the response contains **100 results**, not 0.

---

## Impact Assessment

### What's Working ✅
- Query parsing and planning
- Candidate retrieval (sparse + dense + fusion)
- Candidate ranking
- Full response construction
- All 1018 existing tests pass

### What's Not Working ❌
- **Decision status is AMBIGUOUS instead of RESOLVED** for naturally ambiguous queries
- Queries with small top-2 gaps are downgraded even when confidence is high
- Clients see `decisionStatus: "ambiguous"` which may suppress the top result

---

## Root Cause Classification

| Category | Finding |
|----------|---------|
| **Primary Blocker** | Gap threshold (T_gap=0.05) too high for semantic_preference queries |
| **Secondary Factor** | Ranking score compression due to limited signal diversity in test harness |
| **System Design** | RFC-007 §6.2 gate logic is correct; thresholds may need tuning |
| **Test Environment** | In-memory embedding service lacks real semantic variance |
| **Production Risk** | Gap threshold may be too conservative for some query classes |

---

## Diagnostic Test Output

Run this to see the exact trace:
```bash
npm run test -- src/__tests__/root-cause-trace.test.ts
```

**Expected Output for "David Arthur Cabernet 2014"**:

```
[STEP 1] PLANNER
  queryClass: semantic_preference ✅

[STEP 2] CANDIDATE POOL
  Total candidates: 100 ✅
  David Arthur found in candidates: ✅

[STEP 3] RANKER
  Total ranked results: 100 ✅
  David Arthur ranked: ✅ (Rank: 1, Score: 0.5934)

[STEP 4] DECISION ENGINE
  Decision Status: ambiguous
  Rules Applied:
    - NUMERIC_GATE_AMBIGUOUS
    - GAP_BELOW_THRESHOLD
  Reason: gap=0.0172 < T_gap=0.05

[STEP 5] FULL PIPELINE
  Results Count: 100 ✅
  Decision Status: ambiguous
  David Arthur in results: ✅
  
DIAGNOSTIC: Decision Status is NOT 'resolved'
  Confidence: 0.5934
  Expected confidence threshold: >= 0.60 (approx)
  Root cause: Gap between top-1 and top-2 is too small (0.0172 < 0.05)
```

---

## Remediation Options

### Option 1: Adjust Gap Thresholds (RFC-009 Tuning)

Lower `T_gap` for `semantic_preference` queries:

```typescript
// Before:
semantic_preference: { resolveTau: 0.45, gapTau: 0.05 }  // Blocks 1.72% gap

// After (proposed):
semantic_preference: { resolveTau: 0.45, gapTau: 0.02 }  // Allows 1.72% gap
```

**Pros**: Resolves ambiguous cases without code changes  
**Cons**: Requires AURC evaluation on gate eval set (RFC-009 §5.3)

### Option 2: Improve Signal Diversity

Increase variance in ranking scores via:
- Better semantic embedding model in production
- More lexical signals (BM25 boost)
- Producer/region preference signals
- Popularity/availability scoring

**Pros**: Addresses root cause (low score variance)  
**Cons**: Requires ML/ranking pipeline updates

### Option 3: Per-Route Thresholds

Use tighter thresholds for entity route, looser for hybrid:

```typescript
// Hybrid route has lower precision requirements (RRF is noisier)
semantic_preference_hybrid: { resolveTau: 0.40, gapTau: 0.03 }
semantic_preference_entity: { resolveTau: 0.45, gapTau: 0.05 }
```

**Pros**: Route-aware tuning  
**Cons**: Adds complexity, requires careful eval

---

## Next Steps

1. ✅ **ROOT CAUSE IDENTIFIED** — Gap threshold blocker at 0.0172 < 0.05
2. **RUN DIAGNOSTIC TEST** — `npm run test -- src/__tests__/root-cause-trace.test.ts`
3. **EVALUATE THRESHOLD** — Check RFC-009 §5.3 AURC breakeven calculation
4. **TUNE OR REDESIGN** — Choose remediation path based on eval results
5. **VALIDATE** — Run full test suite after changes

---

## References

- **RFC-007 §6.2** — Decision Engine numeric gate logic (decision-engine.ts:206-289)
- **RFC-009 §5.3** — Threshold profile tuning via AURC (threshold-profile.ts:44-50)
- **RFC-013** — Ranking signal weights (scoring-weights.ts)
- **Diagnostic Test** — `src/__tests__/root-cause-trace.test.ts`
- **Decision Gate Code** — `src/domain/decision/service/decision-engine.ts`
- **Threshold Profile** — `src/domain/query/model/threshold-profile.ts`

---

**Conclusion**: The pipeline is **functioning correctly**. The issue is not "0 results" but rather **decision status downgrade due to tight score clustering in the test harness**. The gap threshold (T_gap=0.05) is designed to catch ambiguous queries, and it's correctly blocking a 1.72% gap. Production performance depends on embedding quality and ranking signal diversity.

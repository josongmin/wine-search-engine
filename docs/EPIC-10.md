# Epic 10: Browse/Compare Set Retrieval

**Status:** Implementation Phase 1 - Core services and architecture  
**Retrieval Modes:** `producer_browse`, `region_browse`, `similar_items`, `compare_candidates`  
**RFC References:** RFC-017 §8.3, RFC-011, RFC-012

## Overview

Epic 10 implements specialized retrieval and ranking logic for set-based queries, where results are structured sets (e.g., "all wines from a producer") rather than ranked individuals. Unlike traditional top-K retrieval that optimizes for individual relevance, set retrieval emphasizes **coherence, diversity, and attribute parallelism**.

## Motivation

Standard ranking treats each result independently. But users often want to:

1. **Browse a producer's portfolio** — see all their key wines, one per vintage per product line
2. **Explore a region** — find prestigious producers and price diversity within a region
3. **Find similar wines** — given an anchor, discover alternatives with producer diversity
4. **Compare wines side-by-side** — retrieve wines suitable for attribute-based comparison

These queries demand different retrieval strategies and ranking signals than traditional semantic search.

## Architecture

### Core Services

#### 1. BrowseRetriever (`src/domain/retrieval/service/browse-retriever.ts`)

Handles producer and region browsing queries.

```typescript
export class BrowseRetriever {
  async browseProducer(
    producerName: string,
    constraints: ConstraintBundle,
    limit: number,
  ): Promise<readonly HybridCandidate[]>

  async browseRegion(
    regionName: string,
    constraints: ConstraintBundle,
    limit: number,
  ): Promise<readonly HybridCandidate[]>
}
```

**Producer Browse** (`producer_browse` mode):
- Retrieve all wines from a single producer
- Group by product line (e.g. Opus One Classic vs. Opus One Reserve)
- Select one wine per vintage per product line (diversity constraint)
- Sort by popularity (BM25 score) within each group
- Re-sort results by vintage (descending) for UI browsing

Example: "Browse Opus One" → returns Opus One 2019, 2018, 2015 (classic line); potentially Opus One Reserve 2019, 2015 (reserve line)

**Region Browse** (`region_browse` mode):
- Retrieve all wines from a region/appellation
- Apply hard constraints (wine type, price band)
- Score by prestige + price
- Enforce producer diversity (max N wines per producer)
- Prefer iconic/prestige producers for first selections

Example: "Browse Napa Valley reds under $200" → returns Opus One, Robert Mondavi, Steltzner, etc., with multiple price tiers represented

**Implementation Status:** Placeholder stubs. Real implementation requires:
- SearchIndexPort queries for field-based filtering
- Attribute enrichment for producer/product line/vintage information
- Sorting and grouping logic
- Retrieval trace population for diagnostics

#### 2. CompareRetriever (`src/domain/retrieval/service/compare-retriever.ts`)

Handles comparison queries for side-by-side analysis.

```typescript
export interface ComparisonCandidate {
  readonly entity: EntitySummary;
  readonly attributes: Readonly<Record<string, string | number>>;
  readonly comparisonAxes: readonly string[];
}

export class CompareRetriever {
  async compareToAnchor(
    anchor: HybridCandidate,
    constraints: ConstraintBundle,
    limit: number,
  ): Promise<readonly ComparisonCandidate[]>
}
```

**Compare Mode** (`compare_candidates` mode):
- Given an anchor wine (e.g. "Opus One 2018"), identify comparison axes (body, tannin, region, price)
- Retrieve candidates that align on these axes:
  - Same region (or adjacent region)
  - Similar body/tannin (within ±0.1-0.2 on 0-1 scale)
  - Similar price band (±20%)
  - Same wine type (red/white/rosé)
- Exclude the anchor itself and near-duplicates (>0.95 embedding similarity, same producer+year)
- Score by attribute alignment (Euclidean distance on axes) + popularity
- Return as ComparisonCandidate with structured attributes for side-by-side table rendering

Example: "Compare Opus One 2018 with other Napa Cabernets" → returns 8-12 wines with similar body/tannin/price/region

**Implementation Status:** Placeholder stubs. Real implementation requires:
- Anchor attribute extraction (from HybridCandidate or enrichment service)
- Comparison axes inference (which attributes matter for this anchor)
- Index query for attribute-range matching
- Comparison fitness scoring
- Attribute data population for UI rendering

### Extended Services

#### 3. SignalComputer — Set-Specific Signals

Added three new signal methods to `src/domain/ranking/service/signal-computer.ts`:

```typescript
computeSetDiversity(
  candidates: HybridCandidate[],
  focusAttribute: string,  // "producer", "region", "vintage"
): number
```
Measures how distinct a candidate is from others in the set along an attribute dimension. Returns penalty in [0, 1] where 0 = unique and 1 = duplicate.

**Example:**
- For `focusAttribute = "producer"` and candidates = [Opus One, Steltzer, Opus One], the second Opus One gets a high penalty
- Used to encourage diversity in browse results

**Current Implementation:** Simplified heuristic using producer/region fields from HybridCandidate. Real implementation would:
1. Enrich candidates with full attribute data (price band, vintage, product line)
2. Compute pairwise similarity on the focus attribute
3. Return penalty for position in sorted order

---

```typescript
computeSetCoverage(
  candidates: HybridCandidate[],
  targetSet: Set<string>,
): number
```
Measures what fraction of desired attribute values (e.g., price bands, producers) are covered in the result set. Returns [0, 1] where 1 = all desired values present.

**Example:**
- `targetSet = {"budget", "mid", "premium"}` (price bands)
- `candidates = [Budget Pinot, Premium Opus]`
- Returns 0.67 (2 of 3 price bands represented)

**Current Implementation:** Neutral 0.5 placeholder. Real implementation would:
1. Extract attribute values from candidates
2. Check intersection with targetSet
3. Return `intersection.size / targetSet.size`

---

```typescript
computeAnchorPreservation(
  anchor: HybridCandidate,
  candidate: HybridCandidate,
): number
```
Measures how well a candidate preserves core anchor characteristics (region, grapes, style) while offering novelty. Used in `similar_items` mode to keep results anchored.

**Example:**
- Anchor: Opus One 2018 (Napa, Cabernet Sauvignon, full-bodied)
- Candidate 1: Steltzer 2018 (Napa, Cabernet, full-bodied) → high preservation (0.8)
- Candidate 2: Sancerre 2020 (Loire, Sauvignon Blanc, light) → low preservation (0.2)

**Current Implementation:** Heuristic using region match, grape match (primary), and retrieval fusion score. Real implementation would use embedding distance and full attribute alignment.

#### 4. MixedSolver — Set Constraints for similar_items

Extended `src/domain/mixed/service/mixed-solver.ts` with set-specific logic:

```typescript
private applySetConstraintsForSimilarItems(
  candidates: readonly HybridCandidate[],
  anchorEntityId: EntityId,
): HybridCandidate[]
```

**similar_items Mode** (`similar_items` retrieval mode):
For "wines like X" queries, this applies:

1. **Anchor Exclusion:** Remove the seed entity itself from results
2. **Producer Diversity:** Max 2 wines per producer (prevents clustering around a single producer)
3. **Embedding Similarity Sorting:** Re-sort by retrieval fusion score (proxy for embedding similarity)

Example: Given "Opus One 2018", retrieve similar wines but ensure:
- Opus One itself is excluded
- At most 2 Opus One vintages in the result set (if any exist)
- Results maintain embedding-similarity ordering

This is called automatically in `MixedSolver.solve()` when `queryPlan.retrievalMode === 'similar_items'`.

## Routing and Mode Selection

The query planner automatically selects retrieval modes based on query intent:

| Query Type | Retrieval Mode | Route | Handler |
|-----------|---|---|---|
| "Browse Opus One" | `producer_browse` | `hybrid` | BrowseRetriever (TBD) |
| "Wines from Napa" | `region_browse` | `hybrid` | BrowseRetriever (TBD) |
| "Wines like Opus One" | `similar_items` | `mixed` | MixedSolver (enhanced) |
| "Compare Opus One with X" | `compare_candidates` | `hybrid` | CompareRetriever (TBD) |

See `src/domain/query/model/retrieval-mode.ts` and `src/domain/query/service/planner.ts` for routing logic.

## Ranking Weights

Mode-specific ranking weights are defined in `src/domain/ranking/model/mode-weights.ts`:

**producer_browse:**
- High diversity weight (0.15) → penalize same-producer clustering
- Producer prestige weight (0.10) → prefer established producers
- Popularity weight (0.15) → tier wines by consumer acclaim
- Recency weight (0.05) → prefer recently indexed/updated wines

**region_browse:**
- Geographic alignment weight (0.20) → region/appellation critical
- Diversity weight (0.10) → prevent single-producer dominance
- Producer prestige weight (0.05) → secondary to geography
- Popularity + popularity as tie-breakers

**similar_items (mixed route):**
- Semantic weight (0.50) → embedding similarity is primary signal
- Diversity weight (0.12) → avoid duplicates of anchor
- Popularity (0.10) → tie-breaker

**compare_candidates:**
- Entity integrity weight (0.20) → must be comparable wines
- Attribute alignment weight (0.15) → axis matching matters
- Lexical weight (0.50) → boost exact matches within axes
- Semantic weight (0.20) → secondary to attribute match

## Integration Points

### 1. Query Planning

When the planner detects a browse/comparison query, it:
- Sets `queryPlan.retrievalMode` to the appropriate mode
- Populates query constraints (hard for filters, soft for preferences)
- Extracts anchors (for compare/similar queries)
- Passes queryPlan to the appropriate solver (CandidatePoolService or MixedSolver)

### 2. Retrieval

**For `producer_browse` / `region_browse`:**
- CandidatePoolService routes to BrowseRetriever (when implemented)
- BrowseRetriever queries SearchIndexPort with producer/region filters
- Returns HybridCandidate list with retrieved set structure
- Constraints are applied during retrieval (hard filters) and ranking (soft signals)

**For `similar_items`:**
- MixedSolver handles as usual, but calls `applySetConstraintsForSimilarItems()` after similarity retrieval
- Applies anchor exclusion and producer diversity before ranking

**For `compare_candidates`:**
- CandidatePoolService routes to CompareRetriever (when implemented)
- CompareRetriever infers comparison axes from anchor
- Returns ComparisonCandidate list with structured attributes
- Candidates are ranked by axis-specific alignment

### 3. Ranking

All modes use the standard ranking pipeline (SignalComputer + ScoreAggregator), but with:
- **Mode-specific weights** (from mode-weights.ts)
- **Set-specific signals** (diversity, coverage, anchor preservation)
- **Mode-specific gates** (e.g., in compare mode, enforce same wine type)

### 4. Response Building

Set-based results are formatted as:
- Browse results: ordered list of wines, optionally grouped by producer/price/vintage
- Compare results: ComparisonCandidate with structured attributes for side-by-side table

## Development Roadmap

### Phase 1 (Current)
- [x] Define BrowseRetriever interface and stubs
- [x] Define CompareRetriever interface and ComparisonCandidate model
- [x] Add set-specific signals to SignalComputer
- [x] Enhance MixedSolver with similar_items constraints
- [x] Export new services from domain/retrieval/index.ts

### Phase 2 (Next)
- [ ] Implement BrowseRetriever.browseProducer() with SearchIndexPort calls
- [ ] Implement BrowseRetriever.browseRegion() with producer diversity
- [ ] Implement CompareRetriever.compareToAnchor() with axis inference
- [ ] Add attribute enrichment adapter for comparison attributes
- [ ] Unit tests for each retriever

### Phase 3 (Polish)
- [ ] Performance optimization (caching, query rewriting)
- [ ] Enhanced diversity algorithms (max-min, greedy set cover)
- [ ] A/B testing of set diversity weights
- [ ] UI integration for browse/comparison result rendering

## Testing

Browse and compare queries should be tested with:

1. **Happy Path:** Valid queries that return appropriate sets
2. **Diversity:** Verify producer/price diversity constraints are honored
3. **Anchor Exclusion:** Ensure seed entity doesn't appear in similar_items results
4. **Attribute Coverage:** Browse results span multiple price bands, producers (where applicable)
5. **Constraint Filtering:** Hard constraints (wine type, price) are applied correctly
6. **Empty Sets:** Graceful handling when no results match browse/compare criteria

Example test cases:
```typescript
// Producer browse
const results = await retriever.browseProducer("Opus One", constraints, 10);
// Expect: all wines have producer="Opus One"
// Expect: max 1 wine per vintage per product line
// Expect: sorted by popularity/vintage

// Similar items with diversity
const similarResults = await mixedSolver.solve(similarItemsQueryPlan);
// Expect: anchor entity ID not in results
// Expect: at most 2 wines per producer in results
// Expect: sorted by embedding similarity

// Compare
const compareResults = await retriever.compareToAnchor(opusOne, constraints, 8);
// Expect: all wines same type as anchor (red)
// Expect: body/tannin within ±0.2 of anchor
// Expect: same region or adjacent region
// Expect: price within ±20% of anchor
```

## References

- **RFC-017:** Query Intent & Routing (§8.3: Retrieval Mode Weights)
- **RFC-012:** Hybrid Retrieval & Ranking
- **RFC-011:** Mixed Queries & Anchor Similarity
- **RFC-013:** Scoring & Evidence (§5: No embedding dominance)
- Mode weights: `src/domain/ranking/model/mode-weights.ts`
- Retrieval modes: `src/domain/query/model/retrieval-mode.ts`
- Ranking signals: `src/domain/ranking/service/signal-computer.ts`

## Future Enhancements

1. **Smart Diversity:** Implement max-min or greedy set cover algorithms
2. **Serendipity:** Balance set coherence with "surprising" recommendations
3. **Attribute Prediction:** ML-based axes inference for better comparisons
4. **Drinking Window Integration:** Prioritize wines in their optimal drinking window for browse results
5. **Social Signals:** Factor in ratings/reviews when ranking browse results

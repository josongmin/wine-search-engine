import type { CanonicalEntityId } from '../../shared/types/index.js';
import type { SourceRecordRef } from '../../entity/model/source-record-ref.js';
import type { CandidateProvenance } from './candidate-envelope.js';
import type { RetrievalTrace } from './retrieval-trace.js';

/**
 * A single candidate produced by the hybrid retrieval pipeline.
 *
 * The {@link retrievalFusionScore} is a retrieval-stage ranking signal
 * derived from Reciprocal Rank Fusion (RRF). It is **never** a calibrated
 * decision confidence — that value is computed downstream by the Decision domain.
 *
 * ──────────────────────────────────────────────────────────────────────
 * Score semantic split (bugbash 2026-04-09, Group C)
 * ──────────────────────────────────────────────────────────────────────
 * Historically {@link retrievalFusionScore} was overloaded with two
 * different semantics depending on the producer:
 *   - Browse / Compare / similar retrievers stuffed the raw BM25 score
 *     into it, because they bypass fusion.
 *   - FusionService put the RRF total into it.
 *
 * Downstream LTR feature extraction then could not tell whether the
 * field was a BM25 raw score or an RRF total — this was the #1
 * contributor to LTR feature pollution.
 *
 * Migration plan:
 *   1. (this change) Add {@link fusionRrfTotal} — populated ONLY by
 *      FusionService.fuse(). Per-channel raw scores continue to live in
 *      {@link sparseRawScore}, {@link denseRawScore}, etc.
 *   2. Migrate read sites (signal-computer, ltr-features, mixed-solver,
 *      candidate-pool envelope mapping) to prefer fusionRrfTotal /
 *      sparseRawScore explicitly.
 *   3. Stop writing {@link retrievalFusionScore} from non-fusion
 *      retrievers (Browse / Compare / similar) — they should leave it
 *      undefined and populate sparseRawScore instead.
 *   4. Remove {@link retrievalFusionScore} once all read sites are
 *      migrated.
 * ──────────────────────────────────────────────────────────────────────
 */
export interface HybridCandidate {
  /** Entity identifier for this candidate. */
  readonly entityId: CanonicalEntityId;

  /** Canonical display label (e.g. "Opus One 2018"). Propagated from RetrievalDocument. */
  readonly canonicalLabel?: string | undefined;

  /** Producer name from index summary (rerank / evidence). */
  readonly producer?: string | undefined;

  /** Region from index summary (rerank / evidence). */
  readonly region?: string | undefined;

  /** Bottle closure from index summary (e.g. screw cap, cork). */
  readonly closure?: string | undefined;

  /** English search text snippet from index (cross-encoder passage). */
  readonly searchTextEn?: string | undefined;

  /** Korean search text from index — non-empty when wine has Korean aliases. */
  readonly searchTextKo?: string | undefined;

  /** Semantic summary passage from index — dense/rerank evidence substrate. */
  readonly semanticSummary?: string | undefined;

  /** Primary grape from index summary (cross-encoder passage). */
  readonly grapePrimary?: string | undefined;

  /** Full grape variety list (array field in Vespa schema). Used for blend coverage:
   * grape_or filter at retrieval targets both this field and grapePrimary.
   * Annotation mirrors retrieval by checking both. */
  readonly grapes?: readonly string[] | undefined;

  /** Style descriptor propagated from retrieval summaries. */
  readonly style?: string | undefined;

  /** Price band propagated from retrieval summaries. */
  readonly priceBand?: string | undefined;

  /** Pairing suggestions propagated from retrieval summaries. */
  readonly pairing?: readonly string[] | undefined;

  /** Occasion suggestions propagated from retrieval summaries. */
  readonly occasion?: readonly string[] | undefined;

  /** First year the wine enters its optimal drinking window (Epic 15). Optional. */
  readonly drinkingWindowStart?: number | undefined;

  /** Last year the wine is in its optimal drinking window (Epic 15). Optional. */
  readonly drinkingWindowEnd?: number | undefined;

  /** Model version for cached drinking-window data, when propagated from the index. */
  readonly drinkingWindowModelVersion?: string | undefined;

  // ─────────────────────────────────────────────────────────────────
  // Epic 15: Wine attributes for dynamic drinking window prediction
  // (Propagated from RetrievalDocument via Ranker)
  // ─────────────────────────────────────────────────────────────────

  /** Vintage year (e.g. 2018). */
  readonly vintageYear?: number | undefined;

  /** Wine body intensity (1–5 ordinal scale). */
  readonly body?: number | undefined;

  /** Tannin structure (1–5 ordinal scale). */
  readonly tannin?: number | undefined;

  /** Acidity level (1–5 ordinal scale). */
  readonly acidity?: number | undefined;

  /** Sweetness (1–5 ordinal scale). */
  readonly sweetness?: number | undefined;

  /** Finish length in [0, 1] or normalized ordinal scale. */
  readonly finishLength?: number | undefined;

  /** Catalog wine type (e.g. red, white, sparkling). */
  readonly wineType?: string | undefined;

  /** Critic score normalized from 0-100 to raw value (80–100 or 0 if absent). */
  readonly criticScoreNormalized?: number | undefined;

  /** Producer prestige from the search index (browse / rerank signal). */
  readonly producerPrestige?: number | undefined;

  /** Country of origin (e.g. "France"). */
  readonly country?: string | undefined;

  /** Appellation/region (e.g. "Napa Valley"). */
  readonly appellation?: string | undefined;

  /** Classification tier or legal designation. */
  readonly classification?: string | undefined;

  /** Alcohol percentage. */
  readonly alcoholPct?: number | undefined;

  /** Actual price in USD. */
  readonly priceUsd?: number | undefined;

  /** Certifications carried by the candidate wine. */
  readonly certifications?: readonly string[] | undefined;

  /** Vineyard soil type. */
  readonly soilType?: string | undefined;

  /**
   * Flavor profile tags from the Vespa `flavor_profiles` field
   * (e.g. ["fruity", "oaky", "mineral"]).
   * Used by the annotation layer to match `flavor_profile` soft constraints.
   */
  readonly flavorProfiles?: readonly string[] | undefined;

  /** Producer archetype. */
  readonly producerType?: string | undefined;

  /** Primary grape family (e.g. "Pinot", "Cabernet"). */
  readonly grapeFamily?: string | undefined;

  /** Region breadcrumb hierarchy. */
  readonly regionHierarchy?: readonly string[] | undefined;

  /** Numeric price band: 1=value, 2=mid, 3=premium, 4=luxury. */
  readonly priceBandNumeric?: number | undefined;

  /** Gift suitability score from the learned facet (Track C Step 6). */
  readonly giftSuitabilityScore?: number | undefined;
  /** Beginner suitability score from the learned facet (Track C Step 7). */
  readonly beginnerSuitabilityScore?: number | undefined;

  /** Rank from the sparse (BM25) retrieval pass, if present. */
  readonly sparseRank?: number | undefined;
  /** Raw BM25 score from sparse retrieval pass. */
  readonly sparseRawScore?: number | undefined;

  /** Rank from the dense (embedding) retrieval pass, if present. */
  readonly denseRank?: number | undefined;
  /** Raw ANN score from dense retrieval pass. */
  readonly denseRawScore?: number | undefined;

  /** Rank from the learned-sparse retrieval pass, if present. */
  readonly learnedSparseRank?: number | undefined;
  /** Raw learned-sparse score from learned_sparse retrieval pass. */
  readonly learnedSparseRawScore?: number | undefined;

  /** Rank from the anchor-neighbourhood retrieval pass, if present. */
  readonly anchorRank?: number | undefined;
  /** Raw ANN score from anchor-neighbourhood retrieval pass. */
  readonly anchorRawScore?: number | undefined;

  /**
   * Fused retrieval score from RRF across all contributing passes.
   * This is a retrieval-stage ranking signal — NOT decision_confidence.
   *
   * @deprecated This field is semantically overloaded: FusionService stores
   * the RRF total here, but Browse/Compare/similar retrievers store the raw
   * BM25 score here (they bypass fusion). Downstream consumers cannot tell
   * which semantic applies.
   *
   * For RRF total, prefer {@link fusionRrfTotal}. For BM25 raw score,
   * prefer {@link sparseRawScore}. Migration step 3 (2026-04-12): field made
   * optional — new producers omit it. Remove entirely once all read sites
   * are cleaned up (candidate-pool.ts, mixed-solver.ts).
   */
  readonly retrievalFusionScore?: number | undefined;

  /**
   * RRF total score (sum of weighted reciprocal rank contributions across
   * channels). Distinct from per-channel raw scores. Set ONLY by
   * FusionService.fuse() — non-fusion retrievers (Browse, Compare,
   * similar) leave this undefined.
   */
  readonly fusionRrfTotal?: number | undefined;

  /** ADR-007 upstream source lineage (propagated to HTTP when present). */
  readonly sourceRecordRefs?: readonly SourceRecordRef[] | undefined;

  /** Constraint attribute names matched by this candidate. */
  readonly matchedConstraints: readonly string[];

  /** Hard constraint attribute names this candidate fails to satisfy. */
  readonly unmetHardConstraints?: readonly string[] | undefined;

  /**
   * ADR-014 Phase 1b.3b: graph slot-node IDs the candidate matched
   * (keyed to `ConstraintGraph.nodes[].nodeId`). Populated by the
   * annotator when a graph is present on the compiled query; absent
   * otherwise.
   *
   * Distinct from {@link matchedConstraints} which records flat
   * attribute names. The atomRef shape distinguishes "same attribute
   * matched via slot A vs slot B" under XOR disjunction.
   */
  readonly matchedAtomRefs?: readonly string[] | undefined;

  /**
   * ADR-014 Phase 1b.3b: graph slot-node IDs the candidate failed to
   * match. Populated by the annotator when a graph is present.
   */
  readonly unmetAtomRefs?: readonly string[] | undefined;

  /** Diagnostic trace for observability and debugging. */
  readonly retrievalTrace: RetrievalTrace;

  /** Canonical retrieval provenance preserved for downstream ranking/eval. */
  readonly retrievalProvenance?: CandidateProvenance | undefined;
}

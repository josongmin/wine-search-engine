import type { CanonicalEntityId } from '../../shared/types/index.js';
import type { HybridCandidate } from '../../retrieval/model/hybrid-candidate.js';
import type {
  DualLanePresence,
  IdentityExactnessTier,
} from '../../retrieval/model/dual-lane-artifact.js';
import type { SourceRecordRef } from '../../entity/model/source-record-ref.js';
import type { CandidateProvenance } from '../../retrieval/model/candidate-envelope.js';
import { PROVENANCE_QUERY_VIEWS, type ProvenanceQueryView } from '../../retrieval/model/provenance.js';
import type { ComponentScores } from '../model/ranked-result.js';

/** Max characters sent to the cross-encoder (latency + model context). */
export const RERANK_PASSAGE_MAX_CHARS = 1200;

/**
 * Internal intermediate representation during ranking.
 * Exported for regression tests (E1-P03 tie-break suite).
 */
export interface ScoredEntry {
  readonly entityId: CanonicalEntityId;
  readonly canonicalLabel: string;
  readonly producer?: string;
  readonly region?: string;
  readonly searchTextEn?: string;
  readonly grapePrimary?: string;
  readonly appellation?: string;
  readonly producerPrestige?: number;
  readonly componentScores: ComponentScores;
  readonly finalScore: number;
  readonly matchedConstraints: readonly string[];
  readonly unmetConstraints: readonly string[];
  readonly inferredConstraints: readonly string[];
  /**
   * ADR-014 Phase 1b.3b: graph slot-node IDs the candidate matched.
   * Absent when the compiled query carried no graph — the flat
   * `matchedConstraints` above is the legacy surface in that case.
   */
  readonly matchedAtomRefs?: readonly string[] | undefined;
  /**
   * ADR-014 Phase 1b.3b: graph slot-node IDs required-but-unmet under
   * graph semantics. Absent when no graph is present.
   */
  readonly unmetAtomRefs?: readonly string[] | undefined;
  readonly retrievalProvenance?: CandidateProvenance | undefined;
  /**
   * E1-T3: sparse (BM25) rank from retrieval — used as tie-break stage after
   * finalScore and channelMatchType, before entityId. Lower rank = better lexical match.
   * Present only for candidates retrieved via sparse_bm25 channel.
   */
  readonly sparseRank?: number | undefined;
  /**
   * E1-T3: dense (ANN embedding) rank from retrieval.
   * Present only for candidates retrieved via dense_semantic channel.
   */
  readonly denseRank?: number | undefined;
  /**
   * E1-T3: anchor-neighbourhood rank from retrieval.
   * Present only for candidates retrieved via anchor_similarity channel.
   */
  readonly anchorRank?: number | undefined;
  /**
   * E1-T3: evidence quality tier for deterministic stage-2 tie-break.
   *
   * Values (lower = stronger exact/known-item evidence):
   *   0 — exact_alias_match / known_item_lookup protected candidate
   *   1 — anchor-conditioned candidate
   *   2 — ordinary lexical/dense candidate with some provenance
   *   3 — weak candidate with no lexical/protected evidence
   */
  readonly evidenceQualityTier?: number | undefined;
  /**
   * E1-T3: Lexical exactness tier for stage-3 tie-break.
   *
   * Captures how closely the candidate's surface form matched the query
   * text via BM25 / alias lookup strategies, independently of which
   * retrieval channels the candidate appeared in.
   *
   * Values (lower = better lexical match, consistent with sparseRank):
   *   0 — strict / accentless / compact query views
   *   1 — transliterated / phonetic_compact query views
   *   2 — vintage_canonicalized / vintage_stripped query views
   *   3 — no recognized query-view evidence
   */
  readonly lexicalExactnessTier?: number | undefined;
  readonly drinkingWindowStart?: number | undefined;
  readonly drinkingWindowEnd?: number | undefined;
  readonly drinkingWindowModelVersion?: string | undefined;

  // Wine attributes for Epic 15 dynamic prediction
  readonly vintageYear?: number | undefined;
  readonly body?: number | undefined;
  readonly tannin?: number | undefined;
  readonly acidity?: number | undefined;
  readonly sweetness?: number | undefined;
  readonly avgCriticProxyScore?: number | undefined;
  readonly criticScoreNormalized?: number | undefined;
  readonly grapePrimaryEnc?: number | undefined;
  readonly regionEnc?: number | undefined;
  readonly countryEnc?: number | undefined;

  // Display metadata for new entity summary fields
  readonly style?: string | undefined;
  readonly wineType?: string | undefined;
  readonly classification?: string | undefined;
  readonly alcoholPct?: number | undefined;
  readonly certifications?: readonly string[] | undefined;
  readonly pairingTags?: readonly string[] | undefined;
  readonly occasion?: readonly string[] | undefined;

  // Price data for agent/response surface
  readonly priceBand?: string | undefined;
  readonly priceUsd?: number | undefined;

  readonly sourceRecordRefs?: readonly SourceRecordRef[] | undefined;
  readonly entityPosteriorScore?: number | undefined;
  readonly identityExactnessTier: IdentityExactnessTier;
  readonly lanePresence?: DualLanePresence | undefined;
}

/**
 * Builds a wine-aware passage text for cross-encoder reranking (RFC-017 §5.2).
 */
export function buildWineText(entry: ScoredEntry): string {
  const parts: string[] = [];
  const label = entry.canonicalLabel.trim();
  if (label.length > 0) parts.push(label);
  const prod = entry.producer?.trim();
  if (prod !== undefined && prod.length > 0) parts.push(prod);
  const reg = entry.region?.trim();
  if (reg !== undefined && reg.length > 0) parts.push(reg);
  const en = entry.searchTextEn?.trim();
  if (en !== undefined && en.length > 0) parts.push(en);
  const grape = entry.grapePrimary?.trim();
  if (grape !== undefined && grape.length > 0) parts.push(grape);

  if (parts.length === 0) return String(entry.entityId);

  let passage = parts.join('. ');
  if (passage.length > RERANK_PASSAGE_MAX_CHARS) {
    passage = passage.slice(0, RERANK_PASSAGE_MAX_CHARS);
  }
  return passage;
}

/**
 * Final-score comparisons treat values within this epsilon as tied so ordering
 * falls through to entityId (deterministic tie-break, RFC-009/015).
 */
export const FINAL_SCORE_SORT_TIE_EPSILON = 1e-12;

const EVIDENCE_QUALITY_TIER_UNKNOWN = 3;
const LEXICAL_EXACTNESS_TIER_EXACT = 0;
const LEXICAL_EXACTNESS_TIER_TRANSLITERATED = 1;
const LEXICAL_EXACTNESS_TIER_VINTAGE = 2;
const EXACT_QUERY_VIEWS = new Set<ProvenanceQueryView>(['strict', 'accentless', 'compact']);
const TRANSLITERATED_QUERY_VIEWS = new Set<ProvenanceQueryView>(['transliterated', 'phonetic_compact']);
const VINTAGE_QUERY_VIEWS = new Set<ProvenanceQueryView>(['vintage_canonicalized', 'vintage_stripped']);

/**
 * E1-T3: Compute evidence/lexical tiers for a scored entry.
 *
 * Evidence quality is the stage-2 axis: it measures how strong the
 * exact-known-item evidence is before we look at lexical fidelity.
 *
 * Lexical exactness is the stage-3 axis: it measures how well the candidate
 * matched the query as a surface-form text string, independent of which
 * retrieval channels it appeared in.
 *
 * Tiers are pre-computed at scoring time from retrieval provenance metadata.
 */
function getEvidenceQualityTier(entry: ScoredEntry): number {
  return entry.evidenceQualityTier ?? EVIDENCE_QUALITY_TIER_UNKNOWN;
}

function getLexicalExactnessTier(entry: ScoredEntry): number {
  return entry.lexicalExactnessTier ?? LEXICAL_EXACTNESS_TIER_UNKNOWN;
}

/** Sentinel tier value for entries whose lexical exactness could not be determined. */
const LEXICAL_EXACTNESS_TIER_UNKNOWN = 3;

/**
 * E1-T3: Build the lexical exactness tier from retrieval provenance metadata.
 *
 * Reads canonical provenance query-view vocabulary only.
 */
export function buildLexicalExactnessTier(candidate: HybridCandidate): number {
  const matchedViews = candidate.retrievalProvenance?.queryViewMatches
    .map((match) => match.viewName)
    .filter((view): view is ProvenanceQueryView => (
      PROVENANCE_QUERY_VIEWS as readonly string[]
    ).includes(view)) ?? [];

  if (matchedViews.some((view) => EXACT_QUERY_VIEWS.has(view))) {
    return LEXICAL_EXACTNESS_TIER_EXACT;
  }
  if (matchedViews.some((view) => TRANSLITERATED_QUERY_VIEWS.has(view))) {
    return LEXICAL_EXACTNESS_TIER_TRANSLITERATED;
  }
  if (matchedViews.some((view) => VINTAGE_QUERY_VIEWS.has(view))) {
    return LEXICAL_EXACTNESS_TIER_VINTAGE;
  }

  return LEXICAL_EXACTNESS_TIER_UNKNOWN;
}

export function buildEvidenceQualityTier(candidate: HybridCandidate): number {
  const protectedReason = candidate.retrievalProvenance?.protectedInclusionReason;
  if (protectedReason === 'exact_alias_match' || protectedReason === 'known_item_lookup') {
    return 0;
  }
  if (candidate.anchorRank !== undefined) {
    return 1;
  }
  if (
    candidate.retrievalProvenance !== undefined
    || candidate.sparseRank !== undefined
    || candidate.denseRank !== undefined
  ) {
    return 2;
  }
  return EVIDENCE_QUALITY_TIER_UNKNOWN;
}

/**
 * Descending sort by finalScore; NaN-safe; 5-stage deterministic tie-break.
 *
 * Stage 1: finalScore descending (NaN → last)
 * Stage 2: evidenceQualityTier ascending (lower = stronger exact/known-item evidence)
 * Stage 3: lexicalExactnessTier ascending (lower = better surface-form match)
 * Stage 4: sparseRank ascending (lower BM25 rank = better lexical match; absent → last)
 * Stage 5: entityId ascending (stable lexicographic tie-break, RFC-009/015)
 *
 * E1-T3: exact-known-item evidence beats generic lexical evidence; lexical
 * fidelity then breaks remaining ties before sparse rank and entityId.
 */
export function compareScoredEntriesByFinalScoreDesc(a: ScoredEntry, b: ScoredEntry): number {
  const aFinite = Number.isFinite(a.finalScore);
  const bFinite = Number.isFinite(b.finalScore);
  if (!aFinite && !bFinite) {
    // Stages 2-5 for NaN-NaN ties
    const aEvidence = getEvidenceQualityTier(a);
    const bEvidence = getEvidenceQualityTier(b);
    if (aEvidence !== bEvidence) return aEvidence - bEvidence;
    const aTier = getLexicalExactnessTier(a);
    const bTier = getLexicalExactnessTier(b);
    if (aTier !== bTier) return aTier - bTier;
    const aSparse = a.sparseRank ?? Infinity;
    const bSparse = b.sparseRank ?? Infinity;
    if (aSparse !== bSparse) return aSparse - bSparse;
    return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
  }
  if (!aFinite) return 1;
  if (!bFinite) return -1;
  const scoreDiff = b.finalScore - a.finalScore;
  if (Math.abs(scoreDiff) > FINAL_SCORE_SORT_TIE_EPSILON) {
    return scoreDiff > 0 ? 1 : -1;
  }
  // Stage 2: evidence quality tier ascending (lower = stronger exact/known-item evidence)
  const aEvidence = getEvidenceQualityTier(a);
  const bEvidence = getEvidenceQualityTier(b);
  if (aEvidence !== bEvidence) return aEvidence - bEvidence;
  // Stage 3: lexical exactness tier ascending (lower = better surface-form match)
  const aTier = getLexicalExactnessTier(a);
  const bTier = getLexicalExactnessTier(b);
  if (aTier !== bTier) return aTier - bTier;
  // Stage 4: sparseRank ascending (absent = Infinity → loses)
  const aSparse = a.sparseRank ?? Infinity;
  const bSparse = b.sparseRank ?? Infinity;
  if (aSparse !== bSparse) return aSparse - bSparse;
  // Stage 5: entityId ascending
  return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
}

import type { AnchorProfile } from '../model/anchor-profile.js';
import { clamp01 } from '../../shared/utils/clamp.js';

/** Region adjacency map match score (not identical but neighboring). */
const REGION_ADJACENCY_MATCH_SCORE = 0.6;
/** Same continent but not adjacent region score. */
const SAME_CONTINENT_MATCH_SCORE = 0.3;
/** Neutral cosine fallback when embeddings missing or length-mismatched. */
const EMBEDDING_UNAVAILABLE_NEUTRAL_SCORE = 0.5;

/**
 * Minimal candidate attributes needed for similarity scoring.
 *
 * In practice this data would come from enriched candidate entities.
 * The similarity scorer depends only on this contract, not on the
 * full entity model.
 */
export interface SimilarityCandidate {
  /** Wine region. */
  readonly region: string;

  /** Grape varieties used. */
  readonly grapes: readonly string[];

  /** Body level [0,1] normalised. Absent when not indexed. */
  readonly body?: number | undefined;

  /** Sweetness level [0,1] normalised. Absent when not indexed. */
  readonly sweetness?: number | undefined;

  /** Style descriptor. */
  readonly style: string;

  /** Pre-computed embedding vector for distance computation. */
  readonly embedding?: readonly number[] | undefined;
}

/**
 * Weight configuration for similarity sub-components.
 */
const SIMILARITY_WEIGHTS = {
  region: 0.25,
  grapeOverlap: 0.25,
  styleDistance: 0.15,
  bodySweetness: 0.15,
  embedding: 0.20,
} as const;

/**
 * Region adjacency tiers for computing region distance.
 *
 * Tier 0: same region → 1.0
 * Tier 1: adjacent/related regions → 0.6
 * Tier 2: same continent → 0.3
 * Tier 3: different continent → 0.0
 */
const REGION_ADJACENCY: Readonly<Record<string, readonly string[]>> = {
  // France
  'bordeaux': ['saint-emilion', 'pauillac', 'medoc', 'graves', 'pomerol'],
  'burgundy': ['beaujolais', 'chablis', 'cote-de-nuits', 'cote-de-beaune'],
  'champagne': ['cremant', 'alsace'],
  'rhone': ['cotes-du-rhone', 'chateauneuf-du-pape', 'hermitage'],
  // Italy
  'tuscany': ['chianti', 'montalcino', 'bolgheri'],
  'piedmont': ['barolo', 'barbaresco', 'asti'],
  // USA
  'napa valley': ['sonoma', 'mendocino', 'central coast'],
  'sonoma': ['napa valley', 'mendocino', 'russian river valley'],
  // Spain
  'rioja': ['ribera del duero', 'priorat', 'navarra'],
};

/**
 * Continent groupings for region fallback similarity.
 */
const CONTINENT_REGIONS: Readonly<Record<string, readonly string[]>> = {
  europe: [
    'bordeaux', 'burgundy', 'champagne', 'rhone', 'loire', 'alsace',
    'tuscany', 'piedmont', 'veneto', 'sicily',
    'rioja', 'ribera del duero', 'priorat',
    'douro', 'alentejo',
    'mosel', 'rheingau',
  ],
  northAmerica: [
    'napa valley', 'sonoma', 'willamette valley', 'walla walla',
    'central coast', 'paso robles', 'mendocino',
  ],
  southAmerica: [
    'mendoza', 'maipo valley', 'colchagua', 'casablanca valley',
  ],
  oceania: [
    'barossa valley', 'mclaren vale', 'hunter valley', 'yarra valley',
    'marlborough', 'hawkes bay', 'central otago',
  ],
  africa: ['stellenbosch', 'swartland', 'constantia'],
};

/**
 * Scores candidates on similarity to an anchor entity.
 *
 * Combines multiple sub-signals:
 * - Region distance (same > adjacent > same continent > different continent)
 * - Grape overlap (Jaccard similarity)
 * - Style vector distance (simple string match)
 * - Body/sweetness proximity (L1 distance in attribute space)
 * - Embedding cosine similarity (when embeddings are available)
 *
 * This is a pure computation class with no side effects or I/O.
 */
export class SimilarityScorer {
  /**
   * Computes a combined anchor similarity score for a candidate.
   *
   * @param candidate - The candidate to score.
   * @param anchor - The anchor profile to compare against.
   * @returns Combined similarity score in [0, 1].
   */
  score(candidate: SimilarityCandidate, anchor: AnchorProfile): number {
    const regionScore = this.computeRegionDistance(
      candidate.region,
      anchor.region,
    );
    const grapeScore = this.computeGrapeOverlap(
      candidate.grapes,
      anchor.grapes,
    );
    const styleScore = this.computeStyleDistance(
      candidate.style,
      anchor.style,
    );
    const bodySweet = this.computeBodySweetnessProximity(
      candidate.body,
      candidate.sweetness,
      anchor.body,
      anchor.sweetness,
    );
    const embeddingScore = this.computeEmbeddingSimilarity(
      candidate.embedding,
      anchor.embedding,
    );

    // Weighted combination
    let combined =
      regionScore * SIMILARITY_WEIGHTS.region +
      grapeScore * SIMILARITY_WEIGHTS.grapeOverlap +
      styleScore * SIMILARITY_WEIGHTS.styleDistance +
      bodySweet * SIMILARITY_WEIGHTS.bodySweetness +
      embeddingScore * SIMILARITY_WEIGHTS.embedding;

    // If no embeddings available, redistribute embedding weight proportionally
    if (
      candidate.embedding === undefined ||
      anchor.embedding === undefined
    ) {
      const nonEmbeddingTotal = 1 - SIMILARITY_WEIGHTS.embedding;
      combined =
        (regionScore * SIMILARITY_WEIGHTS.region +
          grapeScore * SIMILARITY_WEIGHTS.grapeOverlap +
          styleScore * SIMILARITY_WEIGHTS.styleDistance +
          bodySweet * SIMILARITY_WEIGHTS.bodySweetness) /
        nonEmbeddingTotal;
    }

    return clamp01(combined);
  }

  /**
   * Computes region distance using adjacency tiers.
   *
   * Same region → 1.0, adjacent → 0.6, same continent → 0.3, else → 0.0.
   */
  computeRegionDistance(candidateRegion: string, anchorRegion: string): number {
    const cNorm = candidateRegion.toLowerCase().trim();
    const aNorm = anchorRegion.toLowerCase().trim();

    // Same region
    if (cNorm === aNorm) {
      return 1.0;
    }

    // Adjacent region
    const anchorAdjacent = REGION_ADJACENCY[aNorm];
    if (anchorAdjacent !== undefined && anchorAdjacent.includes(cNorm)) {
      return REGION_ADJACENCY_MATCH_SCORE;
    }
    const candidateAdjacent = REGION_ADJACENCY[cNorm];
    if (candidateAdjacent !== undefined && candidateAdjacent.includes(aNorm)) {
      return REGION_ADJACENCY_MATCH_SCORE;
    }

    // Same continent
    for (const regions of Object.values(CONTINENT_REGIONS)) {
      if (regions.includes(cNorm) && regions.includes(aNorm)) {
        return SAME_CONTINENT_MATCH_SCORE;
      }
    }

    // Different continent
    return 0.0;
  }

  /**
   * Computes Jaccard similarity between grape sets.
   *
   * Jaccard = |A ∩ B| / |A ∪ B|
   */
  computeGrapeOverlap(
    candidateGrapes: readonly string[],
    anchorGrapes: readonly string[],
  ): number {
    if (candidateGrapes.length === 0 && anchorGrapes.length === 0) {
      return 1.0; // Both empty → trivially similar
    }
    if (candidateGrapes.length === 0 || anchorGrapes.length === 0) {
      return 0.0;
    }

    const aSet = new Set(anchorGrapes.map((g) => g.toLowerCase().trim()));
    const cSet = new Set(candidateGrapes.map((g) => g.toLowerCase().trim()));

    let intersection = 0;
    for (const g of cSet) {
      if (aSet.has(g)) {
        intersection++;
      }
    }

    const union = new Set([...aSet, ...cSet]).size;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Computes style distance as a simple normalized string match.
   *
   * Exact match → 1.0, partial token overlap → proportional, no overlap → 0.0.
   */
  computeStyleDistance(candidateStyle: string, anchorStyle: string): number {
    // `"".split(/\s+/)` returns `[""]` (length 1), not `[]`. Filter empty tokens
    // so two empty/whitespace-only styles correctly return 0.0 (no data) instead
    // of incorrectly computing 1.0 (perfect match of empty-vs-empty).
    const cTokens = candidateStyle.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const aTokens = new Set(anchorStyle.toLowerCase().trim().split(/\s+/).filter(Boolean));

    if (cTokens.length === 0 || aTokens.size === 0) {
      return 0.0;
    }

    let matchCount = 0;
    for (const token of cTokens) {
      if (aTokens.has(token)) {
        matchCount++;
      }
    }

    const totalTokens = Math.max(cTokens.length, aTokens.size);
    return totalTokens > 0 ? matchCount / totalTokens : 0;
  }

  /**
   * Computes proximity of body and sweetness attributes using L1 distance.
   *
   * Normalized to [0, 1] where 1.0 = identical attributes.
   * Both body and sweetness are [0, 1] floats (Vespa normalised scale),
   * so max L1 distance per axis = 1, combined max = 2.
   */
  computeBodySweetnessProximity(
    candidateBody: number | undefined,
    candidateSweetness: number | undefined,
    anchorBody: number | undefined,
    anchorSweetness: number | undefined,
  ): number {
    // When either value is absent, return neutral (0.5) rather than 0 or 1,
    // consistent with how computeEmbeddingSimilarity handles missing data.
    if (candidateBody === undefined || anchorBody === undefined
        || candidateSweetness === undefined || anchorSweetness === undefined) {
      // 0.5 = neutral similarity when data is absent (neither similar nor dissimilar)
      // eslint-disable-next-line no-magic-numbers -- 0.5 is the neutral midpoint of [0,1] similarity scale
      return 0.5;
    }
    const bodyDist = Math.abs(candidateBody - anchorBody);
    const sweetDist = Math.abs(candidateSweetness - anchorSweetness);
    const maxDist = 2; // [0,1] range each: max diff per axis = 1, combined = 2
    return 1 - (bodyDist + sweetDist) / maxDist;
  }

  /**
   * Computes cosine similarity between two embedding vectors.
   *
   * Returns 0.5 (neutral) if either embedding is missing.
   */
  computeEmbeddingSimilarity(
    candidateEmb: readonly number[] | undefined,
    anchorEmb: readonly number[] | undefined,
  ): number {
    if (
      candidateEmb === undefined ||
      anchorEmb === undefined ||
      candidateEmb.length === 0 ||
      anchorEmb.length === 0 ||
      candidateEmb.length !== anchorEmb.length
    ) {
      return EMBEDDING_UNAVAILABLE_NEUTRAL_SCORE; // Neutral when embeddings are unavailable
    }

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < candidateEmb.length; i++) {
      const a = candidateEmb[i]!;
      const b = anchorEmb[i]!;
      dot += a * b;
      normA += a * a;
      normB += b * b;
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) {
      return 0;
    }

    // Cosine similarity is in [-1, 1]; map to [0, 1]
    const cosine = dot / denom;
    return (cosine + 1) / 2;
  }
}

// clamp01: imported from @shared/utils/clamp (SSoT).

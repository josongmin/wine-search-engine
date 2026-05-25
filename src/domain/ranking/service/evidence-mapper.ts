import type { EvidenceItem, EvidenceStrength } from '../../shared/types/index.js';
import type { ComponentScores } from '../model/ranked-result.js';
import {
  RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY
} from '../../retrieval/model/retrieval-channel.js';

/**
 * Evidence strength classification thresholds.
 * Empirically calibrated from typical signal distributions across query classes:
 *   >= 0.3 → "high" — signal dominates the ranking decision (e.g. exact entity match)
 *   >= 0.1 → "medium" — signal contributes meaningfully but not decisively
 *   <  0.1 → "low" — signal is background noise or tiebreaker
 * These align with RFC-000 §9.3 directional magnitude buckets.
 */
const HIGH_THRESHOLD = 0.3;
const MEDIUM_THRESHOLD = 0.1;

/**
 * Signals at or below this absolute magnitude are treated as zero for evidence
 * rows (avoids spurious rows from float noise; still allows explicit zeros where needed).
 */
const EVIDENCE_SIGNAL_NEAR_ZERO = 1e-12;

/**
 * Maps component scores to evidence items for the audit trail.
 *
 * Each non-zero component becomes one {@link EvidenceItem} with a signed
 * contribution string. Per RFC-000 section 9.3, evidence items must NEVER
 * claim exact percentage attribution — contributions are presented as
 * directional magnitudes only.
 *
 * This is a pure computation class with no side effects or I/O.
 */
export class EvidenceMapper {
  /**
   * Maps a complete set of component scores to evidence items.
   *
   * @param scores - The component scores for a single candidate.
   * @returns An array of evidence items, one per non-zero component.
   */
  mapToEvidence(scores: ComponentScores): readonly EvidenceItem[] {
    const items: EvidenceItem[] = [];

    this.addIfNonZero(items, {
      value: scores.entityIntegrity,
      type: 'entity_integrity',
      source: 'ranking_signal_computer',
      provenance: 'Entity data integrity and consistency check',
    });

    if (scores.anchorSimilarity !== undefined) {
      this.addIfNonZero(items, {
        value: scores.anchorSimilarity,
        type: RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
        source: 'ranking_signal_computer',
        provenance: 'Similarity to anchor entity based on attributes and embedding',
      });
    }

    if (scores.semantic !== undefined) {
      this.addIfNonZero(items, {
        value: scores.semantic,
        type: 'semantic_relevance',
        source: 'ranking_signal_computer',
        provenance: 'Semantic relevance from dense retrieval similarity',
      });
    }

    // Hard constraint pass is always included as it's a critical gate
    items.push({
      type: 'hard_constraint_pass',
      source: 'ranking_signal_computer',
      contribution: scores.hardConstraintPass ? '+pass' : '-fail',
      strength: scores.hardConstraintPass ? 'high' : 'low',
      provenance: 'Hard constraint gate — all required constraints must be satisfied',
    });

    this.addIfNonZero(items, {
      value: scores.softConstraint,
      type: 'soft_constraint_satisfaction',
      source: 'ranking_signal_computer',
      provenance: 'Weighted satisfaction of soft and inferred constraints',
    });

    if (scores.attributeAlignment !== undefined) {
      this.addIfNonZero(items, {
        value: scores.attributeAlignment,
        type: 'attribute_alignment',
        source: 'ranking_signal_computer',
        provenance: 'Structured attribute match with query plan expectations',
      });
    }

    if (scores.preferenceAlignment !== undefined) {
      this.addIfNonZero(items, {
        value: scores.preferenceAlignment,
        type: 'preference_alignment',
        source: 'ranking_signal_computer',
        provenance: 'Alignment with user taste preferences',
      });
    }

    if (scores.popularity !== undefined) {
      this.addIfNonZero(items, {
        value: scores.popularity,
        type: 'popularity',
        source: 'ranking_signal_computer',
        provenance: 'Popularity signal from engagement data (tie-breaker)',
      });
    }

    if (scores.availability !== undefined) {
      this.addIfNonZero(items, {
        value: scores.availability,
        type: 'availability',
        source: 'ranking_signal_computer',
        provenance: 'Product availability signal',
      });
    }

    if (scores.producerPrestige !== undefined) {
      this.addIfNonZero(items, {
        value: scores.producerPrestige,
        type: 'producer_prestige',
        source: 'catalog_data',
        provenance: 'Producer prestige derived from winery rating',
      });
    }

    if (scores.criticScore !== undefined) {
      this.addIfNonZero(items, {
        value: scores.criticScore,
        type: 'critic_score',
        source: 'catalog_data',
        provenance: 'Critic score signal from proxy or aggregated ratings',
      });
    }

    if (scores.recency !== undefined) {
      this.addIfNonZero(items, {
        value: scores.recency,
        type: 'recency',
        source: 'temporal_signal',
        provenance: 'Vintage recency signal — higher for more recent vintages',
      });
    }

    if (scores.multilingualScore !== undefined) {
      this.addIfNonZero(items, {
        value: scores.multilingualScore,
        type: 'multilingual',
        source: 'query_analysis',
        provenance: 'Multilingual match boost for Korean alias coverage',
      });
    }

    items.push({
      type: 'uncertainty_penalty',
      source: 'ranking_signal_computer',
      contribution: formatContribution(-scores.uncertaintyPenalty),
      strength:
        Math.abs(scores.uncertaintyPenalty) > EVIDENCE_SIGNAL_NEAR_ZERO
          ? classifyStrength(scores.uncertaintyPenalty)
          : 'low',
      provenance: 'Penalty for query ambiguity and missing candidate information',
    });

    return items;
  }

  /**
   * Adds an evidence item if the signal value is non-zero.
   */
  private addIfNonZero(
    items: EvidenceItem[],
    entry: {
      readonly value: number;
      readonly type: string;
      readonly source: string;
      readonly provenance: string;
    },
  ): void {
    if (!Number.isFinite(entry.value) || Math.abs(entry.value) <= EVIDENCE_SIGNAL_NEAR_ZERO) {
      return;
    }

    items.push({
      type: entry.type,
      source: entry.source,
      contribution: formatContribution(entry.value),
      strength: classifyStrength(Math.abs(entry.value)),
      provenance: entry.provenance,
    });
  }
}

/**
 * Formats a numeric contribution as a signed string (e.g. "+0.42", "-0.10").
 *
 * Per RFC-000 section 9.3, these are directional magnitudes, NOT exact
 * percentage attributions.
 */
function formatContribution(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}`;
}

/**
 * Classifies the absolute magnitude of a contribution into a qualitative
 * strength level.
 */
function classifyStrength(absValue: number): EvidenceStrength {
  if (absValue >= HIGH_THRESHOLD) {
    return 'high';
  }
  if (absValue >= MEDIUM_THRESHOLD) {
    return 'medium';
  }
  return 'low';
}

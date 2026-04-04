import type { EvidenceItem, EvidenceStrength } from '../../shared/types/index.js';
import type { ComponentScores } from '../model/ranked-result.js';

/**
 * Threshold above which a signal contribution is considered "high" strength.
 */
const HIGH_THRESHOLD = 0.3;

/**
 * Threshold above which a signal contribution is considered "medium" strength.
 */
const MEDIUM_THRESHOLD = 0.1;

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
        type: 'anchor_similarity',
        source: 'ranking_signal_computer',
        provenance: 'Similarity to anchor entity based on attributes and embedding',
      });
    }

    this.addIfNonZero(items, {
      value: scores.semantic,
      type: 'semantic_relevance',
      source: 'ranking_signal_computer',
      provenance: 'Semantic relevance from dense retrieval similarity',
    });

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

    this.addIfNonZero(items, {
      value: scores.attributeAlignment,
      type: 'attribute_alignment',
      source: 'ranking_signal_computer',
      provenance: 'Structured attribute match with query plan expectations',
    });

    this.addIfNonZero(items, {
      value: scores.preferenceAlignment,
      type: 'preference_alignment',
      source: 'ranking_signal_computer',
      provenance: 'Alignment with user taste preferences',
    });

    this.addIfNonZero(items, {
      value: scores.popularity,
      type: 'popularity',
      source: 'ranking_signal_computer',
      provenance: 'Popularity signal from engagement data (tie-breaker)',
    });

    this.addIfNonZero(items, {
      value: scores.availability,
      type: 'availability',
      source: 'ranking_signal_computer',
      provenance: 'Product availability signal',
    });

    if (scores.uncertaintyPenalty > 0) {
      items.push({
        type: 'uncertainty_penalty',
        source: 'ranking_signal_computer',
        contribution: formatContribution(-scores.uncertaintyPenalty),
        strength: classifyStrength(scores.uncertaintyPenalty),
        provenance: 'Penalty for query ambiguity and missing candidate information',
      });
    }

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
    if (entry.value === 0) {
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

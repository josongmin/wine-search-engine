import type { QueryClass } from '../../shared/types/index.js';
import type { ResolverCandidate } from '../model/resolved-candidate.js';
import type { AmbiguityState, AmbiguityType } from '../model/ambiguity-state.js';

/** Minimum number of strong candidates to trigger underspecified_short_form. */
const SHORT_FORM_CANDIDATE_THRESHOLD = 3;

/** Score ratio threshold: if top-2 is within this ratio of top-1, it is "strong". */
const STRONG_MATCH_RATIO = 0.85;

/** Top candidates scanned for multi-vintage / producer-family ambiguity. */
const AMBIGUITY_TOP_CANDIDATE_SCAN_K = 5;
/** Top candidates scanned for alias-collision ambiguity. */
const AMBIGUITY_ALIAS_COLLISION_SCAN_K = 10;

/**
 * Classifies ambiguity among resolution candidates, per RFC-006 §7.
 *
 * Ambiguity detection does not make a decision — it produces structured
 * signals that the decision layer uses to determine whether to resolve,
 * clarify, or fail.
 */
export class AmbiguityClassifier {
  /**
   * Classifies the ambiguity state of a set of candidates for a given query class.
   *
   * Detection rules:
   * - **wine_vs_producer**: top candidates have different entity types (e.g. one wine, one producer).
   * - **wine_vs_region**: top candidates mix wine and region entity types.
   * - **multi_vintage**: same wine entity appears with different vintages.
   * - **alias_collision**: a single alias maps to multiple distinct entities.
   * - **producer_family_collision**: multiple wines from the same producer family score similarly.
   * - **underspecified_short_form**: query is too short and matches multiple strong candidates.
   *
   * @param candidates - Scored candidates ordered by raw score descending.
   * @param queryClass - The classified query type.
   * @returns The ambiguity state with detected types and severity.
   */
  classify(
    candidates: readonly ResolverCandidate[],
    queryClass: QueryClass,
  ): AmbiguityState {
    if (candidates.length <= 1) {
      return { detected: false, types: [], severity: 'low' };
    }

    const types: AmbiguityType[] = [];

    if (this.detectWineVsProducer(candidates)) {
      types.push('wine_vs_producer');
    }

    if (this.detectWineVsRegion(candidates)) {
      types.push('wine_vs_region');
    }

    if (this.detectMultiVintage(candidates)) {
      types.push('multi_vintage');
    }

    if (this.detectAliasCollision(candidates)) {
      types.push('alias_collision');
    }

    if (this.detectProducerFamilyCollision(candidates)) {
      types.push('producer_family_collision');
    }

    if (this.detectUnderspecifiedShortForm(candidates, queryClass)) {
      types.push('underspecified_short_form');
    }

    const detected = types.length > 0;
    const severity = this.computeSeverity(types, candidates);

    return { detected, types, severity };
  }

  /**
   * Detects when top candidates have mixed wine and producer entity types.
   */
  private detectWineVsProducer(candidates: readonly ResolverCandidate[]): boolean {
    const topTypes = this.getTopCandidateTypes(candidates);
    return topTypes.has('wine') && topTypes.has('producer');
  }

  /**
   * Detects when top candidates have mixed wine and region entity types.
   */
  private detectWineVsRegion(candidates: readonly ResolverCandidate[]): boolean {
    const topTypes = this.getTopCandidateTypes(candidates);
    return topTypes.has('wine') && topTypes.has('region');
  }

  /**
   * Detects when the same wine appears with different vintages among top candidates.
   *
   * Groups by a vintage-stripped label so "Opus One 2018" and "Opus One 2019"
   * map to the same group. The previous code used the raw canonicalLabel which
   * typically includes the vintage — making this function dead code (each
   * vintage was its own group, so vintages.size was always 1).
   */
  private detectMultiVintage(candidates: readonly ResolverCandidate[]): boolean {
    const wineByLabel = new Map<string, Set<string>>();
    for (const candidate of candidates.slice(0, AMBIGUITY_TOP_CANDIDATE_SCAN_K)) {
      if (candidate.entityType === 'wine') {
        const vintage = candidate.attributeHints?.['vintage'];
        if (typeof vintage === 'string' || typeof vintage === 'number') {
          // Strip 4-digit year from label for grouping so different vintages
          // of the same wine converge to one key.
          const label = candidate.canonicalLabel
            .replace(/(?<!\p{L}\p{N})(19|20)\d{2}(?!\p{L}\p{N})/gu, '')
            .trim()
            .replace(/\s+/g, ' ');
          const vintages = wineByLabel.get(label) ?? new Set<string>();
          vintages.add(String(vintage));
          wineByLabel.set(label, vintages);
        }
      }
    }
    for (const vintages of wineByLabel.values()) {
      if (vintages.size > 1) {
        return true;
      }
    }
    return false;
  }

  /**
   * Detects when a single alias value maps to multiple distinct entities
   * among the top candidates.
   */
  private detectAliasCollision(candidates: readonly ResolverCandidate[]): boolean {
    const aliasToEntities = new Map<string, Set<string>>();
    for (const candidate of candidates.slice(0, AMBIGUITY_ALIAS_COLLISION_SCAN_K)) {
      for (const aliasMatch of candidate.aliasMatches) {
        const entities = aliasToEntities.get(aliasMatch.aliasValue) ?? new Set<string>();
        entities.add(candidate.entityId);
        aliasToEntities.set(aliasMatch.aliasValue, entities);
      }
    }
    for (const entities of aliasToEntities.values()) {
      if (entities.size > 1) {
        return true;
      }
    }
    return false;
  }

  /**
   * Detects when multiple wines from the same producer score similarly,
   * suggesting the query refers to the producer rather than a specific wine.
   */
  private detectProducerFamilyCollision(candidates: readonly ResolverCandidate[]): boolean {
    const producerCounts = new Map<string, number>();
    for (const candidate of candidates.slice(0, AMBIGUITY_TOP_CANDIDATE_SCAN_K)) {
      const producer = candidate.attributeHints?.['producer'];
      if (typeof producer === 'string') {
        producerCounts.set(producer, (producerCounts.get(producer) ?? 0) + 1);
      }
    }
    for (const count of producerCounts.values()) {
      if (count >= 3) {
        return true;
      }
    }
    return false;
  }

  /**
   * Detects when a short-form query matches multiple strong candidates,
   * suggesting the query is underspecified.
   */
  private detectUnderspecifiedShortForm(
    candidates: readonly ResolverCandidate[],
    queryClass: QueryClass,
  ): boolean {
    if (queryClass !== 'short_entity' && queryClass !== 'ambiguous_short_form') {
      return false;
    }

    // Count candidates with strong scores relative to the top candidate.
    // We use the canonicalNormalizedMatch as a proxy for query length impact.
    const topScore = candidates[0]?.sourceSignals.canonicalNormalizedMatch ?? 0;
    if (topScore === 0) {
      return false;
    }

    let strongCount = 0;
    for (const candidate of candidates) {
      const score = candidate.sourceSignals.canonicalNormalizedMatch;
      if (score / topScore >= STRONG_MATCH_RATIO) {
        strongCount++;
      }
    }

    return strongCount >= SHORT_FORM_CANDIDATE_THRESHOLD;
  }

  /**
   * Returns the set of entity types among the top candidates (up to 3).
   */
  private getTopCandidateTypes(candidates: readonly ResolverCandidate[]): Set<string> {
    const types = new Set<string>();
    for (const candidate of candidates.slice(0, 3)) {
      types.add(candidate.entityType);
    }
    return types;
  }

  /**
   * Computes an overall severity based on ambiguity types detected and candidate count.
   */
  private computeSeverity(
    types: readonly AmbiguityType[],
    candidates: readonly ResolverCandidate[],
  ): 'low' | 'medium' | 'high' {
    if (types.length === 0) {
      return 'low';
    }

    // Type-level collision (wine vs producer/region) is always high severity
    if (types.includes('wine_vs_producer') || types.includes('wine_vs_region')) {
      return 'high';
    }

    // Multiple ambiguity types or many strong candidates → high
    if (types.length >= 3) {
      return 'high';
    }

    // At least two types or producer family collision → medium
    if (types.length >= 2 || types.includes('producer_family_collision')) {
      return 'medium';
    }

    // Single ambiguity type with few candidates
    void candidates;
    return 'low';
  }
}

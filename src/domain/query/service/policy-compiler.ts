import type { QueryClass } from '../../shared/types/index.js';
import type { QueryIntent } from '../model/query-intent.js';
import type { AnchorCandidate } from '../model/anchor-candidate.js';
import type { QueryPolicy } from '../model/query-policy.js';
import type { QueryUncertainty } from '../model/query-uncertainty.js';

/** Anchor confidence threshold above which an anchor is considered strong. */
const STRONG_ANCHOR_CONFIDENCE = 0.85;

/** Overall uncertainty threshold above which clarification is required. */
const HIGH_UNCERTAINTY_THRESHOLD = 0.7;

/** Overall uncertainty threshold above which the threshold is raised. */
const MEDIUM_UNCERTAINTY_THRESHOLD = 0.4;

/** Bias applied to resolveTau for ambiguous_short_form queries. Raises the
 *  bar so only high-confidence resolves pass, while still allowing resolution
 *  when evidence is overwhelming (unlike the old hard requireClarification). */
const AMBIGUOUS_SHORT_FORM_BIAS = 0.15;

/** Bias applied for high-severity ambiguity (wine_vs_producer, etc.). */
const HIGH_AMBIGUITY_BIAS = 0.20;

/** Bias applied for high overall uncertainty. */
const HIGH_UNCERTAINTY_BIAS = 0.15;

/**
 * Compiles query policy directives from the plan's intent, class, anchors,
 * and uncertainty assessment.
 *
 * Implements the policy rules defined in RFC-005 section 7.3.
 *
 * BREAKING CHANGE (SOTA++): `requireClarification` is always false.
 * Replaced by `clarificationBias` — a soft threshold modifier that raises
 * resolveTau instead of hard-blocking resolution. This allows the decision
 * engine's numeric gate to resolve when confidence is overwhelming, even
 * for ambiguous_short_form queries.
 */
export class PolicyCompiler {
  compile(
    intent: QueryIntent,
    queryClass: QueryClass,
    anchors: readonly AnchorCandidate[],
    uncertainty: QueryUncertainty,
  ): QueryPolicy {
    const reasons: string[] = [];

    let requireExact = false;
    let allowApproximate = false;
    let clarificationBias = 0;
    let fallbackMode: QueryPolicy['fallbackMode'] = 'hybrid';

    // Rule 1: Strong anchor with entity intent -> require exact.
    const hasStrongAnchor = anchors.some(
      (a) => a.confidence >= STRONG_ANCHOR_CONFIDENCE,
    );
    if (
      hasStrongAnchor &&
      (intent === 'entity_exact' || intent === 'entity_fuzzy')
    ) {
      requireExact = true;
      reasons.push('strong_anchor_entity_intent');
    }

    // Rule 2: Known ambiguous surface form -> bias (was: hard clarification).
    if (uncertainty.ambiguityDetected && uncertainty.ambiguitySeverity === 'high') {
      clarificationBias = Math.max(clarificationBias, HIGH_AMBIGUITY_BIAS);
      fallbackMode = 'clarify';
      reasons.push('known_ambiguous_high_severity_bias');
    }

    // Rule 3: Ambiguous short form class -> bias (was: hard clarification).
    if (queryClass === 'ambiguous_short_form') {
      clarificationBias = Math.max(clarificationBias, AMBIGUOUS_SHORT_FORM_BIAS);
      fallbackMode = 'clarify';
      reasons.push('ambiguous_short_form_class_bias');
    }

    // Rule 4: Mixed query -> allow approximate matching.
    if (intent === 'mixed_query') {
      allowApproximate = true;
      requireExact = false;
      reasons.push('mixed_query_allows_approximate');
    }

    // Rule 5: Semantic / pairing / budget intents -> allow approximate.
    if (
      intent === 'semantic_discovery' ||
      intent === 'pairing_search' ||
      intent === 'budget_search' ||
      intent === 'facet_search'
    ) {
      allowApproximate = true;
      reasons.push('non_entity_intent_allows_approximate');
    }

    // Rule 6: High overall uncertainty -> bias (was: hard clarification).
    if (uncertainty.overall >= HIGH_UNCERTAINTY_THRESHOLD) {
      clarificationBias = Math.max(clarificationBias, HIGH_UNCERTAINTY_BIAS);
      fallbackMode = 'clarify';
      reasons.push('high_overall_uncertainty_bias');
    } else if (uncertainty.overall >= MEDIUM_UNCERTAINTY_THRESHOLD) {
      if (clarificationBias === 0) {
        fallbackMode = 'hybrid';
      }
      reasons.push('medium_uncertainty_raise_threshold');
    }

    // Rule 7: Comparison queries require both entities resolved.
    if (intent === 'comparison_search') {
      if (anchors.length < 2) {
        clarificationBias = Math.max(clarificationBias, HIGH_AMBIGUITY_BIAS);
        fallbackMode = 'clarify';
        reasons.push('comparison_insufficient_anchors_bias');
      }
    }

    // Rule 8: Unknown query class -> conservative policy.
    if (queryClass === 'unknown') {
      fallbackMode = 'fail';
      reasons.push('unknown_query_class_conservative');
    }

    if (reasons.length === 0) {
      reasons.push('default_policy');
    }

    return {
      requireExact,
      allowApproximate,
      // DEPRECATED: always false. Use clarificationBias instead.
      requireClarification: false,
      clarificationBias,
      fallbackMode,
      policyReasonCodes: reasons,
    };
  }
}

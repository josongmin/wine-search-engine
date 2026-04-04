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

/**
 * Compiles query policy directives from the plan's intent, class, anchors,
 * and uncertainty assessment.
 *
 * Implements the policy rules defined in RFC-005 section 7.3:
 * - Strong anchor + no constraints -> requireExact = true.
 * - Known ambiguous input -> requireClarification = true.
 * - Mixed query -> allowApproximate = true.
 * - High uncertainty -> requireClarification or fallback = clarify.
 */
export class PolicyCompiler {
  /**
   * Compiles a {@link QueryPolicy} from the given plan components.
   *
   * The compilation is deterministic: identical inputs always produce
   * identical policy output.
   *
   * @param intent - The detected query intent.
   * @param queryClass - The query classification label.
   * @param anchors - Extracted anchor candidates.
   * @param uncertainty - The uncertainty assessment.
   * @returns Compiled policy directives.
   */
  compile(
    intent: QueryIntent,
    queryClass: QueryClass,
    anchors: readonly AnchorCandidate[],
    uncertainty: QueryUncertainty,
  ): QueryPolicy {
    const reasons: string[] = [];

    let requireExact = false;
    let allowApproximate = false;
    let requireClarification = false;
    let fallbackMode: QueryPolicy['fallbackMode'] = 'hybrid';

    // Rule 1: Strong anchor with no mixed constraints -> require exact.
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

    // Rule 2: Known ambiguous surface form -> require clarification.
    if (uncertainty.ambiguityDetected && uncertainty.ambiguitySeverity === 'high') {
      requireClarification = true;
      fallbackMode = 'clarify';
      reasons.push('known_ambiguous_high_severity');
    }

    // Rule 3: Ambiguous short form class -> raise caution.
    if (queryClass === 'ambiguous_short_form') {
      requireClarification = true;
      fallbackMode = 'clarify';
      reasons.push('ambiguous_short_form_class');
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

    // Rule 6: High overall uncertainty -> force clarification.
    if (uncertainty.overall >= HIGH_UNCERTAINTY_THRESHOLD) {
      requireClarification = true;
      fallbackMode = 'clarify';
      reasons.push('high_overall_uncertainty');
    } else if (uncertainty.overall >= MEDIUM_UNCERTAINTY_THRESHOLD) {
      // Medium uncertainty: raise threshold but do not force clarification.
      if (!requireClarification) {
        fallbackMode = 'hybrid';
      }
      reasons.push('medium_uncertainty_raise_threshold');
    }

    // Rule 7: Comparison queries require both entities resolved.
    if (intent === 'comparison_search') {
      if (anchors.length < 2) {
        requireClarification = true;
        fallbackMode = 'clarify';
        reasons.push('comparison_insufficient_anchors');
      }
    }

    // Rule 8: Unknown query class -> conservative policy.
    if (queryClass === 'unknown') {
      fallbackMode = 'fail';
      reasons.push('unknown_query_class_conservative');
    }

    // Ensure at least one reason code is present.
    if (reasons.length === 0) {
      reasons.push('default_policy');
    }

    return {
      requireExact,
      allowApproximate,
      requireClarification,
      fallbackMode,
      policyReasonCodes: reasons,
    };
  }
}

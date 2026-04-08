import type { SessionContext } from '../model/session-context.js';

/**
 * E6-U1: Session Signal Scope — Reformulation Detector
 * This detector is the SSOT for reformulation type classification.
 * High-value signals produced here: reformulationType, priorContextCarry, ambiguityCarryForward.
 * Do NOT add low-signal session fields (raw timestamps, scroll position, etc.) to this detector.
 * See session-context.ts for the SessionContext model contract.
 */

/**
 * Classification of how the current query relates to the previous query
 * in a multi-turn session, per RFC-005 section 8.4.1.
 *
 * - `entity_refinement` -- user narrows or adjusts the entity reference.
 * - `constraint_narrowing` -- user adds or tightens constraints on the same topic.
 * - `correction` -- user corrects a misunderstood previous query.
 * - `topic_switch` -- user changes to an entirely different topic.
 * - `none` -- no previous context or not enough signal to classify.
 */
export type ReformulationType =
  | 'entity_refinement'
  | 'constraint_narrowing'
  | 'correction'
  | 'topic_switch'
  | 'none';

/** Word count at or above this suggests a new topic vs session refinement. */
const TOPIC_SWITCH_MIN_WORD_COUNT = 5;

/** Korean correction markers indicating the user is correcting a prior query. */
const CORRECTION_MARKERS: readonly RegExp[] = [
  /아니[라요]/u,          // "no, (it's) ..."
  /아닌데/u,              // "that's not right"
  /그게\s*아니/u,         // "that's not (it)"
  /(?<!\p{L}\p{N})(no|not)(?!\p{L}\p{N})/iu,
  /(?<!\p{L}\p{N})correction(?!\p{L}\p{N})/iu,
] as const;

/** Korean narrowing markers indicating the user is adding constraints. */
const NARROWING_MARKERS: readonly RegExp[] = [
  /근데/u,               // "but" (adding condition)
  /그\s*중에/u,          // "among those"
  /더\s*(싼|비싼|좋은)/u, // "cheaper / more expensive / better"
  /(?<!\p{L}\p{N})but(?!\p{L}\p{N})/iu,
  /(?<!\p{L}\p{N})also(?!\p{L}\p{N})/iu,
  /(?<!\p{L}\p{N})under(?!\p{L}\p{N})/iu,
  /(?<!\p{L}\p{N})cheaper(?!\p{L}\p{N})/iu,
] as const;

/** Korean refinement markers indicating the user is refining the entity. */
const REFINEMENT_MARKERS: readonly RegExp[] = [
  /그\s*거\s*말고/u,     // "not that one"
  /다른/u,               // "different / another"
  /대신/u,               // "instead"
  /(?<!\p{L}\p{N})instead(?!\p{L}\p{N})/iu,
  /(?<!\p{L}\p{N})other(?!\p{L}\p{N})/iu,
  /(?<!\p{L}\p{N})another(?!\p{L}\p{N})/iu,
] as const;

/**
 * Detects how a current query reformulates or continues from the previous
 * query in a multi-turn session.
 *
 * Uses heuristic pattern matching on the query text and session state to
 * classify the reformulation type. This classification guides the planner
 * on whether to inherit, override, or discard prior context.
 */
export class ReformulationDetector {
  /**
   * Detects the reformulation type by comparing the current query against
   * session context.
   *
   * @param currentQuery - The normalized current query string.
   * @param session - The session context from the previous turn.
   * @returns The detected reformulation type.
   */
  detect(currentQuery: string, session: SessionContext): ReformulationType {
    // No prior context means no reformulation.
    if (
      session.previousEntities.length === 0 &&
      session.lastQueryPlanRef === undefined
    ) {
      return 'none';
    }

    // Check for correction markers first (highest priority).
    if (CORRECTION_MARKERS.some((re) => re.test(currentQuery))) {
      return 'correction';
    }

    // Check for entity refinement markers.
    if (REFINEMENT_MARKERS.some((re) => re.test(currentQuery))) {
      return 'entity_refinement';
    }

    // Check for constraint narrowing markers.
    if (NARROWING_MARKERS.some((re) => re.test(currentQuery))) {
      return 'constraint_narrowing';
    }

    // If the previous decision was ambiguous and the user's new query is short,
    // it is likely a refinement or correction.
    if (
      session.lastDecisionStatus === 'ambiguous' &&
      currentQuery.split(/\s+/).length <= 3
    ) {
      return 'entity_refinement';
    }

    // If there is prior context but no markers, assume topic switch for long
    // queries and constraint narrowing for short ones.
    const wordCount = currentQuery.split(/\s+/).length;
    if (wordCount >= TOPIC_SWITCH_MIN_WORD_COUNT) {
      return 'topic_switch';
    }

    return 'none';
  }
}

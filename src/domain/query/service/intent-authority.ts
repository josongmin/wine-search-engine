/**
 * Intent authority handoff.
 *
 * Orchestrates the rule-based prior and the learned model prediction into a
 * single intent decision. Three modes are supported during the Epic-15
 * roll-out:
 *
 *  - `rule_only`    -- existing behaviour, learned prediction is ignored.
 *  - `learned_only` -- shadow / evaluation mode, rules serve only as fallback.
 *  - `hybrid`       -- both sources combined with a margin-based authority
 *                      handoff and the hedge-retrieval policy as tie breaker.
 */

import type { QueryIntent } from '../model/query-intent.js';
import {
  decideHedgeRetrieval,
  type HedgeRetrievalDecision,
  type IntentDistribution,
} from './hedge-retrieval-policy.js';

export interface IntentAuthorityInput {
  readonly rulePrior: IntentDistribution;
  readonly learnedPrediction?: IntentDistribution;
  readonly mode: 'rule_only' | 'learned_only' | 'hybrid';
}

export interface IntentAuthorityResult {
  readonly intent: QueryIntent;
  readonly confidence: number;
  readonly source: 'rule' | 'learned' | 'hybrid_agree' | 'hybrid_disagree_hedge';
  readonly hedge: HedgeRetrievalDecision;
}

/**
 * Minimum confidence margin by which the learned model must beat the rule
 * prior (or vice versa) to unilaterally override the other. Anything below
 * this margin on a disagreement routes through the hedge retrieval policy.
 */
const LEARNED_AUTHORITY_MARGIN = 0.15;

export function resolveIntentAuthority(
  input: IntentAuthorityInput,
): IntentAuthorityResult {
  const { rulePrior, learnedPrediction, mode } = input;

  if (mode === 'rule_only') {
    return {
      intent: rulePrior.intent,
      confidence: rulePrior.confidence,
      source: 'rule',
      hedge: decideHedgeRetrieval(rulePrior, []),
    };
  }

  if (mode === 'learned_only') {
    const chosen = learnedPrediction ?? rulePrior;
    return {
      intent: chosen.intent,
      confidence: chosen.confidence,
      source: learnedPrediction ? 'learned' : 'rule',
      hedge: decideHedgeRetrieval(chosen, []),
    };
  }

  // hybrid mode
  if (learnedPrediction === undefined) {
    return {
      intent: rulePrior.intent,
      confidence: rulePrior.confidence,
      source: 'rule',
      hedge: decideHedgeRetrieval(rulePrior, []),
    };
  }

  if (rulePrior.intent === learnedPrediction.intent) {
    const confidence = Math.max(rulePrior.confidence, learnedPrediction.confidence);
    const merged: IntentDistribution = {
      intent: rulePrior.intent,
      confidence,
    };
    return {
      intent: merged.intent,
      confidence: merged.confidence,
      source: 'hybrid_agree',
      hedge: decideHedgeRetrieval(merged, []),
    };
  }

  // Disagreement: check margin authority.
  if (learnedPrediction.confidence > rulePrior.confidence + LEARNED_AUTHORITY_MARGIN) {
    return {
      intent: learnedPrediction.intent,
      confidence: learnedPrediction.confidence,
      source: 'learned',
      hedge: decideHedgeRetrieval(learnedPrediction, [rulePrior]),
    };
  }
  if (rulePrior.confidence > learnedPrediction.confidence + LEARNED_AUTHORITY_MARGIN) {
    return {
      intent: rulePrior.intent,
      confidence: rulePrior.confidence,
      source: 'rule',
      hedge: decideHedgeRetrieval(rulePrior, [learnedPrediction]),
    };
  }

  // Neither dominates: pick the nominally higher-confidence side as the
  // primary but emit a hedge across both so retrieval can cover both paths.
  const primary =
    learnedPrediction.confidence >= rulePrior.confidence ? learnedPrediction : rulePrior;
  const other = primary === learnedPrediction ? rulePrior : learnedPrediction;
  return {
    intent: primary.intent,
    confidence: primary.confidence,
    source: 'hybrid_disagree_hedge',
    hedge: decideHedgeRetrieval(primary, [other]),
  };
}

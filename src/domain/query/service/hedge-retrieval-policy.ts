/**
 * Hedge retrieval policy.
 *
 * When the intent classifier is uncertain between multiple intents, we run
 * retrieval along more than one path ("hedge") rather than committing to the
 * single top prediction. This module is a pure decision function; the caller
 * is responsible for actually fanning out the retrieval calls.
 */

import type { QueryIntent } from '../model/query-intent.js';

export interface IntentDistribution {
  readonly intent: QueryIntent;
  readonly confidence: number;
}

export interface HedgeRetrievalDecision {
  readonly hedge: boolean;
  readonly intents: readonly QueryIntent[];
  readonly reason: string;
}

/**
 * Confidence at or above which the primary intent is treated as certain and
 * no hedging is performed. Calibrated as an initial guess; will be tuned with
 * click-through data once the learned model is online.
 */
const HEDGE_HIGH_CONFIDENCE = 0.85;

/**
 * Confidence below which the primary intent is treated as unreliable on its
 * own, and we pull in the top alternative path to hedge. Initial guess; will
 * be re-calibrated with click-through data.
 */
const HEDGE_LOW_CONFIDENCE = 0.6;

/**
 * Confidence gap between primary and top alternative under which we consider
 * the two tied and hedge even when the primary is above the low-confidence
 * threshold. Initial guess; will be tuned with click data.
 */
const HEDGE_TIE_WINDOW = 0.1;

/**
 * Maximum number of intents a single hedge decision can fan out to. We cap at
 * 2 to avoid uncontrolled fan-out of retrieval calls.
 */
const HEDGE_MAX_INTENTS = 2;

export function decideHedgeRetrieval(
  primary: IntentDistribution,
  alternatives: readonly IntentDistribution[],
): HedgeRetrievalDecision {
  // High confidence: trust the primary, skip hedging entirely.
  if (primary.confidence >= HEDGE_HIGH_CONFIDENCE) {
    return {
      hedge: false,
      intents: [primary.intent],
      reason: 'primary_high_confidence',
    };
  }

  const topAlt = alternatives[0];

  // No alternatives to hedge with -> fall back to primary regardless.
  if (topAlt === undefined) {
    return {
      hedge: false,
      intents: [primary.intent],
      reason: 'no_alternatives',
    };
  }

  // Low primary confidence: hedge with the top alternative.
  if (primary.confidence < HEDGE_LOW_CONFIDENCE) {
    return {
      hedge: true,
      intents: dedupTake([primary.intent, topAlt.intent], HEDGE_MAX_INTENTS),
      reason: 'primary_low_confidence',
    };
  }

  // Tied confidences: hedge with the top alternative.
  if (primary.confidence - topAlt.confidence <= HEDGE_TIE_WINDOW) {
    return {
      hedge: true,
      intents: dedupTake([primary.intent, topAlt.intent], HEDGE_MAX_INTENTS),
      reason: 'tied_with_alternative',
    };
  }

  return {
    hedge: false,
    intents: [primary.intent],
    reason: 'primary_clear_winner',
  };
}

function dedupTake(
  intents: readonly QueryIntent[],
  limit: number,
): readonly QueryIntent[] {
  const seen = new Set<QueryIntent>();
  const out: QueryIntent[] = [];
  for (const i of intents) {
    if (seen.has(i)) continue;
    seen.add(i);
    out.push(i);
    if (out.length >= limit) break;
  }
  return out;
}

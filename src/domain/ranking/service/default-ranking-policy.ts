/**
 * T5.5a: Default ranking policy implementation.
 *
 * Applies two rules in order:
 *   1. Producer diversity: if 3 or more results from the same producer appear
 *      in the top-10 positions, any extras beyond the 3rd are demoted to after
 *      position 10 (appended in their original relative order).
 *   2. Max-results truncation: if context.maxResults is set, the list is
 *      truncated to that count.
 *
 * After any reordering or truncation, `rank` is re-assigned as 1-based
 * contiguous integers matching the new positions.
 */

import type { RankedResult } from '../model/ranked-result.js';
import type { RankingPolicyPort, PolicyContext } from '../port/ranking-policy.port.js';

/** Number of results considered the "top" window for diversity enforcement. */
const DIVERSITY_TOP_WINDOW = 10;
/** Maximum allowed results per producer within the top window. */
const MAX_RESULTS_PER_PRODUCER = 3;

/**
 * Assigns 1-based contiguous `rank` values to a result list.
 * Returns a new array with updated rank fields; does not mutate input.
 */
function reassignRanks(results: readonly RankedResult[]): readonly RankedResult[] {
  return results.map((result, index) => ({
    ...result,
    rank: index + 1,
  }));
}

/**
 * Default implementation of {@link RankingPolicyPort}.
 *
 * Stateless and side-effect-free — safe to share across requests.
 */
export class DefaultRankingPolicy implements RankingPolicyPort {
  apply(
    results: readonly RankedResult[],
    context: PolicyContext,
  ): readonly RankedResult[] {
    let current = applyProducerDiversity(results);
    current = applyMaxResults(current, context.maxResults);
    return reassignRanks(current);
  }
}

// ---------------------------------------------------------------------------
// Rule implementations
// ---------------------------------------------------------------------------

/**
 * Producer diversity rule:
 *   Within the top-DIVERSITY_TOP_WINDOW positions, each producer may appear
 *   at most MAX_RESULTS_PER_PRODUCER times. Additional appearances are moved
 *   to after position DIVERSITY_TOP_WINDOW (in their original relative order).
 *
 *   Results that have no producer string are never demoted.
 */
function applyProducerDiversity(results: readonly RankedResult[]): readonly RankedResult[] {
  const topWindow = results.slice(0, DIVERSITY_TOP_WINDOW);
  const tail = results.slice(DIVERSITY_TOP_WINDOW);

  const producerCounts = new Map<string, number>();
  const retained: RankedResult[] = [];
  const demoted: RankedResult[] = [];

  for (const result of topWindow) {
    const producer = result.producer;
    if (producer === undefined || producer.trim() === '') {
      // No producer metadata — never demote.
      retained.push(result);
      continue;
    }

    const count = producerCounts.get(producer) ?? 0;
    if (count < MAX_RESULTS_PER_PRODUCER) {
      producerCounts.set(producer, count + 1);
      retained.push(result);
    } else {
      demoted.push(result);
    }
  }

  // Demoted items go before the existing tail so they appear at positions
  // DIVERSITY_TOP_WINDOW+1 onward, preserving their relative order among
  // themselves and ahead of results that were already in the tail.
  return [...retained, ...demoted, ...tail];
}

/**
 * Max-results truncation rule:
 *   If maxResults is defined, slice the list to that length.
 */
function applyMaxResults(
  results: readonly RankedResult[],
  maxResults: number | undefined,
): readonly RankedResult[] {
  if (maxResults === undefined) return results;
  return results.slice(0, maxResults);
}

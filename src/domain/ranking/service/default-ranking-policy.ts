/**
 * T5.5a: Default ranking policy implementation.
 *
 * Applies two rules in order:
 *   1. Producer diversity: if 3 or more results from the same producer appear
 *      in the top-10 positions, any extras beyond the 3rd are demoted to after
 *      position 10 (appended in their original relative order).
 *   2. Wine-type diversity for recommendation-style or semantic-preference
 *      queries without an explicit wine_type hard constraint: if 3 or more
 *      results from the same wine type appear in the top-10 positions and
 *      there are other wine types available in that window, extras beyond the
 *      2nd are demoted.
 *   3. Max-results truncation: if context.maxResults is set, the list is
 *      truncated to that count.
 *
 * After any reordering or truncation, `rank` is re-assigned as 1-based
 * contiguous integers matching the new positions.
 */

import type { RankedResult } from '../model/ranked-result.js';
import type { RankingPolicyPort, PolicyContext } from '../port/ranking-policy.port.js';
import {
  deriveCanonicalFamilyBranchLabel,
  extractSingleTokenNormalizedQuery,
  resolveAmbiguousBranchLabel,
  shouldApplyCanonicalFamilyBranchPrior,
} from './ambiguous-branch.js';

/** Number of results considered the "top" window for diversity enforcement. */
const DIVERSITY_TOP_WINDOW = 10;
/** Maximum allowed results per producer within the top window. */
const MAX_RESULTS_PER_PRODUCER = 3;
/** Maximum allowed results per wine type within the top window. */
const MAX_RESULTS_PER_WINE_TYPE = 2;

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
    current = applyWineTypeDiversity(current, context);
    current = applyAmbiguousBranchDiversity(current, context);
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
      demoted.push({ ...result, policyDemoted: true });
    }
  }

  // Demoted items go before the existing tail so they appear at positions
  // DIVERSITY_TOP_WINDOW+1 onward, preserving their relative order among
  // themselves and ahead of results that were already in the tail.
  return [...retained, ...demoted, ...tail];
}

function applyWineTypeDiversity(
  results: readonly RankedResult[],
  context: PolicyContext,
): readonly RankedResult[] {
  if (!shouldApplyWineTypeDiversity(context)) {
    return results;
  }

  const topWindow = results.slice(0, DIVERSITY_TOP_WINDOW);
  const tail = results.slice(DIVERSITY_TOP_WINDOW);
  const availableTypes = new Set(
    results
      .map((result) => result.wineType?.trim().toLowerCase())
      .filter((wineType): wineType is string => wineType !== undefined && wineType.length > 0),
  );
  if (availableTypes.size < 2) {
    return results;
  }

  const wineTypeCounts = new Map<string, number>();
  const retained: RankedResult[] = [];
  const demoted: RankedResult[] = [];

  for (const result of topWindow) {
    const wineType = result.wineType?.trim().toLowerCase();
    if (wineType === undefined || wineType.length === 0) {
      retained.push(result);
      continue;
    }

    const count = wineTypeCounts.get(wineType) ?? 0;
    if (count < MAX_RESULTS_PER_WINE_TYPE) {
      wineTypeCounts.set(wineType, count + 1);
      retained.push(result);
    } else {
      demoted.push({ ...result, policyDemoted: true });
    }
  }

  const promotedTailIndices = new Set<number>();
  for (let index = 0; index < tail.length; index += 1) {
    const candidate = tail[index];
    const wineType = candidate?.wineType?.trim().toLowerCase();
    if (candidate === undefined || wineType === undefined || wineType.length === 0) {
      continue;
    }
    if ((wineTypeCounts.get(wineType) ?? 0) > 0) {
      continue;
    }
    retained.push(candidate);
    promotedTailIndices.add(index);
    wineTypeCounts.set(wineType, 1);
    if (retained.length >= topWindow.length) {
      break;
    }
  }

  const remainingTail = tail.filter((_, index) => !promotedTailIndices.has(index));
  return [...retained, ...demoted, ...remainingTail];
}

function applyAmbiguousBranchDiversity(
  results: readonly RankedResult[],
  context: PolicyContext,
): readonly RankedResult[] {
  const branchOrder = deriveAmbiguousBranchOrder(results, context);
  if (branchOrder.length < 2) {
    return results;
  }

  const representatives: RankedResult[] = [];
  const representativeIds = new Set<string>();

  for (const branchLabel of branchOrder) {
    const representative = results.find((result) =>
      resolveAmbiguousBranchLabel(result, context.ambiguousBranchGroups) === branchLabel,
    );
    if (representative === undefined) {
      continue;
    }
    representatives.push(representative);
    representativeIds.add(String(representative.entityId));
  }

  const demoted = results
    .filter((result) => !representativeIds.has(String(result.entityId)))
    .map((result) => {
      const branchLabel = resolveAmbiguousBranchLabel(result, context.ambiguousBranchGroups);
      return branchLabel !== undefined ? { ...result, policyDemoted: true } : result;
    });

  return [...representatives, ...demoted];
}

function deriveAmbiguousBranchOrder(
  results: readonly RankedResult[],
  context: PolicyContext,
): readonly string[] {
  if (context.ambiguousBranchGroups !== undefined && context.ambiguousBranchGroups.length > 0) {
    const availableBranches = new Set(
      results
        .map((result) => resolveAmbiguousBranchLabel(result, context.ambiguousBranchGroups))
        .filter((label): label is string => label !== undefined),
    );
    return context.ambiguousBranchGroups
      .map((group) => group.label)
      .filter((label) => availableBranches.has(label));
  }

  if (!shouldApplyCanonicalFamilyBranchPrior(context.queryClass)) {
    return [];
  }

  const queryToken = extractSingleTokenNormalizedQuery(context.normalizedQuery);
  if (queryToken === undefined) {
    return [];
  }

  const branches = new Map<string, { firstRank: number; tokenExcess: number }>();
  for (const result of results) {
    const label = deriveCanonicalFamilyBranchLabel(result);
    if (label === undefined) {
      continue;
    }
    const branchTokens = label.split(/\s+/).filter(Boolean);
    if (!branchTokens.includes(queryToken)) {
      continue;
    }
    const tokenExcess = Math.max(0, branchTokens.length - 1);
    const existing = branches.get(label);
    if (existing === undefined || result.rank < existing.firstRank) {
      branches.set(label, { firstRank: result.rank, tokenExcess });
    }
  }

  return [...branches.entries()]
    .sort((left, right) => {
      if (left[1].tokenExcess !== right[1].tokenExcess) {
        return left[1].tokenExcess - right[1].tokenExcess;
      }
      return left[1].firstRank - right[1].firstRank;
    })
    .map(([label]) => label);
}

/**
 * Wine-type diversity applies to recommendation-style execution contracts:
 * explicit recommendation retrieval mode, plus the anchor-conditioned
 * query classes the planner currently emits for the same family.
 */
function shouldApplyWineTypeDiversity(context: PolicyContext): boolean {
  if (context.hasExplicitWineTypeConstraint === true) {
    return false;
  }

  if (context.hasDirectGrapePrimaryConstraint === true) {
    return false;
  }

  if (context.effectiveRetrievalMode === 'recommendation') {
    return true;
  }

  return context.queryClass === 'semantic_preference' || context.queryClass === 'anchored_similarity';
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

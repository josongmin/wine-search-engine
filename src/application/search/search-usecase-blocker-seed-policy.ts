import type { AnchorCandidate } from '../../domain/query/model/anchor-candidate.js';

/**
 * Blocker seeds are a high-recall recovery tool for anchor-miss paths.
 *
 * When the planner already produced an authoritative singleton canonical
 * anchor, adding blocker-only entities widens the candidate pool without
 * increasing recall and can manufacture false ambiguity in the entity route.
 *
 * Keep this policy narrow:
 * - exactly one unique entity is already covered by anchors
 * - at least one anchor is a canonical alias witness
 * - that witness is full-confidence (1.0) and maps to a single entity
 */
export function shouldSuppressBlockerSeedExpansion(
  anchors: readonly AnchorCandidate[],
): boolean {
  const uniqueAnchorEntityIds = new Set(
    anchors.flatMap((anchor) => anchor.candidateEntityIds.map(String)),
  );
  if (uniqueAnchorEntityIds.size !== 1) {
    return false;
  }

  return anchors.some((anchor) =>
    anchor.source === 'alias'
    && anchor.aliasType === 'canonical'
    && anchor.confidence === 1
    && anchor.candidateEntityIds.length === 1,
  );
}

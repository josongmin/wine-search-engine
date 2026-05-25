/**
 * Exact-lookup contract utilities — pure helpers shared by:
 *   - scoreExactLookupContract (the answerQuality multiplier on lookup hits)
 *   - scoreExactLookupContextRelevance / scoreExactLookupContextRecall
 *     (the context-relevance & context-recall sites in scorer.ts)
 *
 * Split from {@link ./scorer.ts} during the 2026-05-25 decomposition.
 * All four helpers are pure (no shared mutable state, no I/O).
 */

import type { EvidenceRecord } from '../../../src/domain/evaluation/service/claim-level-evaluator.js';
import type { ExactLookupExpectation } from './scenario.js';

/**
 * Canonical surface form for exact-lookup matching:
 *   trim → lowercase → NFKD-decompose → strip combining marks → NFKC.
 * When `collapseWhitespace` is true all whitespace runs are dropped
 * entirely; otherwise they are collapsed to single spaces. This double
 * normalisation lets a query like "Château  Margaux  2015 " match an
 * observed canonical label "Château Margaux 2015" regardless of casing,
 * accent representation, or spacing.
 */
export function normalizeExactLookupSurface(
  value: string,
  collapseWhitespace: boolean,
): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .normalize('NFKC');
  return collapseWhitespace
    ? normalized.replace(/\s+/gu, '')
    : normalized.replace(/\s+/gu, ' ');
}

/**
 * Pull the `entity_id` and `canonical_label` columns out of each evidence
 * record. Used as the canonical "what entities did the agent surface?"
 * view for exact-lookup verification.
 */
export function collectObservedExactLookupValues(records: readonly EvidenceRecord[]): {
  readonly entityIds: readonly string[];
  readonly canonicalLabels: readonly string[];
} {
  const entityIds = new Set<string>();
  const canonicalLabels = new Set<string>();
  for (const record of records) {
    const entityId = record['entity_id'];
    if (typeof entityId === 'string' && entityId.trim().length > 0) {
      entityIds.add(entityId.trim());
    }
    const canonicalLabel = record['canonical_label'];
    if (typeof canonicalLabel === 'string' && canonicalLabel.trim().length > 0) {
      canonicalLabels.add(canonicalLabel.trim());
    }
  }
  return {
    entityIds: [...entityIds],
    canonicalLabels: [...canonicalLabels],
  };
}

/**
 * Build the deduplicated needle set for exact-lookup matching from an
 * `ExactLookupExpectation` (canonical KO + EN labels + accepted aliases).
 * Empty / whitespace-only entries are dropped.
 */
export function buildExactLookupNeedles(exactLookup: ExactLookupExpectation): readonly string[] {
  const rawNeedles = [
    exactLookup.canonicalKo,
    exactLookup.canonicalEn,
    ...(exactLookup.acceptedCanonicalAliases ?? []),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return [...new Set(rawNeedles)];
}

/** Cap on how many entity_ids / canonical_labels to render in a diagnostic summary. */
const EXACT_LOOKUP_SUMMARY_LIST_CAP = 5;

/**
 * Render an "observed=…" diagnostic summary string from a
 * `collectObservedExactLookupValues` result. Caps each list at the first
 * EXACT_LOOKUP_SUMMARY_LIST_CAP items so the diagnostic stays scannable
 * even when the agent surfaced dozens of wines.
 */
export function formatObservedExactLookupSummary(
  observed: { readonly entityIds: readonly string[]; readonly canonicalLabels: readonly string[] },
): string {
  const entitySummary = observed.entityIds.length > 0
    ? observed.entityIds.slice(0, EXACT_LOOKUP_SUMMARY_LIST_CAP).join(', ')
    : 'none';
  const labelSummary = observed.canonicalLabels.length > 0
    ? observed.canonicalLabels.slice(0, EXACT_LOOKUP_SUMMARY_LIST_CAP).join(' | ')
    : 'none';
  return `entity_ids=${entitySummary}; canonical_labels=${labelSummary}`;
}

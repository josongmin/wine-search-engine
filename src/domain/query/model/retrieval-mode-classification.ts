import type { ExecutionRetrievalMode } from './engine-execution-contract.js';

/**
 * SSoT for retrieval-mode → identity-semantics classification (CLAUDE.md rule 30).
 *
 * Identity-bearing modes are the ones where the user is asking "WHICH entity is
 * this?" (entity_lookup / entity_resolution). Every other mode is exploratory —
 * the user is asking "WHICH entities match these constraints / are similar to
 * this anchor / live under this producer?" and the answer is a list, not a
 * single identity claim.
 *
 * Downstream consumers MUST import from here instead of duplicating the set:
 *  - `decision-engine.ts` — `applyPolicyOverlay` allow-approximate gating.
 *  - `search-usecase-decision-input.ts` — provenance-policy fallback for the
 *    `requireIdentitySeal` boolean.
 *
 * Drift between two private copies of this set was the root cause of the
 * `마고 비슷한 레드` (similarity query in mixed route) admission-gate
 * rejection: the decision-engine treated `similar_items` as exploratory,
 * the decision-input builder treated `effectiveRoute === 'mixed'` as
 * identity-requiring regardless of mode. Bridging both through the same
 * constant fixes the structural asymmetry.
 */
export const EXPLORATORY_RETRIEVAL_MODES: ReadonlySet<ExecutionRetrievalMode> = new Set<ExecutionRetrievalMode>([
  'compare_candidates',
  'recommendation',
  'similar_items',
  'producer_browse',
  'region_browse',
]);

/**
 * True iff the mode is exploratory — the user expects a list of candidates,
 * not a single identity claim. Identity-style admission gates (identity-seal,
 * require-exact, confidence-refusal floor) MUST relax for these modes.
 *
 * Accepts `string | undefined` rather than the narrow union so callers that
 * carry the value as a wire-shape string (response builders, contract tests)
 * can pass it directly; unrecognized strings safely return `false`.
 */
export function isExploratoryRetrievalMode(
  mode: string | undefined,
): boolean {
  return mode !== undefined && EXPLORATORY_RETRIEVAL_MODES.has(mode as ExecutionRetrievalMode);
}

/**
 * True iff the mode is identity-bearing — the user expects a single resolved
 * entity. `requireIdentitySeal` MAY be set for these modes; for any other mode
 * the seal is structurally inapplicable and must NOT be required.
 */
export function isIdentityRetrievalMode(
  mode: string | undefined,
): boolean {
  return mode === 'entity_lookup' || mode === 'entity_resolution';
}

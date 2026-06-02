/**
 * Entity Lookup V2 — vintage-mismatch resolve guard.
 *
 * Precision-first downgrade: when a query carries an EXPLICIT vintage token
 * (e.g. `오퍼스원 2019`, `Opus One 2019`) but the resolved entity's vintage is a
 * DIFFERENT year (`Opus One 2018`), that is NOT a confident single resolve — the
 * caller asked for a specific vintage we did not return. Downgrading such a
 * `resolved` to `ambiguous` (multi-vintage) prevents the wrong-positive that was
 * the sole 2026-06-02 shadow cutover blocker.
 *
 * Exact integer year comparison via the {@link extractVintageYear} SSoT — no
 * heuristic, no fuzzy matching. Domain leaf: imports only shared utils.
 */

import { extractVintageYear } from '../../shared/utils/vintage.js';

/** Machine-readable reason code surfaced when the guard downgrades a resolve. */
export const VINTAGE_MISMATCH_REASON_CODE = 'vintage_mismatch_downgrade';

/**
 * True iff the query carries an explicit vintage AND the candidate label carries
 * a vintage AND they differ. Returns false when either side has no vintage (then
 * there is nothing to contradict — no downgrade).
 */
export function shouldDowngradeForVintageMismatch(
  rawQuery: string,
  candidateLabel: string | undefined,
): boolean {
  if (candidateLabel === undefined) return false;
  const queryVintage = extractVintageYear(rawQuery);
  if (queryVintage === null) return false;
  const candidateVintage = extractVintageYear(candidateLabel);
  if (candidateVintage === null) return false;
  return queryVintage !== candidateVintage;
}

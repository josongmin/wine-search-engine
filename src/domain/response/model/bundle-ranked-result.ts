/**
 * ADR-013 Phase 1c: BundleRankedResult.
 *
 * Composes `RankedResult[]` across subquery slots with bundle-scoped
 * metadata. Separate type from `RankedResult` — consumers that do not
 * handle bundles never need to discriminate. See ADR-013 §3 for the
 * ranked-result carrier-contract decision (Option A: separate type).
 */
/**
 * Deterministic bundle-ID helper — the same sorted tuple of subquery
 * IDs always hashes to the same string. Tests lock this for replay.
 */
export function computeBundleId(subqueryIds: readonly string[]): string {
  const sorted = [...subqueryIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `bundle:${sorted.join('|')}`;
}

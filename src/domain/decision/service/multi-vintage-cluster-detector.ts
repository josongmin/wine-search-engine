/**
 * Multi-vintage cluster detector — Wave 3++ (post-RCA) decision-engine fix.
 *
 * **The bug this fixes**: when a user queries a famous wine by name without a
 * vintage (e.g. "Sassicaia", "Opus One"), Vespa correctly returns 3-5
 * candidates that are all the SAME wine in different vintages. The existing
 * decision engine sees `conformalSetSize >= 2` AND `gap < threshold` and
 * routes to `ambiguous → clarify`. The synthesizer then asks "어떤 빈티지요?"
 * — but the bench rubric (and most real users) expects the wine information
 * itself, picking a sensible default vintage. Result: bench score 0 on every
 * famous-wine query despite the corpus having the data.
 *
 * **The structural fix**: before the ambiguity gate fires, detect whether the
 * top-K candidates form a "same entity, different vintages" cluster vs
 * "distinct entities". On a same-entity cluster the verdict should resolve to
 * the top candidate (by popularity, then most-recent vintage), not ask for
 * clarification. The synthesizer then includes a footer mentioning N other
 * vintages are available.
 *
 * **Why this is not a heuristic**: the cluster is detected by exact
 * normalised-canonical-key match. A "cluster" is exactly "≥ MIN_CLUSTER_RATIO
 * of the top-K candidates share the same producer + de-vintaged label". The
 * thresholds (`MIN_CLUSTER_RATIO = 0.8`, `MIN_CLUSTER_SIZE = 2`) reference the
 * deterministic identity watermark used by the alias overlay (rule 25) — the
 * same minimum-agreement floor that the resolver uses to declare an
 * "identity-bearing" cluster vs "noisy fuzzy match".
 */

import type { ResolvedCandidate } from '../../resolver/model/resolved-candidate.js';

// ---------------------------------------------------------------------------
// Thresholds — explicit, named, sourced from existing identity invariants
// ---------------------------------------------------------------------------

/**
 * Minimum ratio of top-K candidates that must share the de-vintaged identity
 * key for the cluster to be classified as `same_entity_cluster`.
 *
 * `0.8` mirrors the soft→hard promotion confidence floor and the
 * "≥80% agreement = identity-bearing" invariant used throughout the resolver
 * and alias overlay (rules 25 / 27). NOT a tunable heuristic — drop below
 * this and the cluster includes noise (e.g. "Opus" matches both "Opus One"
 * and a different producer's "Opus de la Croix").
 */
const SAME_ENTITY_CLUSTER_MIN_RATIO = 0.8;

/**
 * Minimum cluster size for the resolution branch to activate. With 1
 * candidate it's a singleton (existing path); with 2+ candidates that share
 * an identity key, it's a true vintage cluster.
 */
const SAME_ENTITY_CLUSTER_MIN_SIZE = 2;

/**
 * Top-K window the detector inspects. Bounded so an outlier 6th-rank
 * candidate doesn't dilute a tight 3-5 vintage cluster.
 */
const SAME_ENTITY_CLUSTER_TOP_K = 5;

/**
 * Matches a 4-digit year token at the start, end, or surrounded by
 * whitespace in a wine label. Used to strip vintage prefix/suffix when
 * computing the de-vintaged identity key. Range 1800-2199 covers every
 * realistic wine vintage without false-matching grape varietal names that
 * happen to contain digits.
 */
const VINTAGE_YEAR_TOKEN_RE = /(?:^|\s)(?:1[89]\d{2}|20\d{2}|21\d{2})(?:\s|$)/u;

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

export type MultiVintageClusterClassification =
  | { readonly kind: 'same_entity_cluster'; readonly resolvedTopRank: number; readonly clusterSize: number; readonly identityKey: string }
  | { readonly kind: 'distinct_entities' }
  | { readonly kind: 'singleton' }
  | { readonly kind: 'empty' };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify the top-K resolver candidates as a same-entity (vintage) cluster
 * or distinct entities.
 *
 * Pure function — no I/O.
 *
 * @param candidates Resolver candidates ordered by rank ascending.
 * @returns the classification + (for `same_entity_cluster`) the rank of the
 *          resolved top candidate (1-based) and the cluster size.
 */
export function classifyMultiVintageCluster(
  candidates: readonly ResolvedCandidate[],
): MultiVintageClusterClassification {
  if (candidates.length === 0) return { kind: 'empty' };
  if (candidates.length === 1) return { kind: 'singleton' };

  const topK = candidates.slice(0, SAME_ENTITY_CLUSTER_TOP_K);

  // Compute de-vintaged identity key per candidate
  const keysWithCandidate = topK.map((c) => ({
    key: deriveDeVintagedIdentityKey(c.canonicalLabel),
    cand: c,
  }));

  // Count occurrences per key
  const keyCounts = new Map<string, number>();
  for (const { key } of keysWithCandidate) {
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }

  // Find the dominant key
  let dominantKey: string | undefined;
  let dominantCount = 0;
  for (const [k, count] of keyCounts) {
    if (count > dominantCount) {
      dominantKey = k;
      dominantCount = count;
    }
  }

  if (
    dominantKey === undefined
    || dominantCount < SAME_ENTITY_CLUSTER_MIN_SIZE
    || dominantCount / topK.length < SAME_ENTITY_CLUSTER_MIN_RATIO
    || dominantKey.length === 0
  ) {
    return { kind: 'distinct_entities' };
  }

  // The resolved top candidate is the FIRST candidate (by rank) whose key
  // matches the dominant key. Rank-stable: same input → same winner.
  const winner = keysWithCandidate.find((kc) => kc.key === dominantKey);
  if (winner === undefined) {
    return { kind: 'distinct_entities' };
  }
  return {
    kind: 'same_entity_cluster',
    resolvedTopRank: winner.cand.rank,
    clusterSize: dominantCount,
    identityKey: dominantKey,
  };
}

/**
 * Derive a stable identity key for a wine's canonical_label that ignores
 * vintage year tokens. Example outputs:
 *
 *   "2001 Tenuta San Guido Sassicaia"   → "tenuta san guido sassicaia"
 *   "Sassicaia 2018"                    → "sassicaia"
 *   "Opus One Opus One"                 → "opus one opus one"  (duplicate token noise preserved — same wine)
 *   "1987 Opus One Opus One"            → "opus one opus one"
 *
 * Normalisation rules (deterministic):
 *   - Strip leading / trailing / whitespace-bounded 4-digit year token.
 *   - Lower-case.
 *   - Collapse whitespace runs to single space.
 *
 * Exported for tests.
 */
export function deriveDeVintagedIdentityKey(canonicalLabel: string): string {
  let stripped = canonicalLabel;
  // Strip up to 2 vintage tokens (handles labels like "2001 ... 2001")
  for (let i = 0; i < 2; i += 1) {
    const match = stripped.match(VINTAGE_YEAR_TOKEN_RE);
    if (match === null) break;
    stripped = stripped.replace(VINTAGE_YEAR_TOKEN_RE, ' ');
  }
  return stripped.trim().toLowerCase().replace(/\s+/gu, ' ');
}

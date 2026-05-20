/**
 * Edit-distance and string-similarity primitives — SSoT for alias fuzzy matching.
 *
 * Three algorithms are exported here:
 *  - {@link levenshteinDistance}: classic insertion / deletion / substitution.
 *  - {@link damerauLevenshteinOsa}: Levenshtein + adjacent transposition
 *    (Optimal String Alignment variant — the practical Damerau-Levenshtein
 *    used in record linkage).
 *  - {@link jaroWinklerSimilarity}: Jaro similarity with Winkler prefix boost.
 *
 * Why both Damerau and Jaro-Winkler:
 *  - Damerau-Levenshtein recognizes single-character transpositions as a
 *    single edit (so "Sasicaia" → "Sassicaia" via "sas" insertion + "ic"
 *    transposition is distance 2, not 3 like vanilla Levenshtein). This is
 *    the most common class of typo in user-typed entity lookups.
 *  - Jaro-Winkler weights agreement on the leading prefix, which matches how
 *    users mistype entity names (the start usually anchors recognition;
 *    the tail decays). On Bordeaux producer names ("Château" prefix shared
 *    across many candidates) Jaro-Winkler is a strong discriminator on the
 *    distinguishing suffix.
 *
 * All three operate on UTF-16 code units. For wine surface forms (Latin
 * + precomposed Hangul + accented Latin in NFC), this is correct because
 * every alias character is a single BMP code unit after the canonical NFC
 * pass that runs upstream. If surrogate-pair characters become routine in
 * the alias catalog, switch to a code-point-aware iterator here.
 */

/**
 * Classic Levenshtein distance: minimum count of single-character
 * insertions / deletions / substitutions to transform `a` into `b`.
 *
 * O(min(m,n)) space via two-row DP.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      const del = prev[j];
      const ins = curr[j - 1];
      const sub = prev[j - 1];
      if (del === undefined || ins === undefined || sub === undefined) {
        throw new Error('levenshtein: internal row undefined');
      }
      curr[j] = Math.min(del + 1, ins + 1, sub + cost);
    }
    [prev, curr] = [curr, prev];
  }

  const dist = prev[n];
  if (dist === undefined) {
    throw new Error('levenshtein: result undefined');
  }
  return dist;
}

/**
 * Damerau-Levenshtein distance, Optimal String Alignment (OSA) variant.
 *
 * Adds adjacent-character transposition (`ab → ba`) as a single edit on top
 * of Levenshtein operations. The OSA variant has the limitation that any
 * given pair of substrings is transposed at most once — adequate for the
 * single-typo cases that dominate user-typed wine surface forms.
 *
 * O(m·n) space (full matrix retained for `d[i-2][j-2]` lookup). For wine
 * alias surfaces (< 64 chars typically) the constant factor is irrelevant.
 */
export function damerauLevenshteinOsa(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const stride = n + 1;
  const d = new Array<number>((m + 1) * stride).fill(0);
  for (let i = 0; i <= m; i++) d[i * stride] = i;
  for (let j = 0; j <= n; j++) d[j] = j;

  const at = (i: number, j: number): number => {
    const v = d[i * stride + j];
    if (v === undefined) {
      throw new Error(`damerau-levenshtein: cell (${i},${j}) undefined`);
    }
    return v;
  };

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      let best = Math.min(
        at(i - 1, j) + 1,        // deletion
        at(i, j - 1) + 1,        // insertion
        at(i - 1, j - 1) + cost, // substitution
      );
      if (
        i > 1 &&
        j > 1 &&
        a.charAt(i - 1) === b.charAt(j - 2) &&
        a.charAt(i - 2) === b.charAt(j - 1)
      ) {
        best = Math.min(best, at(i - 2, j - 2) + 1); // transposition
      }
      d[i * stride + j] = best;
    }
  }

  return at(m, n);
}

/**
 * Jaro similarity in [0, 1].
 *
 *   J(a, b) = (m/|a| + m/|b| + (m - t/2) / m) / 3
 *
 * where `m` is the number of matching characters within a sliding window
 * of `max(|a|, |b|) / 2 - 1` and `t` is the number of transpositions among
 * those matches.
 *
 * Returns 0 for any empty input (the canonical zero-overlap case) and 1
 * for identical strings.
 */
export function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return 0;

  const matchWindow = Math.floor(Math.max(m, n) / 2) - 1;
  if (matchWindow < 0) {
    // Both strings of length 1: equality is the only signal; non-equality
    // was already covered by the a === b guard above, so no matches.
    return 0;
  }

  const aMatched = new Array<boolean>(m).fill(false);
  const bMatched = new Array<boolean>(n).fill(false);
  let matches = 0;

  for (let i = 0; i < m; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, n);
    for (let j = start; j < end; j++) {
      if (bMatched[j]) continue;
      if (a.charAt(i) !== b.charAt(j)) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }

  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < m; i++) {
    if (!aMatched[i]) continue;
    while (k < n && !bMatched[k]) k += 1;
    if (k < n && a.charAt(i) !== b.charAt(k)) {
      transpositions += 1;
    }
    k += 1;
  }

  return (
    matches / m +
    matches / n +
    (matches - transpositions / 2) / matches
  ) / 3;
}

/**
 * Winkler boost: extra credit for agreement on the leading prefix
 * (up to {@link DEFAULT_WINKLER_PREFIX_CAP} characters), scaled by
 * {@link DEFAULT_WINKLER_PREFIX_SCALE}. Boost only applies when the base
 * Jaro score crosses the promotion threshold — by convention this keeps
 * the metric from amplifying weak-overall agreement just because the
 * prefix happens to match.
 */
const DEFAULT_WINKLER_PREFIX_SCALE = 0.1;
const DEFAULT_WINKLER_PREFIX_CAP = 4;
const DEFAULT_WINKLER_PROMOTE_THRESHOLD = 0.7;

export interface JaroWinklerOptions {
  /** Per-character prefix weight `p`. Standard value: 0.1. */
  readonly prefixScale?: number;
  /** Maximum prefix length contributing to the boost. Standard cap: 4. */
  readonly prefixCap?: number;
  /** Below this Jaro score, no Winkler boost is applied. Standard: 0.7. */
  readonly promoteThreshold?: number;
}

/**
 * Jaro-Winkler similarity in [0, 1].
 *
 *   JW(a, b) = J(a, b) + ℓ · p · (1 − J(a, b))
 *
 * where `ℓ = min(commonPrefixLength, prefixCap)` and `p = prefixScale`,
 * applied only when J(a, b) ≥ `promoteThreshold`.
 *
 * Standard parameters from Winkler (1990) apply by default.
 */
export function jaroWinklerSimilarity(
  a: string,
  b: string,
  options: JaroWinklerOptions = {},
): number {
  const jaro = jaroSimilarity(a, b);
  const promoteThreshold = options.promoteThreshold ?? DEFAULT_WINKLER_PROMOTE_THRESHOLD;
  if (jaro < promoteThreshold) return jaro;

  const prefixScale = options.prefixScale ?? DEFAULT_WINKLER_PREFIX_SCALE;
  const prefixCap = options.prefixCap ?? DEFAULT_WINKLER_PREFIX_CAP;
  const maxPrefix = Math.min(prefixCap, a.length, b.length);
  let prefixLen = 0;
  for (let i = 0; i < maxPrefix; i++) {
    if (a.charAt(i) !== b.charAt(i)) break;
    prefixLen += 1;
  }
  return jaro + prefixLen * prefixScale * (1 - jaro);
}

/**
 * Edit-distance similarity in [0, 1] normalized against the longer input.
 * `similarity = 1 − distance / max(|a|, |b|)`. Returns 1 on empty-vs-empty
 * (canonical zero distance over the trivial pair).
 */
export function editDistanceSimilarity(a: string, b: string, distance: number): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - distance / maxLen;
}

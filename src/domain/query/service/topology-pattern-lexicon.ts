/**
 * Wave F1 — topology-pattern-lexicon SSoT.
 *
 * Single source of truth for the Korean + English keyword sets that drive
 * the deterministic topology detector (see
 * `./deterministic-topology-detector.ts`). CLAUDE.md rule 25 enforces one
 * vocabulary module per domain concept — this is the concept "phrases
 * that smell like XOR / multi-course pairing topology".
 *
 * ADR authority: any addition / removal / semantic change to the keyword
 * lists below is an ADR-012 amendment, not an ad-hoc edit. The priority
 * chain in ConstraintCompiler depends on these patterns being stable and
 * audited.
 *
 * Unicode-safety contract (CLAUDE.md rule 8):
 *  - Korean keywords are matched via whole-syllable `.includes()` — safe
 *    because Hangul characters are not ASCII-word characters and cannot
 *    be partially matched inside another Korean word without surrounding
 *    context (the detector itself guards against false positives by
 *    requiring accompanying course / XOR evidence).
 *  - English regexes use `(?:^|[^\p{L}\p{N}])...(?=$|[^\p{L}\p{N}])`
 *    lookaround pairs (single character class, not a 2-char sequence —
 *    rule 24) with the `/u` flag. `\b` is ASCII-only and silently fails
 *    around non-ASCII letters, so it is prohibited in this module.
 *
 * False-positive discipline (rule 23): every pattern in this file is
 * covered by a positive + negative regression case in
 * `test/regression/topology-pattern-lexicon.regression.test.ts`.
 */

// ─── XOR-smell keywords ──────────────────────────────────────────────────────

/**
 * Korean XOR markers. These words flag that the user is asking for
 * disjoint alternatives ("X or Y", "half and half", "separately").
 *
 * Korean whole-syllable matching is safe because these tokens don't
 * appear as substrings of common non-XOR Korean vocabulary in the wine
 * domain (a property the regression test covers).
 */
export const TOPOLOGY_XOR_KEYWORDS_KO: readonly string[] = [
  '또는',
  '반반',
  '각각',
  '따로',
];

/**
 * English XOR regex — standalone `either`, `or`, or `one ... other`
 * with Unicode-aware non-letter / non-digit boundaries.
 *
 * The `\s*` between "one" and "other" tolerates the LLM-linker's
 * occasional whitespace drift; `[\p{L}\p{N}\s]*?` is a lazy clause so
 * the match anchors on the nearest `other` rather than running away.
 */
export const TOPOLOGY_XOR_REGEX_EN: RegExp =
  /(?:^|[^\p{L}\p{N}])(?:either|or|one\s+[\p{L}\p{N}\s]*?\s+other)(?=$|[^\p{L}\p{N}])/iu;

/**
 * Returns true iff the query contains any XOR-smell keyword. Pure,
 * allocation-free, O(|query| × |KO keywords| + |EN regex|).
 */
export function matchesXorLexicon(query: string): boolean {
  for (const kw of TOPOLOGY_XOR_KEYWORDS_KO) {
    if (query.includes(kw)) return true;
  }
  return TOPOLOGY_XOR_REGEX_EN.test(query);
}

// ─── Multi-course (pairing) keywords ─────────────────────────────────────────

/**
 * Korean course markers. Each entry is a course label the user might
 * attach a dish to; the detector fires when ≥2 distinct entries appear
 * in the same query.
 */
export const TOPOLOGY_COURSE_KEYWORDS_KO: readonly string[] = [
  '메인',
  '디저트',
  '에피타이저',
  '전채',
  '애피타이저',
];

/**
 * English course regex — a single named course. The detector calls
 * `.match` with `/g` semantics (global) to count distinct course hits.
 * Multi-word courses like `main course` are listed explicitly so the
 * ambiguous bare `course` does not match (false-positive trap).
 */
/**
 * Exported **without** `/g` so `.test()` is stateless for external
 * callers. Helpers that need to iterate (`.exec()` loops) clone with
 * `/g` below. Stateful `lastIndex` on the shared export is a footgun —
 * two `.test()` calls in sequence would silently disagree on a known
 * match.
 */
export const TOPOLOGY_COURSE_REGEX_EN: RegExp =
  /(?:^|[^\p{L}\p{N}])(?:main\s+course|dessert|appetizer|appetiser|starter)(?=$|[^\p{L}\p{N}])/iu;

/**
 * Returns true iff the query contains ≥2 distinct course keywords. The
 * threshold enforces the "multi-course" semantics — a single "dessert"
 * alone is not enough to emit a multi-subquery topology.
 */
export function matchesCourseKeywords(query: string): boolean {
  const hit = new Set<string>();
  for (const kw of TOPOLOGY_COURSE_KEYWORDS_KO) {
    if (query.includes(kw)) hit.add(`ko:${kw}`);
  }
  // Collapse 애피타이저 / 에피타이저 / 전채 to a single "starter" bucket so
  // two spellings of the same course don't spuriously count as two.
  const starterAliases = ['에피타이저', '애피타이저', '전채'];
  const starterHit = starterAliases.some((s) => hit.has(`ko:${s}`));
  if (starterHit) {
    for (const s of starterAliases) hit.delete(`ko:${s}`);
    hit.add('ko:starter');
  }
  // English — use a fresh regex per call so /g state doesn't leak.
  // Clone with /g so exec() can iterate all matches — source export is
  // intentionally non-global to keep `.test()` stateless for external users.
  const enRegex = new RegExp(TOPOLOGY_COURSE_REGEX_EN.source, `${TOPOLOGY_COURSE_REGEX_EN.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = enRegex.exec(query)) !== null) {
    // Capture the course word itself (match includes its left boundary
    // so we normalise by stripping non-letter leads).
    const normalised = m[0].replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase();
    if (normalised.startsWith('main')) hit.add('en:main_course');
    else if (normalised.startsWith('dessert')) hit.add('en:dessert');
    else if (normalised.startsWith('appet') || normalised.startsWith('starter')) hit.add('en:starter');
  }
  return hit.size >= 2;
}

/**
 * Classified course hits — returned by the detector when it needs one
 * `subquery` node per detected course. Order is deterministic
 * (insertion-sorted by canonical course label).
 */
export interface ClassifiedCourseHit {
  readonly purpose: string;
}

/** Canonical course labels in insertion order. */
const CANONICAL_COURSE_ORDER: readonly string[] = [
  'appetizer',
  'main_course',
  'dessert',
];

/**
 * Returns the canonical course labels present in the query, deduped and
 * ordered by {@link CANONICAL_COURSE_ORDER}. Empty array when the
 * ≥2-course threshold is not met.
 */
export function classifyCourseHits(query: string): readonly ClassifiedCourseHit[] {
  if (!matchesCourseKeywords(query)) return [];
  const present = new Set<string>();
  // Korean mapping
  if (query.includes('메인')) present.add('main_course');
  if (query.includes('디저트')) present.add('dessert');
  if (
    query.includes('에피타이저') ||
    query.includes('애피타이저') ||
    query.includes('전채')
  ) {
    present.add('appetizer');
  }
  // English — reuse the course regex to classify
  // Clone with /g so exec() can iterate all matches — source export is
  // intentionally non-global to keep `.test()` stateless for external users.
  const enRegex = new RegExp(TOPOLOGY_COURSE_REGEX_EN.source, `${TOPOLOGY_COURSE_REGEX_EN.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = enRegex.exec(query)) !== null) {
    const normalised = m[0].replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase();
    if (normalised.startsWith('main')) present.add('main_course');
    else if (normalised.startsWith('dessert')) present.add('dessert');
    else if (normalised.startsWith('appet') || normalised.startsWith('starter')) present.add('appetizer');
  }
  return CANONICAL_COURSE_ORDER
    .filter((c) => present.has(c))
    .map((purpose) => ({ purpose }));
}

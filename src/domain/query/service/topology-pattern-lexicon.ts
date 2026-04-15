/**
 * Wave F1 / I1 — topology-pattern-lexicon SSoT.
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
 * Amendment history:
 *  - F1 (base): XOR keywords (`또는`, `반반`, `각각`, `따로`, `either/or`),
 *    course keywords (`메인`, `디저트`, `에피타이저`, `main course`, `dessert`,
 *    `appetizer`, `starter`).
 *  - H  (shared-budget): `총`/`합산`/`도합`/`합계`/`합쳐`/`전체` +
 *    `total`/`combined`/`altogether` with numeric amount or multi-subquery
 *    co-occurrence discipline.
 *  - I1 (this wave): XOR-negation patterns (`말고`/`빼고`/`외에는` +
 *    `not A but B`/`except X`/`other than`), disjunction markers (`아니면`,
 *    `혹은`, `and/or`, `whichever`), extended course vocabulary (`전식`,
 *    `본식`, `후식`, `샐러드 코스`, `entrée`, `salad course`,
 *    `cheese course`, `main dish`), broader shared-budget phrasing
 *    (`전체 예산`, `통틀어`, `모두 합해서`, `다 해서`, `in total`, `all in`,
 *    `spend up to`, `budget of`).
 *
 * Unicode-safety contract (CLAUDE.md rule 8):
 *  - Simple Korean keywords whose 2-4 syllables are not a substring of
 *    any plausible wine-domain word (e.g. `또는`, `합산`, `통틀어`) are
 *    matched via whole-syllable `.includes()`.
 *  - Korean tokens with known substring collisions (e.g. `말고` inside
 *    `말고기` "horse meat", `빼고` inside `빼고치다`, `아니면` inside
 *    `아니면서`) use a Unicode-aware boundary regex of the form
 *    `(?:^|[^\p{L}\p{N}])KEYWORD(?=$|[^\p{L}\p{N}])` with the `/u` flag.
 *    Rule 24: single character class — `[\p{L}\p{N}]` — not a two-char
 *    sequence `\p{L}\p{N}`.
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

// ─── XOR-negation keywords (Wave I1) ─────────────────────────────────────────

/**
 * Korean XOR-negation markers — "A 말고 B", "X 빼고 Y", "… 외에는 …".
 * These express the same disjoint-alternative semantics as the bare XOR
 * lexicon ("그 말고 다른 것 없어?") and feed the same `group_xor` topology
 * branch.
 *
 * Matched via a Unicode-aware boundary regex (NOT `.includes()`) because
 * the short 2-syllable forms have concrete substring collisions:
 *  - `말고` is a substring of `말고기` (horse meat). `.includes('말고')`
 *    would fire on "말고기 페어링" — a wine pairing query for horse meat
 *    would be wrongly flagged as an XOR query.
 *  - `빼고` is itself a conjugated verb that can appear in non-XOR
 *    contexts; requiring a boundary avoids latching onto compound forms.
 *  - `외에는` is rarer as a substring but kept under the same discipline.
 *
 * Rule 24: character class `[\p{L}\p{N}]`, not sequence `\p{L}\p{N}`.
 */
export const TOPOLOGY_XOR_NEGATION_KEYWORDS_KO: readonly string[] = [
  '말고',
  '빼고',
  '외에는',
];

/**
 * Unicode-safe boundary regex for the Korean negation keywords above.
 * Exported so the regression test can exercise each keyword against its
 * specific substring trap (e.g. `말고기`).
 */
export const TOPOLOGY_XOR_NEGATION_REGEX_KO: RegExp =
  /(?:^|[^\p{L}\p{N}])(?:말고|빼고|외에는)(?=$|[^\p{L}\p{N}])/u;

/**
 * English XOR-negation regex — `not A but B`, `except X`, `other than`.
 *
 * - `not\s+[\p{L}\p{N}]+\s+but` keeps the nominal A short (one word) so
 *   the `but` anchor is near; `[\p{L}\p{N}]+` tolerates accented Latin.
 * - `except\s+[\p{L}\p{N}]+` requires something follow `except` so the
 *   bare adverbial "except" doesn't fire.
 * - `other\s+than` — Rule 23: must NOT fire on "other wines" or "other
 *   than expected" in a non-choice context. The `other than` sequence
 *   requiring a following word is handled by downstream multi-wine-type
 *   atom requirement in the detector.
 *
 * Unicode-safe lookaround pair; source regex is non-`/g` so `.test()`
 * stays stateless.
 */
export const TOPOLOGY_XOR_NEGATION_REGEX_EN: RegExp =
  /(?:^|[^\p{L}\p{N}])(?:not\s+[\p{L}\p{N}]+\s+but|except\s+[\p{L}\p{N}]+|other\s+than)(?=$|[^\p{L}\p{N}])/iu;

// ─── Disjunction markers (Wave I1) ───────────────────────────────────────────

/**
 * Additional Korean disjunction markers — `아니면` (or, otherwise),
 * `혹은` (or, alternatively). Both are clean multi-syllable tokens with
 * minimal substring collision surface, but `아니면` can appear inside the
 * longer conjunction `아니면서` ("while not being…"), so it uses the
 * boundary regex below.
 */
export const TOPOLOGY_XOR_DISJUNCTION_KEYWORDS_KO: readonly string[] = [
  '아니면',
  '혹은',
];

/**
 * Unicode-safe regex form for the Korean disjunction markers. Exists so
 * the regression test can lock the `아니면` vs `아니면서` behaviour.
 */
export const TOPOLOGY_XOR_DISJUNCTION_REGEX_KO: RegExp =
  /(?:^|[^\p{L}\p{N}])(?:아니면|혹은)(?=$|[^\p{L}\p{N}])/u;

/**
 * English disjunction markers — `and/or`, `whichever`. `and/or` requires
 * an inline forward slash so we match it literally; `whichever` is a
 * single content word. Both feed the same XOR branch as `either … or`.
 */
export const TOPOLOGY_XOR_DISJUNCTION_REGEX_EN: RegExp =
  /(?:^|[^\p{L}\p{N}])(?:and\s*\/\s*or|whichever)(?=$|[^\p{L}\p{N}])/iu;

/**
 * Returns true iff the query contains any XOR-smell keyword — bare XOR,
 * negation-XOR, or disjunction marker. Pure, allocation-free.
 */
export function matchesXorLexicon(query: string): boolean {
  for (const kw of TOPOLOGY_XOR_KEYWORDS_KO) {
    if (query.includes(kw)) return true;
  }
  if (TOPOLOGY_XOR_REGEX_EN.test(query)) return true;
  if (TOPOLOGY_XOR_NEGATION_REGEX_KO.test(query)) return true;
  if (TOPOLOGY_XOR_NEGATION_REGEX_EN.test(query)) return true;
  if (TOPOLOGY_XOR_DISJUNCTION_REGEX_KO.test(query)) return true;
  if (TOPOLOGY_XOR_DISJUNCTION_REGEX_EN.test(query)) return true;
  return false;
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
  // Wave I1 — 전식 / 본식 / 후식 are the Sino-Korean course labels
  // ("pre-meal / main-meal / post-meal"). Distinctive multi-syllable
  // compounds; no known substring collisions in the wine / dining
  // vocabulary (cf. `말고` vs `말고기` trap — these words are safer).
  '전식',
  '본식',
  '후식',
];

/**
 * Multi-word Korean course phrases that we ONLY want to match when the
 * qualifier ` 코스` is present — this suppresses false positives on
 * standalone `샐러드` / `치즈` tokens which can appear as side-dish or
 * ingredient mentions rather than course labels.
 *
 * Rule 23 discipline: "샐러드와 빵 주세요" must NOT be parsed as
 * "salad course + bread" — it's a side + bread. Requiring `코스` anchors
 * the intent.
 */
export const TOPOLOGY_COURSE_PHRASES_KO: readonly string[] = [
  '샐러드 코스',
  '치즈 코스',
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
  /(?:^|[^\p{L}\p{N}])(?:main\s+course|main\s+dish|entr[ée]e|dessert|appetizer|appetiser|starter|salad\s+course|cheese\s+course)(?=$|[^\p{L}\p{N}])/iu;

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
  // Collapse 애피타이저 / 에피타이저 / 전채 / 전식 to a single "starter"
  // bucket (all canonicalize to `appetizer`) so two spellings of the
  // same course don't spuriously count as two.
  const starterAliases = ['에피타이저', '애피타이저', '전채', '전식'];
  const starterHit = starterAliases.some((s) => hit.has(`ko:${s}`));
  if (starterHit) {
    for (const s of starterAliases) hit.delete(`ko:${s}`);
    hit.add('ko:starter');
  }
  // Collapse 메인 / 본식 to a single "main_course" bucket.
  if (hit.has('ko:메인') || hit.has('ko:본식')) {
    hit.delete('ko:메인');
    hit.delete('ko:본식');
    hit.add('ko:main_course');
  }
  // Collapse 디저트 / 후식 to a single "dessert" bucket.
  if (hit.has('ko:디저트') || hit.has('ko:후식')) {
    hit.delete('ko:디저트');
    hit.delete('ko:후식');
    hit.add('ko:dessert');
  }
  // Anchored multi-word Korean phrases (샐러드 코스 / 치즈 코스). These
  // map to `appetizer` (salad course) and `dessert` (cheese course) per
  // the 3-bucket canonical vocabulary. Requiring the ` 코스` anchor is
  // the false-positive guard from rule 23.
  if (query.includes('샐러드 코스')) hit.add('ko:starter');
  if (query.includes('치즈 코스')) hit.add('ko:dessert');
  // English — use a fresh regex per call so /g state doesn't leak.
  // Clone with /g so exec() can iterate all matches — source export is
  // intentionally non-global to keep `.test()` stateless for external users.
  const enRegex = new RegExp(TOPOLOGY_COURSE_REGEX_EN.source, `${TOPOLOGY_COURSE_REGEX_EN.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = enRegex.exec(query)) !== null) {
    // Capture the course word itself (match includes its left boundary
    // so we normalise by stripping non-letter leads).
    const normalised = m[0].replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase();
    if (normalised.startsWith('main') || normalised.startsWith('entr')) {
      hit.add('en:main_course');
    } else if (normalised.startsWith('dessert') || normalised.startsWith('cheese')) {
      hit.add('en:dessert');
    } else if (
      normalised.startsWith('appet') ||
      normalised.startsWith('starter') ||
      normalised.startsWith('salad')
    ) {
      hit.add('en:starter');
    }
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
  // Korean mapping — collapse 메인/본식 → main_course, 디저트/후식 → dessert,
  // 에피타이저/애피타이저/전채/전식 → appetizer. The multi-word phrases
  // `샐러드 코스` and `치즈 코스` map to appetizer / dessert respectively
  // (rule 23: require the ` 코스` anchor to avoid "샐러드" / "치즈" as
  // side dishes / ingredients).
  if (query.includes('메인') || query.includes('본식')) {
    present.add('main_course');
  }
  if (query.includes('디저트') || query.includes('후식')) {
    present.add('dessert');
  }
  if (
    query.includes('에피타이저') ||
    query.includes('애피타이저') ||
    query.includes('전채') ||
    query.includes('전식')
  ) {
    present.add('appetizer');
  }
  if (query.includes('샐러드 코스')) present.add('appetizer');
  if (query.includes('치즈 코스')) present.add('dessert');
  // English — reuse the course regex to classify
  // Clone with /g so exec() can iterate all matches — source export is
  // intentionally non-global to keep `.test()` stateless for external users.
  const enRegex = new RegExp(TOPOLOGY_COURSE_REGEX_EN.source, `${TOPOLOGY_COURSE_REGEX_EN.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = enRegex.exec(query)) !== null) {
    const normalised = m[0].replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase();
    if (normalised.startsWith('main') || normalised.startsWith('entr')) {
      present.add('main_course');
    } else if (normalised.startsWith('dessert') || normalised.startsWith('cheese')) {
      present.add('dessert');
    } else if (
      normalised.startsWith('appet') ||
      normalised.startsWith('starter') ||
      normalised.startsWith('salad')
    ) {
      present.add('appetizer');
    }
  }
  return CANONICAL_COURSE_ORDER
    .filter((c) => present.has(c))
    .map((purpose) => ({ purpose }));
}

// ─── Shared-budget patterns (Wave H) ─────────────────────────────────────────

/**
 * Korean shared-budget markers. "총 X원" / "합산 예산" / "도합" —
 * any of these AND a course/subquery split present means the user's
 * budget is a cross-subquery resource (`shares_budget` edge). Whole-
 * syllable `.includes()` is safe for the same reasons as the XOR
 * lexicon.
 */
export const TOPOLOGY_SHARES_BUDGET_KEYWORDS_KO: readonly string[] = [
  '총',
  '합산',
  '도합',
  '합계',
  '합쳐',
  '전체',
  // Wave I1 — broader shared-budget phrasing.
  // `통틀어` (all together), `다 해서` (all in all), `전체 예산` (total
  // budget), `모두 합해서` (sum of all). Each is a multi-syllable /
  // multi-word phrase with no known substring collision in the wine
  // domain; `.includes()` is safe. The detector's co-occurrence rule
  // (numeric amount OR multi-subquery) still guards against false
  // positives on loose phrases like `다 해서`.
  '통틀어',
  '전체 예산',
  '모두 합해서',
  '다 해서',
];

/**
 * English shared-budget regex. Matches `total`, `combined`, `altogether`,
 * `all together`, `under $X`, `under N KRW` and similar phrases that
 * signal a cross-subquery budget envelope. Unicode-safe lookaround pair;
 * no `/g` on the export.
 */
export const TOPOLOGY_SHARES_BUDGET_REGEX_EN: RegExp =
  /(?:^|[^\p{L}\p{N}])(?:total(?:ly)?|combined|altogether|all\s+together|overall\s+budget|in\s+total|all\s+in|spend\s+up\s+to|budget\s+of)(?=$|[^\p{L}\p{N}])/iu;

/**
 * KRW / USD numeric budget pattern, e.g. `15만원`, `150,000 KRW`,
 * `$300`, `300 usd`. Positive match means a numeric money amount is
 * present — used in conjunction with a course/subquery signal to
 * promote the budget to `shares_budget` semantics.
 */
export const TOPOLOGY_BUDGET_AMOUNT_REGEX: RegExp =
  /(?:[0-9][0-9.,]*\s*(?:만원|원|krw|usd|달러)|[$₩]\s*[0-9][0-9.,]*)/iu;

/**
 * Returns true iff the query carries a shared-budget signal AND either
 * a numeric amount OR a multi-course/XOR decomposition hint. The hint
 * is caller-supplied — the detector passes it through from the
 * planner-level decomposition analyser.
 *
 * Contract: false-positive discipline — a bare "총" without any
 * numeric amount or multi-course evidence is NOT enough; typical
 * Korean phrasing uses "총" in many contexts.
 */
export function matchesSharedBudgetHint(input: {
  readonly query: string;
  readonly hasMultiSubquery: boolean;
}): boolean {
  const { query, hasMultiSubquery } = input;
  // Keyword presence (cheap).
  let keywordHit = false;
  for (const kw of TOPOLOGY_SHARES_BUDGET_KEYWORDS_KO) {
    if (query.includes(kw)) { keywordHit = true; break; }
  }
  if (!keywordHit && !TOPOLOGY_SHARES_BUDGET_REGEX_EN.test(query)) {
    return false;
  }
  // Must co-occur with a monetary amount OR a multi-subquery decomposition.
  // Either signal alone is too noisy ("총" appears in non-budget Korean).
  if (TOPOLOGY_BUDGET_AMOUNT_REGEX.test(query)) return true;
  return hasMultiSubquery;
}

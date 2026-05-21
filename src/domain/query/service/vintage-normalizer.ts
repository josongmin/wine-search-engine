/**
 * 2-digit vintage shorthand → 4-digit candidate expansion.
 *
 * Wine queries routinely abbreviate vintages: "Margaux 15", "CM 18",
 * "Opus 22". The standard ETL canonicalises vintages to 4-digit form, so
 * the runtime resolver only matches "Château Margaux 2015" — the 2-digit
 * variant misses unless we explicitly expand it.
 *
 * Expansion is **deterministic** (no heuristic disambiguation):
 *  - Given `dd` (the 2-digit token) and `nowYear`, the primary century
 *    is chosen by the rule below; the secondary century is the other
 *    century's same-dd year.
 *  - Both candidates are emitted as lookupVariants. The resolver / ranker
 *    decides which to prefer based on alias / catalog evidence.
 *
 * Century-inference rule (Wikipedia "Two-digit year" convention adapted
 * to the wine domain — vintages range 1850 → present + 2):
 *
 *   let cc = nowYear % 100      // current century's two-digit form
 *   if dd <= cc + 5 → primary = 20YY (current century)
 *   else            → primary = 19YY (previous century)
 *   secondary       = primary ± 100
 *
 * Vintages outside `[MIN_VINTAGE, nowYear + MAX_FUTURE_VINTAGE_OFFSET]`
 * are discarded — wines from before MIN_VINTAGE don't exist in the
 * commercial catalog, and far-future vintages are typos.
 */

/** Earliest commercially-relevant wine vintage. */
const MIN_VINTAGE = 1850;

/** Inclusive max for a two-digit year token (00–99). */
const TWO_DIGIT_YEAR_MAX = 99;

/** Two-digit modulus — `nowYear % CENTURY_MODULUS` gives the current dd. */
const CENTURY_MODULUS = 100;

/**
 * Maximum years ahead of `nowYear` to allow as a valid future vintage.
 *
 * Must match {@link CURRENT_CENTURY_BUFFER} — otherwise the century-
 * inference buffer chooses a current-century primary that the future-year
 * filter then drops, producing only the previous-century secondary and
 * silently breaking the documented `[primary, secondary]` invariant.
 */
const MAX_FUTURE_VINTAGE_OFFSET = 5;

/**
 * Inclusive upper bound on `dd` (relative to `cc = nowYear % 100`) that is
 * still interpreted as belonging to the *current* century. Beyond this,
 * the previous century becomes the primary candidate.
 *
 * Example: in 2026 (cc=26), `dd=31` is current-century 2031 (just inside
 * the buffer); `dd=32` flips to previous-century 1932 as the primary.
 */
const CURRENT_CENTURY_BUFFER = MAX_FUTURE_VINTAGE_OFFSET;

/** Word-boundary class for Unicode-safe vintage detection (CLAUDE.md rule 8). */
const WORD_BOUNDARY = '(?:^|[^\\p{L}\\p{N}])';
const WORD_BOUNDARY_END = '(?=$|[^\\p{L}\\p{N}])';

const TWO_DIGIT_VINTAGE_PATTERN = new RegExp(
  `${WORD_BOUNDARY}(\\d{2})${WORD_BOUNDARY_END}`,
  'gu',
);

const FOUR_DIGIT_VINTAGE_PATTERN = new RegExp(
  `${WORD_BOUNDARY}(\\d{4})${WORD_BOUNDARY_END}`,
  'u',
);

/**
 * Expands a single 2-digit year into one or two 4-digit candidates by
 * century inference. Returns `[primary, secondary]` ordered by likelihood,
 * filtered to the commercially-relevant range.
 */
export function expandTwoDigitVintage(
  twoDigit: number,
  options: { readonly nowYear?: number } = {},
): readonly number[] {
  if (!Number.isInteger(twoDigit) || twoDigit < 0 || twoDigit > TWO_DIGIT_YEAR_MAX) {
    return [];
  }
  const nowYear = options.nowYear ?? new Date().getFullYear();
  const cc = nowYear % CENTURY_MODULUS;
  const maxAllowed = nowYear + MAX_FUTURE_VINTAGE_OFFSET;

  const currentCentury = nowYear - cc + twoDigit;
  const previousCentury = currentCentury - CENTURY_MODULUS;
  const nextCentury = currentCentury + CENTURY_MODULUS;

  const isPrimaryCurrent = twoDigit <= cc + CURRENT_CENTURY_BUFFER;
  const primary = isPrimaryCurrent ? currentCentury : previousCentury;
  const secondary = isPrimaryCurrent ? previousCentury : currentCentury;
  // Two-digit close to 0 in the current century also has a plausible
  // next-century reading once we're past mid-century, but for wine we
  // intentionally cap at the current/previous pair — future vintages
  // beyond MAX_FUTURE_VINTAGE_OFFSET are excluded below.
  void nextCentury;

  const candidates = [primary, secondary];
  return candidates.filter((year) => year >= MIN_VINTAGE && year <= maxAllowed);
}

/**
 * Scans `query` for an isolated 2-digit token and emits a lookupVariant
 * string where that token is replaced by the **primary** 4-digit
 * candidate (current century when within the buffer; previous century
 * otherwise).
 *
 * The secondary-century candidate is intentionally suppressed — wine
 * shorthand in modern usage overwhelmingly intends the current century,
 * and emitting the secondary "Margaux 1915" candidate for a query of
 * "Margaux 15" dilutes the resolver's candidate pool with a vintage
 * that almost never matches the catalog. Older vintages are
 * conventionally written in full (four digits) and bypass this
 * expander entirely.
 *
 * Behaviour:
 *  - If the query already contains a 4-digit year, no expansion runs.
 *    (The caller already has an unambiguous vintage.)
 *  - Only the first 2-digit token is expanded — multi-vintage queries
 *    are out of scope.
 */
export function expandVintageVariants(
  query: string,
  options: { readonly nowYear?: number } = {},
): readonly string[] {
  if (query.length === 0) return [];
  if (FOUR_DIGIT_VINTAGE_PATTERN.test(query)) return [];

  TWO_DIGIT_VINTAGE_PATTERN.lastIndex = 0;
  const first = TWO_DIGIT_VINTAGE_PATTERN.exec(query);
  if (first === null) return [];

  const captureGroup = first[1];
  if (captureGroup === undefined) return [];
  const twoDigit = Number.parseInt(captureGroup, 10);
  const candidates = expandTwoDigitVintage(twoDigit, options);
  const primary = candidates[0];
  if (primary === undefined) return [];

  const matchStart = first.index;
  const matchedSlice = first[0];
  const digitOffset = matchedSlice.search(/\d/);
  if (digitOffset < 0) return [];
  const tokenStart = matchStart + digitOffset;
  const tokenEnd = tokenStart + 2;

  const prefix = query.slice(0, tokenStart);
  const suffix = query.slice(tokenEnd);
  return [`${prefix}${primary}${suffix}`];
}

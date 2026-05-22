/**
 * Region breadcrumb normalizer — deterministic reversal of a precisely
 * characterized data-corruption signature in `silver-trackc.ndjson`.
 *
 * ## The corruption (exactly characterized, not heuristically inferred)
 *
 * A subset of Silver records carry a malformed flat `region` string that is a
 * concatenation of TWO fragments scraped from the same source breadcrumb:
 *
 *   1. a short SUMMARY (`Country` or `Country / Leaf`), followed by
 *   2. the FULL hierarchical path (`Country / ... / Leaf`).
 *
 * Because the summary always begins with the country and the full path also
 * begins with the same country, the corruption is identifiable by the EXACT
 * structural invariant: **`segments[0]` (the country) occurs a SECOND time
 * later in the split.** Everything before that second occurrence is the
 * duplicated summary prefix (plus, in some scraped rows, a `"Read more"` UI
 * artifact); everything from the second occurrence onward is the canonical
 * hierarchical path.
 *
 * Observed forms in the corpus (all reversed by the same rule):
 *   - "Spain / Ribera del Duero / Spain / Castilla y León / Ribera del Duero"
 *        summary = [Spain, Ribera del Duero]; path = [Spain, Castilla y León, Ribera del Duero]
 *   - "United States / Napa Valley / United States / California / North Coast / Napa County / Napa Valley"
 *        summary = [United States, Napa Valley]; path = [United States, California, North Coast, Napa County, Napa Valley]
 *   - "United States / United States"
 *        summary = [United States]; path = [United States]   (degenerate, country only)
 *   - "Australia / McLaren Vale / Read more / Australia / South Australia / Fleurieu / McLaren Vale"
 *        summary+artifact = [Australia, McLaren Vale, Read more]; path = [Australia, ...] (Read more sits BEFORE the
 *        second country occurrence, so slicing at that occurrence drops it cleanly)
 *
 * ## The reversal (deterministic — NOT a heuristic)
 *
 * - No " / " in the raw value  → already clean → returned UNTOUCHED, no inference.
 * - " / " present and `segments[0]` repeats later → the corruption signature is
 *   present; the canonical path is `segments[secondOccurrenceIndex..]`.
 * - " / " present but `segments[0]` does NOT repeat → a genuine multi-level
 *   breadcrumb without the duplicated-prefix corruption → the whole split is
 *   treated as the canonical path (no segments dropped).
 *
 * From the resolved canonical path:
 *   - `region`            = the LAST segment (most specific node).
 *   - `regionHierarchy`   = the ordered path with exact consecutive/duplicate
 *                            segments removed (order preserved).
 *
 * ## Appellation: intentionally NOT derived (documented gap, not a guess)
 *
 * The Silver `appellation` field is 0% populated and there is no authoritative
 * appellation source in the record. The breadcrumb path is positional only:
 * its leaf may be a region (e.g. "Marlborough") or an appellation (e.g.
 * "Ribera del Duero"), and distinguishing the two requires a gazetteer the
 * pipeline does not have. Assigning "appellation" purely from path DEPTH would
 * be a content guess, which the project execution baseline forbids. We
 * therefore leave `appellation` undefined and surface the gap rather than
 * fabricating it. (See report: requires upstream authoritative data.)
 */

/** Canonical breadcrumb separator used by the upstream scrape. */
export const REGION_BREADCRUMB_SEPARATOR = ' / ';

/**
 * Result of normalizing a raw region string.
 *
 * `region` is always present (the most-specific node, or the untouched clean
 * input). `hierarchy` is present only when the input was a breadcrumb with more
 * than one distinct node. `appellation` is always undefined — see module header
 * for why it is intentionally not derived.
 */
export interface NormalizedRegion {
  /** Canonical, most-specific region node. */
  readonly region: string;
  /** Ordered, de-duplicated hierarchical path; undefined for plain inputs. */
  readonly hierarchy: readonly string[] | undefined;
  /** Always undefined — appellation is not deterministically derivable here. */
  readonly appellation: string | undefined;
}

/**
 * De-duplicates an ordered path while preserving order: drops any segment that
 * exactly equals a segment already emitted. This collapses the
 * "Country ... Country" style repeats and any leaf that re-appears.
 */
function dedupeOrdered(segments: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const seg of segments) {
    if (seen.has(seg)) continue;
    seen.add(seg);
    out.push(seg);
  }
  return out;
}

/**
 * Normalizes a raw Silver `region` string, deterministically reversing the
 * duplicated-prefix breadcrumb corruption. Clean inputs pass through untouched.
 *
 * @param rawRegion the raw `region` value from a Silver record.
 * @returns the canonical region, hierarchy (when multi-level), and appellation
 *   (always undefined; see module header).
 */
export function normalizeRegion(rawRegion: string): NormalizedRegion {
  const trimmed = rawRegion.trim();

  // Case 1: no separator → already a plain region → untouched, no inference.
  if (!trimmed.includes(REGION_BREADCRUMB_SEPARATOR)) {
    return { region: trimmed, hierarchy: undefined, appellation: undefined };
  }

  const segments = trimmed
    .split(REGION_BREADCRUMB_SEPARATOR)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Defensive: a string of only separators/whitespace collapses to nothing.
  // Fall back to the trimmed input as the region (no hierarchy claim).
  if (segments.length === 0) {
    return { region: trimmed, hierarchy: undefined, appellation: undefined };
  }
  if (segments.length === 1) {
    return { region: segments[0]!, hierarchy: undefined, appellation: undefined };
  }

  // Detect the duplicated-prefix corruption EXACTLY: the country (segments[0])
  // re-appears later. The canonical path begins at that SECOND occurrence.
  const head = segments[0]!;
  const secondOccurrenceIndex = segments.indexOf(head, 1);

  const canonicalPath =
    secondOccurrenceIndex > 0
      ? segments.slice(secondOccurrenceIndex) // corruption: drop summary + any artifact before the repeat
      : segments; // genuine multi-level breadcrumb, no duplicated prefix

  const hierarchy = dedupeOrdered(canonicalPath);

  // region = most specific (last) node of the canonical path.
  const region = hierarchy[hierarchy.length - 1]!;

  return {
    region,
    // Only surface a hierarchy when it carries more than the single leaf.
    hierarchy: hierarchy.length > 1 ? hierarchy : undefined,
    appellation: undefined,
  };
}

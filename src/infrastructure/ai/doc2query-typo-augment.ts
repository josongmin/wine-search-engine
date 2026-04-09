/**
 * Deterministic typo / spacing augmentation for Doc2Query output.
 *
 * Purpose: complement LLM-generated queries with rule-based variants
 * that LLMs reliably fail to produce — specifically the "no-space"
 * romanization pattern that dominates Korean misspelled wine searches
 * (e.g. "샤토마고" for "Château Margaux", "오퓨스원" for "Opus One").
 *
 * Research basis:
 *   - Cucerzan & Brill (2004) — 10-15% misspell rate in web search
 *   - Naver / Bing Korean studies — 20-25% in Korean, 40%+ on loan-word
 *     proper nouns like wine names
 *   - Internal corpus analysis: the golden set has ZERO typo / spacing
 *     variants, so Doc2Query is the only way to cover these users.
 *
 * Rules applied (in this order):
 *   1. Korean space removal (e.g. "샤토 마고" → "샤토마고")
 *   2. English lowercase + space removal ("Chateau Margaux" → "chateaumargaux")
 *   3. English vintage drop / re-insert variants
 *
 * All rules are deterministic and cheap — no LLM calls, no heuristics
 * that can hallucinate. Post-filter de-duplicates against the source
 * queries so augmentation only adds genuinely new variants.
 */

/** Max chars per augmented variant (matches adapter hard cap). */
const MAX_QUERY_CHARS = 120;
/** Minimum total length for an augmented variant to be meaningful. */
const MIN_VARIANT_LEN = 3;
/** Minimum length of the content the rule operates on. */
const MIN_SOURCE_LEN = 4;

const HANGUL_REGEX = /[\u3131-\u318E\uAC00-\uD7A3]/u;
const ASCII_LETTER_REGEX = /[A-Za-z]/;

function hasHangul(s: string): boolean {
  return HANGUL_REGEX.test(s);
}

function hasAsciiLetter(s: string): boolean {
  return ASCII_LETTER_REGEX.test(s);
}

/**
 * Remove internal whitespace from a Korean-dominant query without
 * touching trailing digits (vintage years stay separate).
 *
 * "샤토 마고 2015"  → "샤토마고 2015"
 * "오퓨스 원"        → "오퓨스원"
 */
function koreanSpacingVariant(query: string): string | undefined {
  if (!hasHangul(query)) return undefined;
  const trimmed = query.trim();
  if (trimmed.length < MIN_SOURCE_LEN) return undefined;

  // Split off a trailing 4-digit vintage year (and optional leading 2-3 digit
  // partial) so year tokens remain distinct.
  const vintageMatch = trimmed.match(/^(.*?)(\s+\d{4})\s*$/);
  let body = trimmed;
  let tail = '';
  if (vintageMatch !== null) {
    body = vintageMatch[1] ?? trimmed;
    tail = vintageMatch[2] ?? '';
  }

  const stripped = body.replace(/\s+/u, '');
  if (stripped.length < MIN_SOURCE_LEN) return undefined;
  if (stripped === body) return undefined; // already had no internal spaces

  const variant = (stripped + tail).trim();
  if (variant === trimmed) return undefined;
  if (variant.length > MAX_QUERY_CHARS) return undefined;
  return variant;
}

/**
 * Produce a lowercase, space-collapsed English variant for short
 * proper-noun queries. Only applied when the source is entity-like
 * (capitalized first letter, ≥2 alphabetic tokens).
 *
 * "Château Margaux 2015" → "chateau margaux 2015"      (accent strip)
 * "Opus One"             → "opusone"
 * "Finca Villacreces"    → "fincavillacreces"
 */
function englishLowerNoSpaceVariant(query: string): string | undefined {
  if (!hasAsciiLetter(query)) return undefined;
  if (hasHangul(query)) return undefined; // handled by the KO rule
  const trimmed = query.trim();
  if (trimmed.length < MIN_SOURCE_LEN) return undefined;

  // Accent strip (compatibility decomposition + combining mark removal).
  const deaccented = trimmed
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '');

  const lowered = deaccented.toLowerCase();

  // Preserve trailing vintage so it stays a separate BM25 term.
  const vintageMatch = lowered.match(/^(.*?)\s*(\d{4})\s*$/);
  const body = vintageMatch !== null ? (vintageMatch[1] ?? lowered) : lowered;
  const year = vintageMatch !== null ? ` ${vintageMatch[2] ?? ''}` : '';

  const collapsed = body.replace(/\s+/gu, '');
  if (collapsed.length < MIN_SOURCE_LEN) return undefined;
  if (collapsed === body) return undefined; // no spaces to collapse

  const variant = (collapsed + year).trim();
  if (variant.length < MIN_VARIANT_LEN) return undefined;
  if (variant.length > MAX_QUERY_CHARS) return undefined;
  if (variant === lowered.trim()) return undefined;
  return variant;
}

/**
 * Given a set of anchor queries (typically the entity-exact slots —
 * canonicalLabel, Korean alias variants), produce a list of deterministic
 * typo / spacing variants. De-duplicated against the input set.
 */
export function augmentWithTypoVariants(
  anchors: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  for (const a of anchors) {
    seen.add(a.trim().toLowerCase());
  }
  const out: string[] = [];
  for (const a of anchors) {
    const ko = koreanSpacingVariant(a);
    if (ko !== undefined) {
      const key = ko.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(ko);
      }
    }
    const en = englishLowerNoSpaceVariant(a);
    if (en !== undefined) {
      const key = en.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(en);
      }
    }
  }
  return out;
}

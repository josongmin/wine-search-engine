import type { NormalizedConstraint } from '../../shared/types/index.js';

/**
 * Vespa `style` field stores compound strings: "medium red", "bold red", "light red",
 * "medium white", "full white". The field uses `attribute` indexing only (no full-text
 * index), so `contains` does NOT do substring matching on multi-token strings.
 * We must use `matches` (regex substring) in YQL, which requires a `style_matches:`
 * token prefix so `buildSparseFilters` emits the right clause.
 *
 * This map normalises agent/planner emitted style values to the canonical Vespa
 * style prefix that will match via `matches`. Values not in this map are escaped
 * as regex literals (see escapeVespaRegex) before being passed to buildSparseFilters,
 * preventing LLM-emitted metacharacters from acting as Vespa (Java) regex patterns.
 *
 * SSoT for style value normalisation. Do not duplicate in agent-tools or elsewhere.
 */
const STYLE_NORMALISATION_MAP: ReadonlyMap<string, string> = new Map([
  // Body/weight synonyms → match the compound "X red"/"X white" values
  ['light', 'light'],
  ['light-bodied', 'light'],
  ['light bodied', 'light'],
  ['medium', 'medium'],
  ['medium-bodied', 'medium'],
  ['medium bodied', 'medium'],
  ['full', 'full'],
  ['full-bodied', 'full'],
  ['full bodied', 'full'],
  ['bold', 'bold'],
  ['heavy', 'bold'],
  ['rich', 'bold'],
  // Oaked — not a Vespa style value, no match possible; skip (return empty)
  ['oaked', ''],
  ['unoaked', ''],
  ['oak', ''],
]);

/**
 * Vespa `price_band` field stores single-token enum values: "value", "mid",
 * "premium", "luxury". Maps common agent/planner values to these canonical tokens.
 *
 * SSoT for price_band normalisation.
 */
const PRICE_BAND_NORMALISATION_MAP: ReadonlyMap<string, string> = new Map([
  ['budget', 'value'],
  ['value', 'value'],
  ['affordable', 'value'],
  ['cheap', 'value'],
  ['inexpensive', 'value'],
  ['mid', 'mid'],
  ['mid-range', 'mid'],
  ['mid range', 'mid'],
  ['moderate', 'mid'],
  ['premium', 'premium'],
  ['high-end', 'premium'],
  ['high end', 'premium'],
  ['expensive', 'premium'],
  ['luxury', 'luxury'],
  ['ultra-premium', 'luxury'],
  ['ultra premium', 'luxury'],
  ['fine', 'luxury'],
]);

/**
 * Escapes a string so it is treated as a literal (non-special) pattern by
 * Vespa's `matches` operator, which uses Java regex syntax. Without escaping,
 * LLM-emitted style values containing `.`, `*`, `+`, `?`, `(`, `)`, etc. act
 * as regex wildcards, matching unintended wines or causing Vespa to throw a
 * PatternSyntaxException.
 *
 * The canonical `STYLE_NORMALISATION_MAP` values (light, medium, full, bold)
 * are already safe literals — this function guards the fallthrough path for
 * unrecognised values that pass through unchanged.
 */
function escapeVespaRegex(value: string): string {
  // Java regex special characters: \.[]{}()*+?^$|
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Maps planner hard constraints to Vespa sparse filter tokens understood by
 * {@link buildSparseFilters} (`src/infrastructure/vespa/mapping.ts`).
 *
 * Skips attributes that cannot be expressed as index filters or would
 * duplicate lexical intent (e.g. free-text `region` without a schema filter).
 */
export function hardConstraintsToSparseFilterTokens(
  constraints: readonly NormalizedConstraint[],
): readonly string[] {
  const out: string[] = [];
  for (const c of constraints) {
    out.push(...constraintToSparseFilterTokens(c));
  }
  return out;
}

function constraintToSparseFilterTokens(
  c: NormalizedConstraint,
): readonly string[] {
  const { attribute, operator, value } = c;

  const stringEq = (key: string): readonly string[] => {
    if (operator === '=' && typeof value === 'string' && value.length > 0) {
      // Strip pipe to prevent token-delimiter injection: a pipe in a single value
      // would be misinterpreted by buildSparseFilters as a multi-value delimiter.
      const safe = value.replace(/\|/g, '');
      if (safe.length === 0) return [];
      return [`${key}:${safe}`];
    }
    if (operator === 'in' && Array.isArray(value)) {
      // Strip pipe chars from individual values: pipe is the token delimiter used by
      // buildSparseFilters to split multi-value tokens. A pipe inside a value would
      // cause silent semantic corruption — "France|Italy" as one value would be split
      // into two separate filter terms. Strip to prevent this injection vector.
      const normalized = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        .map((entry) => entry.replace(/\|/g, ''));
      const nonempty = normalized.filter((entry) => entry.length > 0);
      if (nonempty.length === 1) return [`${key}:${nonempty[0]}`];
      // Multi-value IN: emit pipe-delimited token so buildSparseFilters can
      // produce a Vespa OR clause instead of silently dropping the constraint.
      if (nonempty.length > 1) return [`${key}_in:${nonempty.join('|')}`];
      return [];
    }
    // Negation operators: emit <key>_not tokens for downstream YQL NOT clauses.
    if (operator === 'exclude') {
      if (typeof value === 'string' && value.length > 0) {
        const safe = value.replace(/\|/g, '');
        if (safe.length === 0) return [];
        return [`${key}_not:${safe}`];
      }
      if (Array.isArray(value)) {
        // Same pipe-stripping as 'not_in' array branch above.
        const normalized = value
          .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
          .map((entry) => entry.replace(/\|/g, ''))
          .filter((entry) => entry.length > 0);
        if (normalized.length === 0) return [];
        if (normalized.length === 1) return [`${key}_not:${normalized[0]}`];
        return [`${key}_not_in:${normalized.join('|')}`];
      }
    }
    if (operator === 'not_in' && Array.isArray(value)) {
      // Same pipe-stripping: see 'in' branch above.
      const normalized = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        .map((entry) => entry.replace(/\|/g, ''));
      const nonempty = normalized.filter((entry) => entry.length > 0);
      if (nonempty.length === 1) return [`${key}_not:${nonempty[0]}`];
      // Multi-value NOT IN: emit pipe-delimited token so buildSparseFilters can
      // produce individual Vespa NOT clauses for each value.
      if (nonempty.length > 1) return [`${key}_not_in:${nonempty.join('|')}`];
      return [];
    }
    return [];
  };

  switch (attribute) {
    case 'wine_type':
      return stringEq('wine_type');
    case 'country':
      return stringEq('country');
    case 'region':
      return stringEq('region');
    case 'appellation':
      return stringEq('appellation');
    case 'pairing':
      return stringEq('pairing');
    case 'occasion':
      return stringEq('occasion');
    case 'grape_primary':
      // Exclusion must cover BOTH grape fields in the schema:
      // grape_primary (string) and grapes (array<string>).
      if (operator === 'exclude' && typeof value === 'string' && value.length > 0) {
        const safe = value.replace(/\|/g, '');
        if (safe.length === 0) return [];
        return [`grape_primary_not:${safe}`, `grapes_not:${safe}`];
      }
      if (operator === 'exclude' && Array.isArray(value)) {
        // Array exclude: must cover both grape_primary (string) and grapes (array<string>).
        // Strip pipes to prevent token-delimiter injection.
        const normalized = value
          .filter((e): e is string => typeof e === 'string' && e.length > 0)
          .map((e) => e.replace(/\|/g, ''))
          .filter((e) => e.length > 0);
        if (normalized.length === 0) return [];
        if (normalized.length === 1) {
          return [`grape_primary_not:${normalized[0]}`, `grapes_not:${normalized[0]}`];
        }
        const joined = normalized.join('|');
        return [`grape_primary_not_in:${joined}`, `grapes_not_in:${joined}`];
      }
      if (operator === 'not_in' && Array.isArray(value)) {
        // Strip pipes to prevent token-delimiter injection (same as stringEq branch).
        const normalized = value.filter((e): e is string => typeof e === 'string' && e.length > 0)
          .map((e) => e.replace(/\|/g, ''))
          .filter((e) => e.length > 0);
        if (normalized.length === 0) return [];
        const joined = normalized.join('|');
        // Single value: use _not form; multiple: use _not_in pipe-delimited form.
        // Both emit for grape_primary AND grapes fields.
        if (normalized.length === 1) {
          return [`grape_primary_not:${normalized[0]}`, `grapes_not:${normalized[0]}`];
        }
        return [`grape_primary_not_in:${joined}`, `grapes_not_in:${joined}`];
      }
      // Positive = / in: use `grape_or:` compound token so buildSparseFilters
      // emits (grape_primary contains "X" OR grapes contains "X").
      // Previously emitted two separate tokens (grape_primary:X + grapes:X) which
      // buildSparseFilters combined as AND — meaning blend wines where the requested
      // variety is only in grapes[] but NOT grape_primary were EXCLUDED. OR is correct.
      if (operator === '=' && typeof value === 'string' && value.length > 0) {
        const safe = value.replace(/\|/g, '');
        if (safe.length === 0) return [];
        return [`grape_or:${safe}`];
      }
      if (operator === 'in' && Array.isArray(value)) {
        const normalized = value.filter((e): e is string => typeof e === 'string' && e.length > 0)
          .map((e) => e.replace(/\|/g, ''))
          .filter((e) => e.length > 0);
        if (normalized.length === 0) return [];
        if (normalized.length === 1) {
          return [`grape_or:${normalized[0]}`];
        }
        const joined = normalized.join('|');
        return [`grape_or_in:${joined}`];
      }
      return [];
    // IDX-05 NOTE — SOFT_CONSTRAINT_ATTRIBUTES and hard filter cases:
    // style, price_band, flavor_profile, certification are in SOFT_CONSTRAINT_ATTRIBUTES
    // (preference signals routed to the soft bundle by constraint-compiler.ts). However
    // their cases are intentionally kept here because the *exclusion* operators
    // (exclude / not_in) produce hard NOT-filters even for soft attributes — users saying
    // "no oaky style" or "not certified biodynamic" mean a hard exclusion, not a penalty.
    // stringEq() only emits tokens for =, in, exclude, not_in; positive '=' or 'in'
    // constraints reach this function only via direct calls, not the production path.
    case 'style': {
      // style field uses attribute-only indexing — `contains` fails on multi-token values
      // like "light red". Use `style_matches:` token so buildSparseFilters emits `matches`
      // (regex substring).
      //
      // Exclusion operators must normalise synonyms before emitting the NOT token.
      // Without normalisation, `style exclude "full-bodied"` emits `style_not:full-bodied`
      // → Vespa `!(style contains "full-bodied")` which never matches `"full red"` (the
      // canonical stored value), causing the exclusion to silently no-op.
      // With normalisation, it emits `style_not:full` → `!(style contains "full")` which
      // correctly excludes any wine whose style field contains "full" (e.g. "full red").
      if (operator === 'exclude' && typeof value === 'string' && value.length > 0) {
        const normalised = STYLE_NORMALISATION_MAP.get(value.toLowerCase()) ?? value.toLowerCase();
        if (normalised.length === 0) return []; // known non-indexable (oaked/unoaked)
        const safe = normalised.replace(/\|/g, '');
        if (safe.length === 0) return [];
        return [`style_not:${safe}`];
      }
      if (operator === 'not_in' && Array.isArray(value)) {
        const normalised = value
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
          .map((v) => STYLE_NORMALISATION_MAP.get(v.toLowerCase()) ?? v.toLowerCase())
          .filter((v) => v.length > 0) // drop oaked/unoaked (maps to "")
          .map((v) => v.replace(/\|/g, ''))
          .filter((v) => v.length > 0);
        if (normalised.length === 0) return [];
        if (normalised.length === 1) return [`style_not:${normalised[0]}`];
        return [`style_not_in:${normalised.join('|')}`];
      }
      if (operator === '=' && typeof value === 'string' && value.length > 0) {
        const lower = value.toLowerCase();
        // Canonical values (light, medium, full, bold) are safe regex literals.
        // Unknown fallthrough values must be escaped before Vespa `matches` (Java regex).
        const normalised = STYLE_NORMALISATION_MAP.has(lower)
          ? (STYLE_NORMALISATION_MAP.get(lower) as string)
          : escapeVespaRegex(lower);
        if (normalised.length === 0) return []; // known non-indexable value (e.g. "oaked")
        return [`style_matches:${normalised}`];
      }
      if (operator === 'in' && Array.isArray(value)) {
        // Multi-value style: normalise each value and emit pipe-delimited style_matches_in token.
        // buildSparseFilters handles style_matches_in with `matches` operator (not `contains`).
        const normalised = value
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
          .map((v) => {
            const lower = v.toLowerCase();
            return STYLE_NORMALISATION_MAP.has(lower)
              ? (STYLE_NORMALISATION_MAP.get(lower) as string)
              : escapeVespaRegex(lower);
          })
          .filter((v) => v.length > 0); // drop oaked/unoaked (normalised to "")
        if (normalised.length === 0) return [];
        if (normalised.length === 1) return [`style_matches:${normalised[0]}`];
        return [`style_matches_in:${normalised.join('|')}`];
      }
      return [];
    }
    case 'price_band': {
      // price_band stores single-token enums ("value", "mid", "premium", "luxury").
      // Normalise synonyms before emitting the filter token.
      //
      // Exclusion operators must normalise synonyms before emitting the NOT token.
      // Without normalisation, `price_band exclude "expensive"` emits `price_band_not:expensive`
      // → Vespa `!(price_band contains "expensive")` which never matches `"premium"` (the
      // canonical stored value), causing the exclusion to silently no-op.
      if (operator === 'exclude' && typeof value === 'string' && value.length > 0) {
        const normalised = PRICE_BAND_NORMALISATION_MAP.get(value.toLowerCase()) ?? value.toLowerCase();
        if (normalised.length === 0) return [];
        const safe = normalised.replace(/\|/g, '');
        if (safe.length === 0) return [];
        return [`price_band_not:${safe}`];
      }
      if (operator === 'not_in' && Array.isArray(value)) {
        const normalised = value
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
          .map((v) => PRICE_BAND_NORMALISATION_MAP.get(v.toLowerCase()) ?? v.toLowerCase())
          .map((v) => v.replace(/\|/g, ''))
          .filter((v) => v.length > 0);
        if (normalised.length === 0) return [];
        if (normalised.length === 1) return [`price_band_not:${normalised[0]}`];
        return [`price_band_not_in:${normalised.join('|')}`];
      }
      if (operator === '=' && typeof value === 'string' && value.length > 0) {
        const normalised = PRICE_BAND_NORMALISATION_MAP.get(value.toLowerCase()) ?? value.toLowerCase();
        if (normalised.length === 0) return [];
        return [`price_band:${normalised}`];
      }
      if (operator === 'in' && Array.isArray(value)) {
        // Multi-value price_band: normalise each synonym and emit pipe-delimited _in token.
        const normalised = value
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
          .map((v) => PRICE_BAND_NORMALISATION_MAP.get(v.toLowerCase()) ?? v.toLowerCase())
          .map((v) => v.replace(/\|/g, '')) // strip pipe to prevent token-delimiter injection
          .filter((v) => v.length > 0);
        if (normalised.length === 0) return [];
        if (normalised.length === 1) return [`price_band:${normalised[0]}`];
        return [`price_band_in:${normalised.join('|')}`];
      }
      return [];
    }
    case 'grape_family':
      return stringEq('grape_family');
    case 'flavor_profile':
      return stringEq('flavor_profile');
    case 'classification':
      return stringEq('classification');
    case 'certification':
      return stringEq('certification');
    case 'soil_type':
      return stringEq('soil_type');
    case 'producer_type':
      return stringEq('producer_type');

    // IDX-05: acidity, tannin, body, finish_length, critic_score, producer_prestige are SOFT
    // (penalty-only numeric signals). constraint-compiler.ts routes all
    // SOFT_CONSTRAINT_ATTRIBUTES to the soft bundle, so these never reach
    // hardConstraintsToSparseFilterTokens in production. Cases removed to prevent the
    // footgun where a direct call silently generates a hard filter that collapses recall.
    // drinking_window is also SOFT — same reasoning, case removed below.
    // Ref: SOFT_CONSTRAINT_ATTRIBUTES in src/shared/constants/constraint-attributes.ts

    case 'price':
    case 'price_usd': {
      if (operator === 'range' && isNumericRange(value)) {
        // Normalise reversed ranges: a caller emitting { min: 200, max: 50 } would otherwise
        // produce `price_usd >= 200 AND price_usd <= 50` — always false, 0 results.
        const lo = Math.min(value.min, value.max);
        const hi = Math.max(value.min, value.max);
        return [`price_usd_min:${lo}`, `price_usd_max:${hi}`];
      }
      if (operator === '<=' && typeof value === 'number' && Number.isFinite(value)) {
        return [`price_usd_max:${value}`];
      }
      if (operator === '>=' && typeof value === 'number' && Number.isFinite(value)) {
        return [`price_usd_min:${value}`];
      }
      return [];
    }

    case 'vintage':
    case 'vintage_year': {
      if (operator === 'range' && isNumericRange(value)) {
        // Normalise reversed ranges for the same reason as price_usd above.
        const lo = Math.floor(Math.min(value.min, value.max));
        const hi = Math.floor(Math.max(value.min, value.max));
        return [`vintage_year_min:${lo}`, `vintage_year_max:${hi}`];
      }
      if (operator === '>=' && typeof value === 'number' && Number.isFinite(value)) {
        return [`vintage_year_min:${Math.floor(value)}`];
      }
      if (operator === '<=' && typeof value === 'number' && Number.isFinite(value)) {
        return [`vintage_year_max:${Math.floor(value)}`];
      }
      return [];
    }

    // IDX-05 (extended): critic_score and producer_prestige are also SOFT_CONSTRAINT_ATTRIBUTES —
    // preference signals, not hard identity filters. Cases removed for the same reason above.

    // IDX-05 (drinking_window): drinking_window is SOFT_CONSTRAINT_ATTRIBUTES — it is a
    // preference signal ("ready to drink in 2026"), not a hard identity constraint. Hard-
    // filtering on it collapses recall to near-zero for most queries. Case removed; the
    // soft ranking path handles this via Vespa rank-profile scoring, not a WHERE clause.

    case 'alcohol':
    case 'alcohol_pct': {
      // Range operator: { min, max } → both floor and ceiling tokens.
      // Normalise reversed ranges (min > max) the same way price_usd and vintage_year do —
      // a reversed range would produce `alcohol_pct >= 20 AND alcohol_pct <= 10` which is
      // always false and returns 0 results.
      if (operator === 'range' && isNumericRange(value)) {
        const lo = Math.min(value.min, value.max);
        const hi = Math.max(value.min, value.max);
        const tokens: string[] = [];
        if (Number.isFinite(lo)) tokens.push(`alcohol_min:${lo}`);
        if (Number.isFinite(hi)) tokens.push(`alcohol_max:${hi}`);
        return tokens;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) return [];
      if (operator === '>=') return [`alcohol_min:${value}`];
      if (operator === '<=') return [`alcohol_max:${value}`];
      if (operator === '=') return [`alcohol_min:${value}`, `alcohol_max:${value}`];
      return [];
    }

    default:
      return [];
  }
}

function isNumericRange(
  v: NormalizedConstraint['value'],
): v is { min: number; max: number } {
  const x: unknown = v;
  if (typeof x !== 'object' || x === null || Array.isArray(x)) {
    return false;
  }
  if (!('min' in x) || !('max' in x)) {
    return false;
  }
  const rec = x as { min: unknown; max: unknown };
  return (
    typeof rec.min === 'number' && Number.isFinite(rec.min) &&
    typeof rec.max === 'number' && Number.isFinite(rec.max)
  );
}

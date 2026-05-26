import type { NormalizedConstraint } from '../../shared/types/index.js';

/**
 * P1.A — Soft→hard confidence-gated promotion.
 *
 * Confidence floor at or above which a soft constraint may be promoted to a
 * Vespa filter token. The 0.8 floor matches the planner's tier-1/tier-2
 * confidence emission for rule-based and entity-resolver paths; below this
 * the constraint is treated as low-confidence preference, not retrieval filter.
 */
const SOFT_PROMOTION_DEFAULT_CONFIDENCE_FLOOR = 0.8;

/**
 * Mapping versions whose output is trustworthy enough to be promoted from a
 * soft signal into a Vespa retrieval filter. These are the deterministic
 * tier-1 (rule-based + curated nl-mapper) and tier-2 (entity-resolver) outputs
 * whose semantics are fully audited. LLM-sourced or planner-inferred soft
 * constraints stay soft regardless of confidence — they have no
 * replay-deterministic guarantee.
 *
 * `v1.0` is the curated DEFAULT_MAPPING_VERSION used by `nl-mapper.ts`. The
 * nl-mapper vocabulary is a hand-audited static Map (`DEFAULT_MAPPINGS`) —
 * every entry has a fixed (operator, value, confidence) tuple, identical to
 * the deterministic guarantees of `rule-based-v1.0`. Excluding it from the
 * trust list (the pre-C1b state) is what caused high-confidence Korean
 * attribute extractions (e.g. "저알콜" → `alcohol_pct <= 12`) to never reach
 * Vespa as a YQL filter — they were silently demoted to ranking-only boosts.
 */
const SOFT_PROMOTION_ALLOWED_MAPPING_VERSIONS: ReadonlySet<string> = new Set([
  'rule-based-v1.0',
  'entity-resolver-v1.0',
  'v1.0',
]);

/**
 * Per-attribute promotion spec for SOFT constraints → Vespa filter tokens.
 *
 * `minKey` / `maxKey` map a numeric soft constraint to the registered
 * `<key>_min` / `<key>_max` filter token in
 * `src/infrastructure/vespa/mapping.ts` (FILTER_TOKEN_REGISTRY). We do NOT
 * duplicate the YQL translation here — emitting the registered token key
 * routes the constraint through the same buildSparseFilters path used for
 * hard constraints.
 *
 * `stringKey` maps an `=` / `in` string-valued soft constraint to a Vespa
 * `contains` filter token (registry entries like `flavor_profile`,
 * `certification`).
 *
 * Attributes NOT in this table are intentionally excluded from promotion:
 *  - `drinking_window` — two-sided semantic (start ≤ year ≤ end); no single
 *    `_min`/`_max` translation that does not silently break recall on one half.
 *  - `style` — multi-token compound regex (`style_matches:`); needs explicit
 *    style-normalisation before YQL emission (see `case 'style'` in
 *    `constraintToSparseFilterTokens`).
 *  - `price_band` — categorical enum; soft preference signals only.
 *  - `body` / `tannin` / `acidity` — sensory sliders for ranking; the
 *    `body_min` promotion is intentionally MIN-only to avoid over-pruning
 *    fuller-body recall, matching the historical SOTA++ default.
 *
 * Field-level promotion semantics:
 *  - **MIN-only attributes** (`critic_score`, `body`, `producer_prestige`,
 *    `gift_suitability`, `beginner_suitability`): a user asking for "high X"
 *    has no implicit ceiling. Promoting a MAX would silently exclude the best
 *    candidates. So `maxKey` is omitted for these.
 *  - **Symmetric numeric attributes** (`alcohol_pct`, `sweetness`):
 *    BOTH MIN and MAX bounds reflect explicit user intent — "저알콜"
 *    (low alcohol) is a MAX ceiling, "high alcohol" hypothetically is a MIN
 *    floor; "달콤한" sweetness is a MIN floor, "드라이" / "달지 않은" is a MAX
 *    ceiling. Both directions must promote to actually filter.
 *  - **String-contains attributes** (`flavor_profile`, `certification`):
 *    `=` with a single string value → `<key>:<value>` (Vespa `contains`).
 *    `in` with an array → `<key>_in:<v1>|<v2>` (multi-value OR).
 */
interface SoftPromotionSpec {
  /** Vespa filter token key for `>=` / `=` numeric / `range.min` bounds. */
  readonly minKey?: string;
  /** Vespa filter token key for `<=` / `range.max` bounds. Undefined → MIN-only attribute. */
  readonly maxKey?: string;
  /** Vespa filter token base key for `=` / `in` string-contains. */
  readonly stringKey?: string;
}

const SOFT_PROMOTION_TOKEN_SPEC: ReadonlyMap<string, SoftPromotionSpec> = new Map([
  // MIN-only numeric attributes — historical SOTA++ default. MAX intentionally
  // omitted to prevent over-pruning on the unbounded-high end of user intent.
  ['critic_score',         { minKey: 'critic_score_min' }],
  ['body',                 { minKey: 'body_min' }],
  ['producer_prestige',    { minKey: 'producer_prestige_min' }],
  ['gift_suitability',     { minKey: 'gift_suitability_min' }],
  ['beginner_suitability', { minKey: 'beginner_suitability_min' }],
  // Symmetric numeric attributes — BOTH directions are valid explicit intents.
  // C1b regression: "저알콜" / "도수 낮은" / "드라이" / "달지 않은" must filter.
  ['alcohol_pct', { minKey: 'alcohol_min', maxKey: 'alcohol_max' }],
  ['alcohol',     { minKey: 'alcohol_min', maxKey: 'alcohol_max' }],
  ['sweetness',   { minKey: 'sweetness_min', maxKey: 'sweetness_max' }],
  ['price_usd',   { minKey: 'price_usd_min', maxKey: 'price_usd_max' }],
  // String-contains attributes — `=` / `in` operators only.
  ['flavor_profile', { stringKey: 'flavor_profile' }],
  ['certification',  { stringKey: 'certification' }],
]);

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
      // Positive price-band intent is candidate-shaping / bounded lexical expansion,
      // not a hard retrieval filter. Keep only exclusion operators here.
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
    // Ref: SOFT_CONSTRAINT_ATTRIBUTES in src/domain/shared/constants/constraint-attributes.ts

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

/**
 * Options controlling the confidence-gated promotion of soft constraints
 * into sparse filter tokens.
 */
interface SoftPromotionOptions {
  /**
   * Confidence floor (inclusive). Soft constraints with `confidence` below
   * this value are NEVER promoted. Defaults to
   * {@link SOFT_PROMOTION_DEFAULT_CONFIDENCE_FLOOR} (0.8).
   */
  readonly confidenceFloor?: number;
}

/**
 * P1.A + C1b — Confidence-gated promotion of SOFT constraints into Vespa
 * filter tokens.
 *
 * The constraint-compiler keeps high-confidence preference signals
 * (`critic_score`, `body`, `alcohol_pct`, `sweetness`, `flavor_profile`, …)
 * in {@link ConstraintBundle.soft} so the ranker can apply graceful penalties
 * rather than 0-result hard cuts. Historically these never reached YQL —
 * meaning queries like "평점 좋은 와인" (P1.A) and "저알콜 와인" (C1b)
 * never tightened retrieval below the full corpus.
 *
 * This function performs a NARROW, principled promotion: each soft constraint
 * is converted into the same `<key>_min` / `<key>_max` / `<key>:` filter
 * token used by hard constraints IFF every gate passes:
 *
 *   1. `confidence >= confidenceFloor` (default 0.8 — the tier-1/tier-2 floor)
 *   2. `mapping_version ∈ SOFT_PROMOTION_ALLOWED_MAPPING_VERSIONS`
 *      (deterministic curated/rule-based/entity-resolver outputs only —
 *      no LLM-sourced or planner-inferred promotion)
 *   3. `attribute ∈ SOFT_PROMOTION_TOKEN_SPEC` (only attributes with an
 *      explicit promotion spec — see {@link SoftPromotionSpec} for the
 *      attribute-level MIN/MAX/string semantics)
 *   4. The operator/value combination yields one of:
 *        - `=` / `>=` numeric value → MIN floor (if `spec.minKey` defined)
 *        - `<=` numeric value       → MAX ceiling (if `spec.maxKey` defined)
 *        - `range` { min, max }     → MIN floor + MAX ceiling (each gated on its
 *          spec key, so MIN-only attributes only emit the floor)
 *        - `=` string value         → `<key>:<value>` contains
 *        - `in` array of strings    → `<key>_in:<v1>|<v2>` multi-value OR
 *        - `exclude` / `not_in`     → skipped (negation is hard-pathed in
 *          `constraintToSparseFilterTokens` regardless of soft attribute)
 *
 * NEVER duplicates the YQL translation: the emitted token is consumed by
 * `buildSparseFilters` in `src/infrastructure/vespa/mapping.ts`, identical
 * to the hard-constraint path.
 *
 * @returns Filter tokens for the promoted constraints, in stable input order.
 */
export function softConstraintsToOptionalFilterTokens(
  constraints: readonly NormalizedConstraint[],
  options: SoftPromotionOptions = {},
): readonly string[] {
  const floor = options.confidenceFloor ?? SOFT_PROMOTION_DEFAULT_CONFIDENCE_FLOOR;
  const out: string[] = [];
  for (const c of constraints) {
    if (!Number.isFinite(c.confidence) || c.confidence < floor) {
      continue;
    }
    if (c.mapping_version === undefined
      || !SOFT_PROMOTION_ALLOWED_MAPPING_VERSIONS.has(c.mapping_version)) {
      continue;
    }
    const spec = SOFT_PROMOTION_TOKEN_SPEC.get(c.attribute);
    if (spec === undefined) {
      continue;
    }
    out.push(...softConstraintToPromotionTokens(c, spec));
  }
  return out;
}

/**
 * Emits zero or more promotion tokens for a single soft constraint given its
 * attribute's {@link SoftPromotionSpec}. Pure function — no I/O, no shared
 * state — so callers may invoke it under cooperative-abort loops without
 * stalling.
 *
 * Each branch is gated on BOTH the operator/value shape and the presence of
 * the corresponding spec key. This is what makes MIN-only attributes safe:
 * even though "<=" syntactically supports a MAX bound, an attribute spec
 * lacking `maxKey` (e.g. `critic_score`) will emit nothing for that operator.
 */
function softConstraintToPromotionTokens(
  c: NormalizedConstraint,
  spec: SoftPromotionSpec,
): readonly string[] {
  const { operator, value } = c;
  const out: string[] = [];

  if (operator === '=' || operator === '>=') {
    if (typeof value === 'number' && Number.isFinite(value) && spec.minKey !== undefined) {
      out.push(`${spec.minKey}:${value}`);
      return out;
    }
    // `=` with a string value → string-contains promotion (flavor_profile,
    // certification). Strip pipe to prevent token-delimiter injection — pipe
    // is the multi-value separator used by buildSparseFilters.
    if (
      operator === '='
      && typeof value === 'string'
      && value.length > 0
      && spec.stringKey !== undefined
    ) {
      const safe = value.replace(/\|/g, '');
      if (safe.length > 0) {
        out.push(`${spec.stringKey}:${safe}`);
      }
      return out;
    }
    return out;
  }

  if (operator === '<=') {
    if (typeof value === 'number' && Number.isFinite(value) && spec.maxKey !== undefined) {
      out.push(`${spec.maxKey}:${value}`);
    }
    return out;
  }

  if (operator === 'range' && isNumericRange(value)) {
    // Normalize reversed ranges so `{ min: 5, max: 2 }` still yields sane bounds.
    const lo = Math.min(value.min, value.max);
    const hi = Math.max(value.min, value.max);
    if (spec.minKey !== undefined) {
      out.push(`${spec.minKey}:${lo}`);
    }
    // MIN-only attributes (spec.maxKey undefined) intentionally emit ONLY the
    // floor — historical SOTA++ default to avoid over-pruning on the
    // unbounded-high end of "high X" intent.
    if (spec.maxKey !== undefined) {
      out.push(`${spec.maxKey}:${hi}`);
    }
    return out;
  }

  if (operator === 'in' && Array.isArray(value) && spec.stringKey !== undefined) {
    // Multi-value string `in` — emit pipe-delimited `_in` token. Buildsparsefilters
    // turns this into a Vespa OR clause. Strip pipes from individual values to
    // prevent the token-delimiter injection vector.
    const normalized = value
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      .map((entry) => entry.replace(/\|/g, ''))
      .filter((entry) => entry.length > 0);
    if (normalized.length === 1) {
      out.push(`${spec.stringKey}:${normalized[0]}`);
      return out;
    }
    if (normalized.length > 1) {
      out.push(`${spec.stringKey}_in:${normalized.join('|')}`);
    }
    return out;
  }

  // All other operator/value shapes (exclude, not_in, =/in with mismatched
  // value type) intentionally skipped — caller falls through.
  return out;
}

/**
 * Set of attribute names whose hard-constraint variants have an explicit `case`
 * branch in {@link constraintToSparseFilterTokens} — i.e. the compile path
 * KNOWS how to turn (attribute, operator, value) into one or more registered
 * Vespa filter tokens when used as a hard constraint.
 *
 * Kept in lock-step with the `switch (attribute)` block above. Adding a new
 * `case` branch REQUIRES adding the attribute here. The constraint validator
 * (`constraint-validator.ts`) consumes this SSoT so unrecognized attributes
 * can be detected at compile time rather than silently dropped at YQL
 * emission time.
 *
 * Tokens emitted by the compile path are themselves validated against
 * FILTER_TOKEN_REGISTRY in `mapping.ts` — this set names the planner-facing
 * attribute, not the Vespa-facing token key.
 */
export const HARD_FILTERABLE_ATTRIBUTES: ReadonlySet<string> = new Set([
  'wine_type',
  'country',
  'region',
  'appellation',
  'pairing',
  'occasion',
  'grape_primary',
  'style',
  'price_band',
  'grape_family',
  'flavor_profile',
  'classification',
  'certification',
  'soil_type',
  'producer_type',
  'price',
  'price_usd',
  'vintage',
  'vintage_year',
  'alcohol',
  'alcohol_pct',
]);

/**
 * Set of attribute names that {@link softConstraintsToOptionalFilterTokens}
 * KNOWS how to promote into Vespa filter tokens when the soft-constraint
 * confidence/mapping-version gates pass. Derived from
 * {@link SOFT_PROMOTION_TOKEN_SPEC} so the validator stays in sync with the
 * promotion spec automatically.
 *
 * A constraint whose attribute is in {@link HARD_FILTERABLE_ATTRIBUTES} but
 * NOT in this set is "hard-only": placing it in the soft bundle means the
 * intent never reaches Vespa as a WHERE filter (it can only contribute to
 * ranking via the soft-boost path in `retrieval-plan-builder.ts`).
 */
export const SOFT_PROMOTABLE_ATTRIBUTES: ReadonlySet<string> = new Set(
  SOFT_PROMOTION_TOKEN_SPEC.keys(),
);

/**
 * Classification of a constraint's representability as a Vespa sparse filter
 * token, used by the constraint-validator to detect silent-drop bugs at
 * compile time.
 *
 *  - `hard_filterable`     — the attribute has a `case` branch in
 *                            {@link constraintToSparseFilterTokens}; placing
 *                            this constraint in the hard bundle will produce
 *                            registered Vespa filter tokens (provided the
 *                            operator/value combination is supported).
 *  - `soft_promotable`     — the attribute has an entry in
 *                            {@link SOFT_PROMOTION_TOKEN_SPEC}; placing this
 *                            constraint in the soft bundle CAN produce a
 *                            Vespa filter token (if confidence and
 *                            mapping_version gates pass).
 *  - `unknown_attribute`   — the attribute appears in NEITHER set; the
 *                            compile path will silently drop it. This is a
 *                            planner / extractor bug — UNLESS the caller
 *                            recognises the attribute as a ranking-only
 *                            SOFT_CONSTRAINT_ATTRIBUTE (the validator
 *                            consults that set explicitly).
 */
export type ConstraintRepresentability =
  | 'hard_filterable'
  | 'soft_promotable'
  | 'unknown_attribute';

/**
 * Returns the {@link ConstraintRepresentability} classification for a single
 * constraint attribute. Used by the constraint-validator.
 *
 * Pure function: no I/O, no shared state. Safe to call from compile-time
 * audits and inside cooperative-abort loops.
 */
export function classifyConstraintRepresentability(
  attribute: string,
): ConstraintRepresentability {
  // soft_promotable takes priority — promotion implies the attribute also
  // appears in the hard switch (every SOFT_PROMOTION_TOKEN_SPEC key has a
  // matching hard `case`), and the soft tier is the higher-information
  // classification for the validator's purposes.
  if (SOFT_PROMOTABLE_ATTRIBUTES.has(attribute)) return 'soft_promotable';
  if (HARD_FILTERABLE_ATTRIBUTES.has(attribute)) return 'hard_filterable';
  return 'unknown_attribute';
}

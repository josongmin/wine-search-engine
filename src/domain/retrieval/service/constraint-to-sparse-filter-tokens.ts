import type { NormalizedConstraint } from '../../shared/types/index.js';

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
      return [`${key}:${value}`];
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
    if (operator === 'exclude' && typeof value === 'string' && value.length > 0) {
      return [`${key}_not:${value.replace(/\|/g, '')}`];
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
    case 'grape_primary':
      // Exclusion must cover BOTH grape fields in the schema:
      // grape_primary (string) and grapes (array<string>).
      if (operator === 'exclude' && typeof value === 'string' && value.length > 0) {
        const safe = value.replace(/\|/g, '');
        if (safe.length === 0) return [];
        return [`grape_primary_not:${safe}`, `grapes_not:${safe}`];
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
      // Positive = / in: must cover BOTH grape fields so blends are included.
      // grape_primary (string) holds the dominant variety; grapes (array<string>)
      // holds all varieties for multi-grape blends. Filtering only grape_primary
      // misses blend wines where the requested variety is secondary.
      // buildSparseFilters handles `grape_primary_in:` (OR clause) and
      // `grapes_in:` (OR clause) independently — both must be emitted.
      if (operator === '=' && typeof value === 'string' && value.length > 0) {
        const safe = value.replace(/\|/g, '');
        if (safe.length === 0) return [];
        return [`grape_primary:${safe}`, `grapes:${safe}`];
      }
      if (operator === 'in' && Array.isArray(value)) {
        const normalized = value.filter((e): e is string => typeof e === 'string' && e.length > 0)
          .map((e) => e.replace(/\|/g, ''))
          .filter((e) => e.length > 0);
        if (normalized.length === 0) return [];
        if (normalized.length === 1) {
          return [`grape_primary:${normalized[0]}`, `grapes:${normalized[0]}`];
        }
        const joined = normalized.join('|');
        return [`grape_primary_in:${joined}`, `grapes_in:${joined}`];
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
    case 'style':
      return stringEq('style');
    case 'price_band':
      return stringEq('price_band');
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
        return [`price_usd_min:${value.min}`, `price_usd_max:${value.max}`];
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
        return [
          `vintage_year_min:${Math.floor(value.min)}`,
          `vintage_year_max:${Math.floor(value.max)}`,
        ];
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

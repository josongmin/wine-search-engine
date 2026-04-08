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
      return stringEq('grape_primary');
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

    case 'body': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return [];
      }
      if (operator === '>=') return [`body_min:${value}`];
      if (operator === '<=') return [`body_max:${value}`];
      if (operator === '=') return [`body_min:${value}`, `body_max:${value}`];
      return [];
    }

    case 'acidity': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [];
      if (operator === '>=') return [`acidity_min:${value}`];
      if (operator === '<=') return [`acidity_max:${value}`];
      if (operator === '=') return [`acidity_min:${value}`, `acidity_max:${value}`];
      return [];
    }

    case 'tannin': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [];
      if (operator === '>=') return [`tannin_min:${value}`];
      // '<=' is the key case for "타닌 낮은" queries — was previously silently dropped
      if (operator === '<=') return [`tannin_max:${value}`];
      if (operator === '=') return [`tannin_min:${value}`, `tannin_max:${value}`];
      return [];
    }

    case 'finish_length': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [];
      if (operator === '>=') return [`finish_length_min:${value}`];
      if (operator === '<=') return [`finish_length_max:${value}`];
      if (operator === '=') return [`finish_length_min:${value}`, `finish_length_max:${value}`];
      return [];
    }

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

    case 'critic_score':
    case 'critic_score_normalized': {
      if (
        (operator === '>=' || operator === '=') &&
        typeof value === 'number' &&
        Number.isFinite(value)
      ) {
        return [`critic_score_min:${value}`];
      }
      return [];
    }

    case 'producer_prestige': {
      if (
        (operator === '>=' || operator === '=') &&
        typeof value === 'number' &&
        Number.isFinite(value)
      ) {
        return [`producer_prestige_min:${value}`];
      }
      return [];
    }

    case 'alcohol':
    case 'alcohol_pct': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [];
      if (operator === '>=') return [`alcohol_min:${value}`];
      if (operator === '<=') return [`alcohol_max:${value}`];
      if (operator === '=') return [`alcohol_min:${value}`, `alcohol_max:${value}`];
      return [];
    }

    case 'drinking_window': {
      if (operator === '=' && typeof value === 'number' && Number.isFinite(value)) {
        return [`drinking_window_now:${Math.floor(value)}`];
      }
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

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
      const normalized = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
      if (normalized.length === 1) return [`${key}:${normalized[0]}`];
      // Multi-value IN: emit pipe-delimited token so buildSparseFilters can
      // produce a Vespa OR clause instead of silently dropping the constraint.
      if (normalized.length > 1) return [`${key}_in:${normalized.join('|')}`];
      return [];
    }
    // Negation operators: emit not_<key> tokens for downstream YQL NOT clauses.
    if (operator === 'exclude' && typeof value === 'string' && value.length > 0) {
      return [`not_${key}:${value}`];
    }
    if (operator === 'not_in' && Array.isArray(value)) {
      const normalized = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
      if (normalized.length === 1) return [`not_${key}:${normalized[0]}`];
      // Multi-value NOT IN: emit pipe-delimited token so buildSparseFilters can
      // produce individual Vespa NOT clauses for each value.
      if (normalized.length > 1) return [`not_${key}_in:${normalized.join('|')}`];
      return [];
    }
    return [];
  };

  switch (attribute) {
    case 'wine_type':
      return stringEq('wine_type');
    case 'country':
      return stringEq('country');
    case 'appellation':
      return stringEq('appellation');
    case 'grape_primary':
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
      if ((operator === '>=' || operator === '=') && typeof value === 'number' && Number.isFinite(value)) {
        return [`acidity_min:${value}`];
      }
      return [];
    }

    case 'tannin': {
      if ((operator === '>=' || operator === '=') && typeof value === 'number' && Number.isFinite(value)) {
        return [`tannin_min:${value}`];
      }
      return [];
    }

    case 'finish_length': {
      if ((operator === '>=' || operator === '=') && typeof value === 'number' && Number.isFinite(value)) {
        return [`finish_length_min:${value}`];
      }
      return [];
    }

    case 'price':
    case 'price_usd': {
      if (operator === 'range' && isNumericRange(value)) {
        return [`price_usd_min:${value.min}`, `price_usd_max:${value.max}`];
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

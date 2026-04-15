/**
 * Safe numeric coercion helpers (SSoT).
 *
 * `Number(x)` and `parseFloat(x)` produce `NaN` on non-numeric input, and
 * `NaN` silently propagates through every comparison (always false). The
 * helpers in this module wrap the coercion + finiteness check into one
 * call so that downstream code can never accidentally feed `NaN` into
 * arithmetic, sorting, or filtering.
 *
 * They also exist so that semgrep `wine-number-without-finite-guard` is
 * satisfied at every external-input boundary — each call site delegates
 * to a function that does the guard inline.
 */

/**
 * Coerce an unknown value to a finite number, or return `null` if the
 * coercion produces a non-finite result. Use this at every boundary that
 * receives data from HTTP, JSON, environment variables, or external APIs.
 *
 * @example
 *   const port = toFiniteNumber(process.env.PORT) ?? DEFAULT_PORT;
 */
export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Coerce an unknown value to a finite integer, or return `null` if the
 * coercion produces a non-finite or non-integer result.
 */
export function toFiniteInteger(value: unknown): number | null {
  const n = toFiniteNumber(value);
  if (n === null) return null;
  return Number.isInteger(n) ? n : null;
}

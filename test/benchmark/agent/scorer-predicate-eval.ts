/**
 * Predicate evaluation for expectedToolArgs structured checks.
 *
 * Extracted from `scorer.ts` during the 2026-05-25/26 decomposition (round 9.1).
 *
 * Public surface:
 *   - `evaluatePredicate` — dot-path predicate branches (unit-tested via scorer.ts re-export).
 *
 * `getNestedValue` / `formatToolArgValue` are module-internal helpers consumed by
 * {@link ./scorer-structured-checks.ts}.
 */

import { stableJsonStringify } from './scorer-tool-call-signatures.js';

/** Navigate a nested object by dot-path: "filters.priceMaxKrw" */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function formatToolArgValue(value: unknown): string {
  if (value === undefined) return '<missing>';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return stableJsonStringify(value);
}

/** Evaluate a predicate against a value
 * @internal exported for direct unit testing of predicate branches. */
export function evaluatePredicate(
  actual: unknown,
  predicate: 'equals' | 'equals_any' | 'lte' | 'gte' | 'contains' | 'contains_any' | 'exists',
  expected?: unknown,
): boolean {
  switch (predicate) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'equals':
      return actual === expected;
    case 'equals_any':
      return Array.isArray(expected) && expected.some((candidate) => actual === candidate);
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'contains':
      if (Array.isArray(actual)) {
        return actual.some((entry) => {
          if (typeof entry === 'string' && typeof expected === 'string') {
            return entry.toLowerCase().includes(expected.toLowerCase());
          }
          return entry === expected;
        });
      }
      return typeof actual === 'string' && typeof expected === 'string'
        && actual.toLowerCase().includes(expected.toLowerCase());
    case 'contains_any':
      if (!Array.isArray(expected)) {
        return false;
      }
      return expected.some((candidate) => evaluatePredicate(actual, 'contains', candidate));
    default:
      return false;
  }
}

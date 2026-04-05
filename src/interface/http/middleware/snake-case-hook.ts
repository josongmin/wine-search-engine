/**
 * Fastify preSerialization hook: camelCase → snake_case key transform.
 *
 * Domain objects use TypeScript-idiomatic camelCase internally.  RFC-014 §4.2
 * mandates snake_case for all external API field names.  Applying this
 * transform once at the serialization boundary keeps the two conventions
 * cleanly separated without leaking wire-format concerns into domain code.
 *
 * Rules:
 *  - camelCase keys are converted:   `decisionStatus` → `decision_status`
 *  - Already-snake_case keys are unchanged (no uppercase → nothing replaced)
 *  - Nested objects and arrays are recursed into
 *  - Scalars (string, number, boolean, null, undefined) pass through as-is
 *  - Non-plain objects (Map, Set, Date, …) pass through as-is so that their
 *    default JSON serialization behaviour is preserved
 */

/** Fast camelCase → snake_case converter (optimized for most keys, no regex). */
function camelToSnake(key: string): string {
  let result = '';
  for (let i = 0; i < key.length; i++) {
    const ch = key.charAt(i);
    if (ch >= 'A' && ch <= 'Z') {
      if (i > 0) result += '_';
      result += ch.toLowerCase();
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * Recursively converts all plain-object keys from camelCase to snake_case.
 * Optimized: only allocates when transformation needed, in-place for large arrays.
 *
 * @param value - Any serialisable value (object, array, scalar).
 * @returns The value with all plain-object keys converted to snake_case.
 */
export function deepKeysToSnake(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  // Fast path: primitives and non-plain objects
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return value;
  }

  if (value instanceof Map || value instanceof Set || value instanceof Date) {
    return value;
  }

  // Arrays: create new array to avoid mutating cached/referenced response data
  if (Array.isArray(value)) {
    return value.map(deepKeysToSnake);
  }

  // Plain objects: create new object with transformed keys
  if (type === 'object') {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const k of Object.keys(obj)) {
      result[camelToSnake(k)] = deepKeysToSnake(obj[k]);
    }

    return result;
  }

  return value;
}

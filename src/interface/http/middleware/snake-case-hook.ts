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

/** Converts a single camelCase key to snake_case. */
function camelToSnake(key: string): string {
  return key.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/**
 * Recursively converts all plain-object keys from camelCase to snake_case.
 *
 * @param value - Any serialisable value (object, array, scalar).
 * @returns The value with all plain-object keys converted to snake_case.
 */
export function deepKeysToSnake(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(deepKeysToSnake);
  if (
    typeof value !== 'object' ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof Date
  ) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[camelToSnake(k)] = deepKeysToSnake(v);
  }
  return result;
}

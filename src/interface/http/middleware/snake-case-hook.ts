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

/**
 * Bounded FIFO cache for camelCase → snake_case conversions.
 * Keys are response schema field names (a small fixed vocabulary), so FIFO
 * eviction is sufficient — no LRU reorder is needed.
 */
const snakeCaseCache = new Map<string, string>();
const SNAKE_CASE_CACHE_MAX = 512;

/** Fast camelCase → snake_case converter with caching. */
export function camelToSnake(key: string): string {
  const cached = snakeCaseCache.get(key);
  if (cached !== undefined) return cached;

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

  if (snakeCaseCache.size >= SNAKE_CASE_CACHE_MAX) {
    // Evict oldest entry (FIFO)
    const firstKey = snakeCaseCache.keys().next().value;
    if (firstKey !== undefined) snakeCaseCache.delete(firstKey);
  }
  snakeCaseCache.set(key, result);
  return result;
}

/**
 * Recursively converts all plain-object keys from camelCase to snake_case.
 * Always returns new objects/arrays — never mutates the input (important for
 * cached or referenced response data that may be read after serialization).
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

  // Non-plain objects (Buffer, URL, class instances, typed arrays):
  // return as-is so their JSON serialization behaviour is preserved and
  // we don't accidentally convert a Buffer into { "0": 97, "1": 98 }.
  if (
    type === 'object' &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    return value;
  }

  // Plain objects: create new object with transformed keys
  if (type === 'object') {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const k of Object.keys(obj)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      result[camelToSnake(k)] = deepKeysToSnake(obj[k]);
    }

    return result;
  }

  return value;
}

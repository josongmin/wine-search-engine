export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function normalizeNumber(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Non-finite number is not allowed in canonical JSON: ${String(value)}`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function canonicalize(value: unknown): CanonicalValue {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return normalizeNumber(value);
  if (typeof value === 'string') return value;

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(
        `Non-plain object is not allowed in canonical JSON: ${value.constructor.name}`,
      );
    }
    const input = value as Record<string, unknown>;
    const output: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(input).sort()) {
      const raw = input[key];
      if (raw === undefined) continue;
      output[key] = canonicalize(raw);
    }
    return output;
  }

  throw new Error(`Unsupported canonical JSON value type: ${typeof value}`);
}

/**
 * Stable JSON serialization for hashing and authority identifiers.
 * - `undefined` keys omitted; `null` preserved.
 * - Object keys sorted lexicographically.
 * - Array order preserved.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

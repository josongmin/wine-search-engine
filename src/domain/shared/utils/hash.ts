import { createHash } from 'node:crypto';

/**
 * Computes a deterministic SHA-256 identity hash from one or more string fields.
 *
 * Fields are sorted lexicographically and joined with a null byte separator
 * before hashing, ensuring the result is independent of argument order.
 * This is used to produce the `identity_signature` for entity deduplication.
 *
 * @param fields - One or more string values to include in the hash.
 * @returns A lowercase hexadecimal SHA-256 digest string.
 * @throws {Error} If no fields are provided.
 */
export function identityHash(...fields: string[]): string {
  if (fields.length === 0) {
    throw new Error('identityHash requires at least one field');
  }

  const sorted = [...fields].sort();
  const joined = sorted.join('\0');

  return createHash('sha256').update(joined, 'utf8').digest('hex');
}

/**
 * Computes a deterministic SHA-256 hash of an ordered sequence of values.
 *
 * Unlike {@link identityHash}, fields are NOT sorted — order is significant.
 * A pipe (`|`) separator is used between fields. The result is truncated to
 * 16 hex characters (64 bits of entropy) for use as a compact response hash.
 *
 * Used by the determinism gate (RFC-009 §8 / RFC-015) to validate that a
 * replay with the same snapshot produces an equivalent engine decision.
 *
 * @param fields - Ordered values to hash. Each is coerced to string.
 * @returns 16-character lowercase hexadecimal digest.
 */
export function deterministicHash(...fields: (string | number | boolean)[]): string {
  const joined = fields.map(String).join('|');
  return createHash('sha256').update(joined, 'utf8').digest('hex').slice(0, 16);
}

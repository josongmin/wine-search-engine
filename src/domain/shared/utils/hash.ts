import { createHash } from 'node:crypto';
import { canonicalJsonStringify } from './canonical-json.js';

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
 * Computes a deterministic SHA-256 hash of one or more values.
 *
 * Each value is serialized with {@link canonicalJsonStringify} (sorted object
 * keys, stable arrays, no `undefined`) and separated by newline in the digest
 * input stream so part boundaries are unambiguous.
 *
 * Used for authority traces, snapshot ids, batch ids, and `response_hash`.
 */
export function deterministicHash(...parts: unknown[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(canonicalJsonStringify(part));
    hash.update('\n');
  }
  return hash.digest('hex');
}

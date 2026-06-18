import { doubleMetaphoneKeys } from './double-metaphone.js';

/**
 * SSoT: Double Metaphone keys materialized for alias recall substrates.
 *
 * Returns sorted distinct keys so snapshot hashes, PG `phonetic_keys`, and
 * in-memory indexes share deterministic ordering.
 */
export function computeAliasPhoneticKeys(normalizedValue: string): readonly string[] {
  const trimmed = normalizedValue.trim();
  if (trimmed.length === 0) {
    return [];
  }
  return [...doubleMetaphoneKeys(trimmed)].sort((left, right) => left.localeCompare(right));
}

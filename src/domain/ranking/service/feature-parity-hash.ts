/**
 * Feature schema parity hash (T13-9 + Epic-10 cross-cutting).
 *
 * Verifies train-time and serve-time agree on the LTR feature schema.
 * If the offline trainer was fed a different feature ordering than the
 * online serving model produces, predictions are silently corrupted.
 *
 * The hash is a deterministic SHA-256 hex digest (truncated to 16 chars)
 * of the SORTED, NEWLINE-JOINED feature names. Adding, removing, or
 * renaming a feature changes the hash; reordering does not.
 */

import { createHash } from 'node:crypto';
import { LTR_FEATURE_NAMES } from './ltr-features.js';

/** Schema major version — bump on backward-incompatible changes.
 *  v2 (Wave I3): added 4 graph-aware features (`graph_root_satisfied`,
 *  `graph_hard_tier_coverage`, `graph_xor_branch_match`,
 *  `graph_origin_encoded`). Models trained under v1 are incompatible
 *  with v2 inference by design — the parity hash will reject them. */
export const LTR_FEATURE_SCHEMA_VERSION = '2';
/** Truncation length for the parity hash (sufficient collision resistance for our use). */
const PARITY_HASH_LENGTH = 16;

function hashFeatureSchema(featureNames: readonly string[]): string {
  const sorted = [...featureNames].sort();
  const joined = sorted.join('\n');
  return createHash('sha256').update(joined).digest('hex').slice(0, PARITY_HASH_LENGTH);
}

export function getCurrentFeatureSchemaHash(): string {
  return hashFeatureSchema(LTR_FEATURE_NAMES);
}

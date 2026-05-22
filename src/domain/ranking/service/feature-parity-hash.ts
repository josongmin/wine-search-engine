/**
 * Feature schema parity hash (T13-9 + Epic-10 cross-cutting).
 *
 * Verifies train-time and serve-time agree on the LTR feature schema.
 * If the offline trainer was fed a different feature ordering than the
 * online serving model produces, predictions are silently corrupted.
 *
 * The authoritative parity hash is emitted by `ltr-feature-extractor.ts`
 * from the canonical inference/training feature order. Reordering must
 * change the hash because vector position is part of the contract.
 */
import { LTR_FEATURE_SCHEMA_HASH } from './ltr-feature-extractor.js';

/** Schema major version.
 *  v4: authoritative dual-lane 14-feature inference/training schema.
 *  Order-sensitive hash derived from the canonical feature vector layout. */

export function getCurrentFeatureSchemaHash(): string {
  return LTR_FEATURE_SCHEMA_HASH;
}

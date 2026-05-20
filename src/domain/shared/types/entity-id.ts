import { nanoid } from 'nanoid';
import { isSourceRecordStylePublicEntityId } from '../constants/public-entity-id-namespace.js';

declare const CanonicalEntityIdBrand: unique symbol;

/**
 * ADR-007: Public runtime / HTTP / snapshot / Vespa projection identity.
 * Must not use the source-record namespace ({@link isSourceRecordStylePublicEntityId}).
 */
export type CanonicalEntityId = string & { readonly [CanonicalEntityIdBrand]: typeof CanonicalEntityIdBrand };

declare const SourceRecordIdBrand: unique symbol;

/**
 * ADR-007: Source-system row identity (e.g. Vivino ingestion ids). Never interchangeable
 * with {@link CanonicalEntityId}.
 */
export type SourceRecordId = string & { readonly [SourceRecordIdBrand]: typeof SourceRecordIdBrand };

/** Same as {@link CanonicalEntityId}; kept for existing imports and call sites (ADR-007 convergence). */
export type EntityId = CanonicalEntityId;

/**
 * Validates and brands a string as {@link CanonicalEntityId}.
 *
 * @throws If empty or if the value uses the forbidden source-record public namespace.
 */
export function createCanonicalEntityId(value: string): CanonicalEntityId {
  if (value.length === 0) {
    throw new Error('CanonicalEntityId cannot be an empty string');
  }
  if (isSourceRecordStylePublicEntityId(value)) {
    throw new Error(
      'ADR-007: canonical public entity_id must not use the source-record namespace — use SourceRecordId / source_record_refs instead',
    );
  }
  return value as CanonicalEntityId;
}

/**
 * Validates and brands a non-empty source-system record id.
 */
export function createSourceRecordId(value: string): SourceRecordId {
  if (value.length === 0) {
    throw new Error('SourceRecordId cannot be an empty string');
  }
  return value as SourceRecordId;
}

/**
 * Creates a new {@link CanonicalEntityId}, optionally from an existing string.
 * When no value is provided, generates an opaque id with prefix `nx-` (never the source-record namespace).
 *
 * @param value - Optional string; if provided, must satisfy canonical public namespace rules.
 * @throws {Error} If empty or source-record namespace (when `value` is provided).
 */
export function createEntityId(value?: string): CanonicalEntityId {
  if (value !== undefined) {
    return createCanonicalEntityId(value);
  }
  // nanoid() is URL-safe and does not use the forbidden `vivino-` public namespace; prefix keeps audits obvious.
  return createCanonicalEntityId(`nx-${nanoid()}`);
}

/** ADR-007: true when `value` is a non-empty string and not a forbidden public `vivino-` namespace id. */
export function isCanonicalPublicEntityId(value: unknown): value is CanonicalEntityId {
  return typeof value === 'string' && value.length > 0 && !isSourceRecordStylePublicEntityId(value);
}

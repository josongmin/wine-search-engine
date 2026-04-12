/**
 * ADR-007: source-side Vivino record ids often use this prefix.
 * Public `entity_id` (HTTP, snapshot artifacts, runtime projection) must not
 * use this namespace — lineage belongs in `source_record_refs` / link tables.
 */
export const SOURCE_RECORD_PUBLIC_ENTITY_ID_PREFIX = 'vivino-' as const;

/** Postgres `LIKE` pattern for readiness / SQL audits (pair with {@link SOURCE_RECORD_PUBLIC_ENTITY_ID_PREFIX}). */
export const SOURCE_RECORD_PUBLIC_ENTITY_ID_LIKE_PATTERN =
  `${SOURCE_RECORD_PUBLIC_ENTITY_ID_PREFIX}%` as const;

export function isSourceRecordStylePublicEntityId(value: string): boolean {
  return value.startsWith(SOURCE_RECORD_PUBLIC_ENTITY_ID_PREFIX);
}

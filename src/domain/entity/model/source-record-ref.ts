import { z } from 'zod';

/** Max lineage refs attached to one wine entity (ingest + HTTP contract). */
const SOURCE_RECORD_REF_LIST_MAX_ITEMS = 32;

/** Max UTF-16 code units for external `sourceSystem` on wire (Vespa + HTTP). */
export const MAX_SOURCE_RECORD_SOURCE_SYSTEM_CHARS = 128;

/** Max UTF-16 code units for opaque external record ids. */
export const MAX_SOURCE_RECORD_RECORD_ID_CHARS = 512;

export const MAX_SOURCE_RECORD_REFS_PER_ENTITY = SOURCE_RECORD_REF_LIST_MAX_ITEMS;

export const SourceRecordRefSchema = z
  .object({
    sourceSystem: z.string().min(1).max(MAX_SOURCE_RECORD_SOURCE_SYSTEM_CHARS),
    sourceRecordId: z.string().min(1).max(MAX_SOURCE_RECORD_RECORD_ID_CHARS),
  })
  .strict();

export type SourceRecordRef = z.infer<typeof SourceRecordRefSchema>;

export const SourceRecordRefListSchema = z
  .array(SourceRecordRefSchema)
  .max(MAX_SOURCE_RECORD_REFS_PER_ENTITY);

/**
 * Parses Vespa `source_record_refs_json` (stable JSON string) or a JSON array
 * value when Vespa returns structured JSON.
 */
export function parseSourceRecordRefsFromVespa(raw: unknown): readonly SourceRecordRef[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    const parsedUnknown: unknown = JSON.parse(trimmed);
    const parsed = SourceRecordRefListSchema.safeParse(parsedUnknown);
    return parsed.success ? parsed.data : undefined;
  }
  const parsed = SourceRecordRefListSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

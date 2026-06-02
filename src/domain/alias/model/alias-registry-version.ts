import { z } from 'zod';

/**
 * Entity Lookup V2 — dedicated alias-registry version identity (T-ELV2-03, DoD §2).
 *
 * The alias substrate the V2 lookup already consumes (snapshot manifest, PG
 * overlay, or search index) IS the registry; what was missing is a NAMED,
 * VERSIONED identity over it so an operator can audit exactly which alias
 * registry served a resolve. This is the honest first increment: a deterministic
 * version stamp (schema version + snapshot id + alias content hash + alias count),
 * surfaced on the V2 response. The full RFC vision — a separate curated registry
 * the resolver reads INSTEAD of the shared snapshot — is a large fork that cannot
 * be wired non-dead in one step (it would leave a parallel artifact nothing reads,
 * rule 33), so it stays deferred.
 *
 * Domain leaf: imports only zod + stays within src/domain/alias. SSoT (rule 30).
 */

/** Schema-version literal for the V2 alias registry identity. */
export const ALIAS_REGISTRY_V2_SCHEMA_VERSION = 'alias_registry.v2' as const;

/** Where the alias substrate that served this resolve came from. */
export const ALIAS_REGISTRY_SOURCES = ['snapshot_manifest', 'pg_overlay', 'search_index'] as const;
export type AliasRegistrySource = (typeof ALIAS_REGISTRY_SOURCES)[number];

export interface AliasRegistryVersion {
  readonly schemaVersion: typeof ALIAS_REGISTRY_V2_SCHEMA_VERSION;
  readonly source: AliasRegistrySource;
  readonly snapshotId?: string;
  readonly aliasContentHash?: string;
  readonly aliasCount: number;
}

/** Shape guard for reconstructing a version from JSONB/Redis (never `as`). */
export const AliasRegistryVersionSchema = z
  .object({
    schemaVersion: z.literal(ALIAS_REGISTRY_V2_SCHEMA_VERSION),
    source: z.enum(ALIAS_REGISTRY_SOURCES),
    snapshotId: z.string().min(1).optional(),
    aliasContentHash: z.string().min(1).optional(),
    aliasCount: z.number().int().nonnegative(),
  })
  .strict();

export interface AliasRegistryVersionParts {
  readonly source: AliasRegistrySource;
  readonly aliasCount: number;
  readonly snapshotId?: string | undefined;
  readonly aliasContentHash?: string | undefined;
}

/**
 * Build a version stamp, OMITTING optional keys when absent
 * (exactOptionalPropertyTypes — never assign undefined).
 */
export function buildAliasRegistryVersion(parts: AliasRegistryVersionParts): AliasRegistryVersion {
  return {
    schemaVersion: ALIAS_REGISTRY_V2_SCHEMA_VERSION,
    source: parts.source,
    aliasCount: Math.max(0, Math.trunc(parts.aliasCount)),
    ...(parts.snapshotId !== undefined ? { snapshotId: parts.snapshotId } : {}),
    ...(parts.aliasContentHash !== undefined ? { aliasContentHash: parts.aliasContentHash } : {}),
  };
}

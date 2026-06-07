import { z } from 'zod';
import { hashStableJson } from '../utils/stable-json.js';

export const LOOKUP_SEMANTIC_SCOPE_RUNTIME_SCHEMA_VERSION = 'lookup_semantic_scope_runtime.v1' as const;
export const LOOKUP_SCOPE_GRAPH_RUNTIME_SCHEMA_VERSION = 'lookup_scope_graph_runtime.v1' as const;
export const LOOKUP_REVIEWED_FAMILY_RECALL_RUNTIME_SCHEMA_VERSION = 'lookup_reviewed_family_recall_runtime.v1' as const;

export const LOOKUP_SCOPE_GRAPH_RELATION_KINDS = ['family', 'line', 'vintage'] as const;
export type LookupScopeGraphRelationKind = (typeof LOOKUP_SCOPE_GRAPH_RELATION_KINDS)[number];

export const LOOKUP_SEMANTIC_SCOPE_AXES = ['family', 'line'] as const;
export type LookupSemanticScopeRuntimeAxis = (typeof LOOKUP_SEMANTIC_SCOPE_AXES)[number];

export const LOOKUP_SEMANTIC_SURFACE_FORM_KINDS = [
  'bare',
  'qualified',
  'compact',
  'mixed_script',
] as const;
export type LookupSemanticScopeRuntimeSurfaceFormKind =
  (typeof LOOKUP_SEMANTIC_SURFACE_FORM_KINDS)[number];

export interface LookupSemanticScopeRuntimeEntry {
  readonly semanticScopeKey: string;
  readonly scopeAxis: LookupSemanticScopeRuntimeAxis;
  readonly familyKey: string;
  readonly lineKey?: string | undefined;
  readonly regionKey?: string | undefined;
  readonly appellationKey?: string | undefined;
  readonly vintage?: number | undefined;
  readonly surfaceFormKind: LookupSemanticScopeRuntimeSurfaceFormKind;
  readonly locale: 'ko' | 'global';
  readonly entityId: string;
}

export interface LookupSemanticScopeRuntimeArtifact {
  readonly schemaVersion: typeof LOOKUP_SEMANTIC_SCOPE_RUNTIME_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly entries: Readonly<Record<string, LookupSemanticScopeRuntimeEntry>>;
  /**
   * Reviewed multilingual component-surface index (final architecture L1):
   * `componentKind::componentKey::locale` -> reviewed normalized surfaces.
   * Optional + additive: absence means the matcher falls back to latin-literal
   * token matching (zero regression for snapshots built before this field).
   */
  readonly componentSurfaces?: Readonly<Record<string, readonly string[]>> | undefined;
}

export interface LookupScopeGraphRuntimeEdge {
  readonly targetEntityId: string;
  readonly relationKind: LookupScopeGraphRelationKind;
  readonly weight: number;
  readonly familyKey: string;
  readonly lineKey?: string | undefined;
  readonly vintage?: number | undefined;
}

export interface LookupScopeGraphRuntimeArtifact {
  readonly schemaVersion: typeof LOOKUP_SCOPE_GRAPH_RUNTIME_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly adjacency: Readonly<Record<string, readonly LookupScopeGraphRuntimeEdge[]>>;
}

export interface LookupReviewedFamilyRecallRuntimeEntry {
  readonly normalizedSurface: string;
  readonly familyKey: string;
  readonly entityIds: readonly string[];
  readonly recallWeight: number;
  readonly localizedSurfaces?: readonly string[] | undefined;
  readonly witnessSources?: readonly string[] | undefined;
}

export interface LookupReviewedFamilyRecallRuntimeArtifact {
  readonly schemaVersion: typeof LOOKUP_REVIEWED_FAMILY_RECALL_RUNTIME_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly entries: Readonly<Record<string, LookupReviewedFamilyRecallRuntimeEntry>>;
}

const LookupSemanticScopeRuntimeEntrySchema = z.object({
  semanticScopeKey: z.string().min(1),
  scopeAxis: z.enum(LOOKUP_SEMANTIC_SCOPE_AXES),
  familyKey: z.string().min(1),
  lineKey: z.string().min(1).optional(),
  regionKey: z.string().min(1).optional(),
  appellationKey: z.string().min(1).optional(),
  vintage: z.number().int().min(0).max(3000).optional(),
  surfaceFormKind: z.enum(LOOKUP_SEMANTIC_SURFACE_FORM_KINDS),
  locale: z.enum(['ko', 'global']),
  entityId: z.string().min(1),
}).strict();

const LookupScopeGraphRuntimeEdgeSchema = z.object({
  targetEntityId: z.string().min(1),
  relationKind: z.enum(LOOKUP_SCOPE_GRAPH_RELATION_KINDS),
  weight: z.number().finite().min(0).max(1),
  familyKey: z.string().min(1),
  lineKey: z.string().min(1).optional(),
  vintage: z.number().int().min(0).max(3000).optional(),
}).strict();

const LookupReviewedFamilyRecallRuntimeEntrySchema = z.object({
  normalizedSurface: z.string().min(1),
  familyKey: z.string().min(1),
  entityIds: z.array(z.string().min(1)).min(2),
  recallWeight: z.number().finite().min(0).max(1),
  localizedSurfaces: z.array(z.string().min(1)).optional(),
  witnessSources: z.array(z.string().min(1)).optional(),
}).strict();

export const LookupSemanticScopeRuntimeArtifactSchema = z.object({
  schemaVersion: z.literal(LOOKUP_SEMANTIC_SCOPE_RUNTIME_SCHEMA_VERSION),
  snapshotId: z.string().min(1),
  generatedAt: z.string().min(1),
  entries: z.record(z.string().min(1), LookupSemanticScopeRuntimeEntrySchema),
  componentSurfaces: z.record(z.string().min(1), z.array(z.string().min(1)).readonly()).optional(),
}).strict();

export const LookupScopeGraphRuntimeArtifactSchema = z.object({
  schemaVersion: z.literal(LOOKUP_SCOPE_GRAPH_RUNTIME_SCHEMA_VERSION),
  snapshotId: z.string().min(1),
  generatedAt: z.string().min(1),
  adjacency: z.record(z.string().min(1), z.array(LookupScopeGraphRuntimeEdgeSchema)),
}).strict();

export const LookupReviewedFamilyRecallRuntimeArtifactSchema = z.object({
  schemaVersion: z.literal(LOOKUP_REVIEWED_FAMILY_RECALL_RUNTIME_SCHEMA_VERSION),
  snapshotId: z.string().min(1),
  generatedAt: z.string().min(1),
  entries: z.record(z.string().min(1), LookupReviewedFamilyRecallRuntimeEntrySchema),
}).strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} is required`);
  }
}

function requireFiniteNumber(
  value: unknown,
  field: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
}

function requireTrustedRoot(
  raw: string,
  filePath: string,
  args: {
    readonly schemaVersion: string;
    readonly errorPrefix: string;
  },
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('root is not an object');
    }
    if (parsed.schemaVersion !== args.schemaVersion) {
      throw new Error(`schemaVersion must be ${args.schemaVersion}`);
    }
    requireNonEmptyString(parsed.snapshotId, 'snapshotId');
    requireNonEmptyString(parsed.generatedAt, 'generatedAt');
    return parsed;
  } catch (error) {
    throw new Error(
      `${args.errorPrefix} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseLookupSemanticScopeRuntimeArtifact(
  raw: string,
  filePath: string,
): LookupSemanticScopeRuntimeArtifact {
  try {
    return LookupSemanticScopeRuntimeArtifactSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Malformed lookup semantic scope runtime artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseTrustedLookupSemanticScopeRuntimeArtifact(
  raw: string,
  filePath: string,
): LookupSemanticScopeRuntimeArtifact {
  try {
    const parsed = requireTrustedRoot(raw, filePath, {
      schemaVersion: LOOKUP_SEMANTIC_SCOPE_RUNTIME_SCHEMA_VERSION,
      errorPrefix: 'Malformed trusted lookup semantic scope runtime artifact',
    });
    if (!isRecord(parsed.entries)) {
      throw new Error('entries must be an object');
    }
    for (const [scopeKey, entry] of Object.entries(parsed.entries)) {
      if (!isRecord(entry)) {
        throw new Error(`entries.${scopeKey} must be an object`);
      }
      requireNonEmptyString(entry.semanticScopeKey, `entries.${scopeKey}.semanticScopeKey`);
      if (entry.scopeAxis !== 'family' && entry.scopeAxis !== 'line') {
        throw new Error(`entries.${scopeKey}.scopeAxis is invalid`);
      }
      requireNonEmptyString(entry.familyKey, `entries.${scopeKey}.familyKey`);
      if (entry.lineKey !== undefined) {
        requireNonEmptyString(entry.lineKey, `entries.${scopeKey}.lineKey`);
      }
      if (entry.regionKey !== undefined) {
        requireNonEmptyString(entry.regionKey, `entries.${scopeKey}.regionKey`);
      }
      if (entry.appellationKey !== undefined) {
        requireNonEmptyString(entry.appellationKey, `entries.${scopeKey}.appellationKey`);
      }
      if (entry.vintage !== undefined) {
        requireFiniteNumber(entry.vintage, `entries.${scopeKey}.vintage`);
      }
      if (
        entry.surfaceFormKind !== 'bare'
        && entry.surfaceFormKind !== 'qualified'
        && entry.surfaceFormKind !== 'compact'
        && entry.surfaceFormKind !== 'mixed_script'
      ) {
        throw new Error(`entries.${scopeKey}.surfaceFormKind is invalid`);
      }
      if (entry.locale !== 'ko' && entry.locale !== 'global') {
        throw new Error(`entries.${scopeKey}.locale is invalid`);
      }
      requireNonEmptyString(entry.entityId, `entries.${scopeKey}.entityId`);
    }
    return parsed as unknown as LookupSemanticScopeRuntimeArtifact;
  } catch (error) {
    throw new Error(
      `Malformed trusted lookup semantic scope runtime artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseLookupScopeGraphRuntimeArtifact(
  raw: string,
  filePath: string,
): LookupScopeGraphRuntimeArtifact {
  try {
    return LookupScopeGraphRuntimeArtifactSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Malformed lookup scope graph runtime artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseLookupReviewedFamilyRecallRuntimeArtifact(
  raw: string,
  filePath: string,
): LookupReviewedFamilyRecallRuntimeArtifact {
  try {
    return LookupReviewedFamilyRecallRuntimeArtifactSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Malformed lookup reviewed family recall runtime artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseTrustedLookupScopeGraphRuntimeArtifact(
  raw: string,
  filePath: string,
): LookupScopeGraphRuntimeArtifact {
  try {
    const parsed = requireTrustedRoot(raw, filePath, {
      schemaVersion: LOOKUP_SCOPE_GRAPH_RUNTIME_SCHEMA_VERSION,
      errorPrefix: 'Malformed trusted lookup scope graph runtime artifact',
    });
    if (!isRecord(parsed.adjacency)) {
      throw new Error('adjacency must be an object');
    }
    for (const [entityId, edges] of Object.entries(parsed.adjacency)) {
      if (!Array.isArray(edges)) {
        throw new Error(`adjacency.${entityId} must be an array`);
      }
      for (const [index, edge] of edges.entries()) {
        if (!isRecord(edge)) {
          throw new Error(`adjacency.${entityId}[${index}] must be an object`);
        }
        requireNonEmptyString(edge.targetEntityId, `adjacency.${entityId}[${index}].targetEntityId`);
        if (
          edge.relationKind !== 'family'
          && edge.relationKind !== 'line'
          && edge.relationKind !== 'vintage'
        ) {
          throw new Error(`adjacency.${entityId}[${index}].relationKind is invalid`);
        }
        requireFiniteNumber(edge.weight, `adjacency.${entityId}[${index}].weight`);
        requireNonEmptyString(edge.familyKey, `adjacency.${entityId}[${index}].familyKey`);
        if (edge.lineKey !== undefined) {
          requireNonEmptyString(edge.lineKey, `adjacency.${entityId}[${index}].lineKey`);
        }
        if (edge.vintage !== undefined) {
          requireFiniteNumber(edge.vintage, `adjacency.${entityId}[${index}].vintage`);
        }
      }
    }
    return parsed as unknown as LookupScopeGraphRuntimeArtifact;
  } catch (error) {
    throw new Error(
      `Malformed trusted lookup scope graph runtime artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseTrustedLookupReviewedFamilyRecallRuntimeArtifact(
  raw: string,
  filePath: string,
): LookupReviewedFamilyRecallRuntimeArtifact {
  try {
    const parsed = requireTrustedRoot(raw, filePath, {
      schemaVersion: LOOKUP_REVIEWED_FAMILY_RECALL_RUNTIME_SCHEMA_VERSION,
      errorPrefix: 'Malformed trusted lookup reviewed family recall runtime artifact',
    });
    if (!isRecord(parsed.entries)) {
      throw new Error('entries must be an object');
    }
    for (const [normalizedSurface, entry] of Object.entries(parsed.entries)) {
      if (!isRecord(entry)) {
        throw new Error(`entries.${normalizedSurface} must be an object`);
      }
      requireNonEmptyString(entry.normalizedSurface, `entries.${normalizedSurface}.normalizedSurface`);
      requireNonEmptyString(entry.familyKey, `entries.${normalizedSurface}.familyKey`);
      if (!Array.isArray(entry.entityIds) || entry.entityIds.length < 2) {
        throw new Error(`entries.${normalizedSurface}.entityIds must contain at least 2 owners`);
      }
      for (const [index, entityId] of entry.entityIds.entries()) {
        requireNonEmptyString(entityId, `entries.${normalizedSurface}.entityIds[${index}]`);
      }
      requireFiniteNumber(entry.recallWeight, `entries.${normalizedSurface}.recallWeight`);
      if (entry.localizedSurfaces !== undefined) {
        if (!Array.isArray(entry.localizedSurfaces)) {
          throw new Error(`entries.${normalizedSurface}.localizedSurfaces must be an array`);
        }
        for (const [index, localizedSurface] of entry.localizedSurfaces.entries()) {
          requireNonEmptyString(localizedSurface, `entries.${normalizedSurface}.localizedSurfaces[${index}]`);
        }
      }
      if (entry.witnessSources !== undefined) {
        if (!Array.isArray(entry.witnessSources)) {
          throw new Error(`entries.${normalizedSurface}.witnessSources must be an array`);
        }
        for (const [index, witnessSource] of entry.witnessSources.entries()) {
          requireNonEmptyString(witnessSource, `entries.${normalizedSurface}.witnessSources[${index}]`);
        }
      }
    }
    return parsed as unknown as LookupReviewedFamilyRecallRuntimeArtifact;
  } catch (error) {
    throw new Error(
      `Malformed trusted lookup reviewed family recall runtime artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function buildLookupSemanticScopeRuntimeArtifactHash(
  artifact: LookupSemanticScopeRuntimeArtifact,
): string {
  return hashStableJson({
    schemaVersion: artifact.schemaVersion,
    entries: artifact.entries,
  });
}

export function buildLookupScopeGraphRuntimeArtifactHash(
  artifact: LookupScopeGraphRuntimeArtifact,
): string {
  return hashStableJson({
    schemaVersion: artifact.schemaVersion,
    adjacency: artifact.adjacency,
  });
}

export function buildLookupReviewedFamilyRecallRuntimeArtifactHash(
  artifact: LookupReviewedFamilyRecallRuntimeArtifact,
): string {
  return hashStableJson({
    schemaVersion: artifact.schemaVersion,
    entries: artifact.entries,
  });
}

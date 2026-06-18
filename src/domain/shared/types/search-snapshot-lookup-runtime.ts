import { z } from 'zod';
import { hashStableJson } from '../utils/stable-json.js';

const LOOKUP_RUNTIME_ALIAS_TYPES = [
  'canonical',
  'translation',
  'phonetic',
  'misspelling',
  'observed_query_alias',
  'catalog_noise_alias',
  'derived_initialism',
  'abbreviation',
] as const;

type AliasType = (typeof LOOKUP_RUNTIME_ALIAS_TYPES)[number];
export type LookupIdentityCertificateKind = 'exact_safe' | 'compact_exact_safe';
export type LookupIdentityCertificateSourceTier = 'curated' | 'catalog' | 'translation';

interface LookupRuntimeSourceRecordRef {
  readonly sourceSystem: string;
  readonly sourceRecordId: string;
}

export const LOOKUP_ALIAS_RUNTIME_SCHEMA_VERSION = 'lookup_alias_runtime.v1' as const;
export const LOOKUP_ALIAS_CORE_RUNTIME_SCHEMA_VERSION = 'lookup_alias_runtime_core.v1' as const;
export const LOOKUP_ALIAS_BROAD_RECALL_RUNTIME_SCHEMA_VERSION = 'lookup_alias_broad_recall_runtime.v1' as const;
export const LOOKUP_RESOLVER_PROJECTION_SCHEMA_VERSION = 'lookup_resolver_projection.v1' as const;
export const LOOKUP_ENTITY_PROJECTION_SCHEMA_VERSION = 'lookup_entity_projection.v1' as const;
export const LOOKUP_AMBIGUITY_RUNTIME_SCHEMA_VERSION = 'lookup_ambiguity_runtime.v1' as const;
export const LOOKUP_CONCEPT_REDIRECT_RUNTIME_SCHEMA_VERSION = 'lookup_concept_redirect_runtime.v1' as const;
export const LOOKUP_EXACT_SAFE_RUNTIME_SCHEMA_VERSION = 'lookup_exact_safe_runtime.v1' as const;

export interface LookupAliasRuntimeRow {
  readonly aliasId: string;
  readonly entityId: string;
  readonly value: string;
  readonly normalizedValue: string;
  readonly sourceTrust: number;
  readonly confidencePrior: number;
  readonly aliasType?: AliasType | undefined;
}

export interface LookupAliasRuntimePrefixEntry {
  readonly candidateTerm: string;
  readonly aliasIndexes: readonly number[];
}

export interface LookupAliasRuntimeHangulCompletionEntry {
  readonly aliasIndex: number;
  readonly jamoKey: string;
  readonly syllableBoundaryOffsets?: readonly number[] | undefined;
}

export interface LookupAliasRuntimeArtifact {
  readonly schemaVersion: typeof LOOKUP_ALIAS_RUNTIME_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly aliasRegistryHash: string;
  readonly aliases: readonly LookupAliasRuntimeRow[];
  readonly surfaceForms: readonly string[];
  readonly exactIndex: Readonly<Record<string, readonly number[]>>;
  readonly compactIndex: Readonly<Record<string, readonly number[]>>;
  readonly wholeTokenIndex: Readonly<Record<string, readonly number[]>>;
  readonly phoneticIndex: Readonly<Record<string, readonly number[]>>;
  readonly doubleMetaphoneIndex: Readonly<Record<string, readonly number[]>>;
  readonly doubleMetaphoneKeysByAliasId?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly prefixCatalog: readonly LookupAliasRuntimePrefixEntry[];
  readonly hangulCompletionRecords: readonly LookupAliasRuntimeHangulCompletionEntry[];
}

export interface LookupAliasRuntimeCoreArtifact {
  readonly schemaVersion: typeof LOOKUP_ALIAS_CORE_RUNTIME_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly aliasRegistryHash: string;
  readonly aliases: readonly LookupAliasRuntimeRow[];
  readonly surfaceForms?: readonly string[] | undefined;
  readonly exactIndex: Readonly<Record<string, readonly number[]>>;
  readonly compactIndex: Readonly<Record<string, readonly number[]>>;
}

export interface LookupAliasBroadRecallRuntimeArtifact {
  readonly schemaVersion: typeof LOOKUP_ALIAS_BROAD_RECALL_RUNTIME_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly aliasRegistryHash: string;
  readonly wholeTokenIndex: Readonly<Record<string, readonly number[]>>;
  readonly phoneticIndex: Readonly<Record<string, readonly number[]>>;
  readonly doubleMetaphoneIndex: Readonly<Record<string, readonly number[]>>;
  readonly doubleMetaphoneKeysByAliasId?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly prefixCatalog: readonly LookupAliasRuntimePrefixEntry[];
  readonly hangulCompletionRecords?: readonly LookupAliasRuntimeHangulCompletionEntry[] | undefined;
}

export interface LookupEntityProjectionDocument {
  readonly entityId: string;
  readonly entityType: string;
  readonly canonicalLabel: string;
  readonly aliasesIdentitySafe: readonly string[];
  readonly identitySafeKeys?: readonly string[] | undefined;
  readonly familyCoreKeys?: readonly string[] | undefined;
  readonly identityCertificates?: readonly LookupIdentityCertificate[] | undefined;
  readonly aliasesNoisyRecall: readonly string[];
  readonly producer: string;
  readonly attributeHints?: Readonly<Record<string, string | number | readonly string[]>> | undefined;
  readonly sourceRecordRefs?: readonly LookupRuntimeSourceRecordRef[] | undefined;
  readonly region: string;
  readonly grapes: readonly string[];
  readonly searchTextKo: string;
  readonly searchTextEn: string;
  readonly semanticSummary: string;
  readonly pairing: readonly string[];
  readonly availability: boolean;
  readonly popularityScore: number;
  readonly [key: string]: unknown;
}

export interface LookupResolverProjectionDocument {
  readonly entityId: string;
  readonly entityType: string;
  readonly canonicalLabel: string;
  readonly aliasesIdentitySafe: readonly string[];
  readonly identitySafeKeys: readonly string[];
  readonly identityCertificates?: readonly LookupIdentityCertificate[] | undefined;
  readonly producer?: string | undefined;
  readonly attributeHints?: Readonly<Record<string, string | number | readonly string[]>> | undefined;
  readonly sourceRecordRefs?: readonly LookupRuntimeSourceRecordRef[] | undefined;
}

export interface LookupIdentityCertificate {
  readonly kind: LookupIdentityCertificateKind;
  readonly normalizedSurface: string;
  readonly compactSurface?: string | undefined;
  readonly sourceTier: LookupIdentityCertificateSourceTier;
  readonly singleton: true;
  readonly collisionFree: true;
}

export interface LookupResolverProjectionArtifact {
  readonly schemaVersion: typeof LOOKUP_RESOLVER_PROJECTION_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly documents: readonly LookupResolverProjectionDocument[];
}

export interface LookupEntityProjectionArtifact {
  readonly schemaVersion: typeof LOOKUP_ENTITY_PROJECTION_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly documents: readonly LookupEntityProjectionDocument[];
}

export interface LookupAmbiguityRuntimeEntry {
  readonly normalizedForm: string;
  readonly types: readonly string[];
  readonly severity: 'low' | 'medium' | 'high';
  readonly entityIds?: readonly string[] | undefined;
}

export interface LookupAmbiguityRuntimeArtifact {
  readonly schemaVersion: typeof LOOKUP_AMBIGUITY_RUNTIME_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly entries: Readonly<Record<string, LookupAmbiguityRuntimeEntry>>;
}

export type LookupConceptRedirectClass =
  | 'grape'
  | 'region'
  | 'style'
  | 'recommendation'
  | 'pairing'
  | 'generic';

export interface LookupConceptRedirectRuntimeEntry {
  readonly normalizedForm: string;
  readonly locale: 'ko' | 'global';
  readonly conceptClass: LookupConceptRedirectClass;
  readonly redirectReason: 'concept_query' | 'generic_non_entity_query';
  readonly sourceEvidence: string;
}

export interface LookupConceptRedirectRuntimeArtifact {
  readonly schemaVersion: typeof LOOKUP_CONCEPT_REDIRECT_RUNTIME_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly entries: Readonly<Record<string, LookupConceptRedirectRuntimeEntry>>;
}

export interface LookupExactSafeRuntimeEntry {
  readonly entityId: string;
  readonly locale: 'ko' | 'global';
  readonly certificate: LookupIdentityCertificate;
}

export interface LookupExactSafeRuntimeArtifact {
  readonly schemaVersion: typeof LOOKUP_EXACT_SAFE_RUNTIME_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly exactEntries: Readonly<Record<string, LookupExactSafeRuntimeEntry>>;
  readonly compactEntries: Readonly<Record<string, LookupExactSafeRuntimeEntry>>;
}

const NonNegativeIntArraySchema = z.array(z.number().int().nonnegative());
const AliasIndexSchema = z.record(z.string().min(1), NonNegativeIntArraySchema);

const LookupAliasRuntimeRowSchema = z.object({
  aliasId: z.string().min(1),
  entityId: z.string().min(1),
  value: z.string().min(1),
  normalizedValue: z.string().min(1),
  sourceTrust: z.number().finite(),
  confidencePrior: z.number().finite(),
  aliasType: z.enum(LOOKUP_RUNTIME_ALIAS_TYPES).optional(),
}).strict();

const LookupAliasRuntimePrefixEntrySchema = z.object({
  candidateTerm: z.string().min(1),
  aliasIndexes: NonNegativeIntArraySchema,
}).strict();

const LookupAliasRuntimeHangulCompletionEntrySchema = z.object({
  aliasIndex: z.number().int().nonnegative(),
  jamoKey: z.string().min(1),
  syllableBoundaryOffsets: NonNegativeIntArraySchema.optional(),
}).strict();

const LookupResolverProjectionHintValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.array(z.string()),
]);
const LookupResolverProjectionHintsSchema = z.record(
  z.string().min(1),
  LookupResolverProjectionHintValueSchema,
);
const LookupRuntimeSourceRecordRefSchema = z.object({
  sourceSystem: z.string().min(1),
  sourceRecordId: z.string().min(1),
}).strict();

const LookupIdentityCertificateSchema = z.object({
  kind: z.enum(['exact_safe', 'compact_exact_safe']),
  normalizedSurface: z.string().min(1),
  compactSurface: z.string().min(1).optional(),
  sourceTier: z.enum(['curated', 'catalog', 'translation']),
  singleton: z.literal(true),
  collisionFree: z.literal(true),
}).strict();

export const LookupAliasRuntimeArtifactSchema = z.object({
  schemaVersion: z.literal(LOOKUP_ALIAS_RUNTIME_SCHEMA_VERSION),
  snapshotId: z.string().min(1),
  generatedAt: z.string().min(1),
  aliasRegistryHash: z.string().min(1),
  aliases: z.array(LookupAliasRuntimeRowSchema),
  surfaceForms: z.array(z.string().min(1)),
  exactIndex: AliasIndexSchema,
  compactIndex: AliasIndexSchema,
  wholeTokenIndex: AliasIndexSchema,
  phoneticIndex: AliasIndexSchema,
  doubleMetaphoneIndex: AliasIndexSchema,
  doubleMetaphoneKeysByAliasId: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
  prefixCatalog: z.array(LookupAliasRuntimePrefixEntrySchema),
  hangulCompletionRecords: z.array(LookupAliasRuntimeHangulCompletionEntrySchema),
}).strict();

export const LookupAliasRuntimeCoreArtifactSchema = z.object({
  schemaVersion: z.literal(LOOKUP_ALIAS_CORE_RUNTIME_SCHEMA_VERSION),
  snapshotId: z.string().min(1),
  generatedAt: z.string().min(1),
  aliasRegistryHash: z.string().min(1),
  aliases: z.array(LookupAliasRuntimeRowSchema),
  surfaceForms: z.array(z.string().min(1)).optional(),
  exactIndex: AliasIndexSchema,
  compactIndex: AliasIndexSchema,
}).strict();

export const LookupAliasBroadRecallRuntimeArtifactSchema = z.object({
  schemaVersion: z.literal(LOOKUP_ALIAS_BROAD_RECALL_RUNTIME_SCHEMA_VERSION),
  snapshotId: z.string().min(1),
  generatedAt: z.string().min(1),
  aliasRegistryHash: z.string().min(1),
  wholeTokenIndex: AliasIndexSchema,
  phoneticIndex: AliasIndexSchema,
  doubleMetaphoneIndex: AliasIndexSchema,
  doubleMetaphoneKeysByAliasId: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
  prefixCatalog: z.array(LookupAliasRuntimePrefixEntrySchema),
  hangulCompletionRecords: z.array(LookupAliasRuntimeHangulCompletionEntrySchema).optional(),
}).strict();

const LookupResolverProjectionDocumentSchema = z.object({
  entityId: z.string().min(1),
  entityType: z.string().min(1),
  canonicalLabel: z.string().min(1),
  aliasesIdentitySafe: z.array(z.string()),
  identitySafeKeys: z.array(z.string().min(1)),
  identityCertificates: z.array(LookupIdentityCertificateSchema).optional(),
  producer: z.string().optional(),
  attributeHints: LookupResolverProjectionHintsSchema.optional(),
  sourceRecordRefs: z.array(LookupRuntimeSourceRecordRefSchema).optional(),
}).strict();

const LookupEntityProjectionDocumentSchema = z.object({
  entityId: z.string().min(1),
  entityType: z.string().min(1),
  canonicalLabel: z.string().min(1),
  aliasesIdentitySafe: z.array(z.string()),
  identitySafeKeys: z.array(z.string().min(1)).optional(),
  familyCoreKeys: z.array(z.string().min(1)).optional(),
  identityCertificates: z.array(LookupIdentityCertificateSchema).optional(),
  aliasesNoisyRecall: z.array(z.string()),
  producer: z.string(),
  attributeHints: LookupResolverProjectionHintsSchema.optional(),
  sourceRecordRefs: z.array(LookupRuntimeSourceRecordRefSchema).optional(),
  region: z.string(),
  grapes: z.array(z.string()),
  searchTextKo: z.string(),
  searchTextEn: z.string(),
  semanticSummary: z.string(),
  pairing: z.array(z.string()),
  availability: z.boolean(),
  popularityScore: z.number().finite(),
}).passthrough();

export const LookupResolverProjectionArtifactSchema = z.object({
  schemaVersion: z.literal(LOOKUP_RESOLVER_PROJECTION_SCHEMA_VERSION),
  snapshotId: z.string().min(1),
  generatedAt: z.string().min(1),
  documents: z.array(LookupResolverProjectionDocumentSchema),
}).strict();

export const LookupEntityProjectionArtifactSchema = z.object({
  schemaVersion: z.literal(LOOKUP_ENTITY_PROJECTION_SCHEMA_VERSION),
  snapshotId: z.string().min(1),
  generatedAt: z.string().min(1),
  documents: z.array(LookupEntityProjectionDocumentSchema),
}).strict();

const LookupAmbiguityRuntimeEntrySchema = z.object({
  normalizedForm: z.string().min(1),
  types: z.array(z.string().min(1)),
  severity: z.enum(['low', 'medium', 'high']),
  entityIds: z.array(z.string().min(1)).optional(),
}).strict();

export const LookupAmbiguityRuntimeArtifactSchema = z.object({
  schemaVersion: z.literal(LOOKUP_AMBIGUITY_RUNTIME_SCHEMA_VERSION),
  snapshotId: z.string().min(1),
  generatedAt: z.string().min(1),
  entries: z.record(z.string().min(1), LookupAmbiguityRuntimeEntrySchema),
}).strict();

const LookupConceptRedirectRuntimeEntrySchema = z.object({
  normalizedForm: z.string().min(1),
  locale: z.enum(['ko', 'global']),
  conceptClass: z.enum(['grape', 'region', 'style', 'recommendation', 'pairing', 'generic']),
  redirectReason: z.enum(['concept_query', 'generic_non_entity_query']),
  sourceEvidence: z.string().min(1),
}).strict();

export const LookupConceptRedirectRuntimeArtifactSchema = z.object({
  schemaVersion: z.literal(LOOKUP_CONCEPT_REDIRECT_RUNTIME_SCHEMA_VERSION),
  snapshotId: z.string().min(1),
  generatedAt: z.string().min(1),
  entries: z.record(z.string().min(1), LookupConceptRedirectRuntimeEntrySchema),
}).strict();

const LookupExactSafeRuntimeEntrySchema = z.object({
  entityId: z.string().min(1),
  locale: z.enum(['ko', 'global']),
  certificate: LookupIdentityCertificateSchema,
}).strict();

export const LookupExactSafeRuntimeArtifactSchema = z.object({
  schemaVersion: z.literal(LOOKUP_EXACT_SAFE_RUNTIME_SCHEMA_VERSION),
  snapshotId: z.string().min(1),
  generatedAt: z.string().min(1),
  exactEntries: z.record(z.string().min(1), LookupExactSafeRuntimeEntrySchema),
  compactEntries: z.record(z.string().min(1), LookupExactSafeRuntimeEntrySchema),
}).strict();

export function parseLookupAliasRuntimeArtifact(
  raw: string,
  filePath: string,
): LookupAliasRuntimeArtifact {
  try {
    return LookupAliasRuntimeArtifactSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Malformed lookup alias runtime artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseLookupAliasRuntimeCoreArtifact(
  raw: string,
  filePath: string,
): LookupAliasRuntimeCoreArtifact {
  try {
    return LookupAliasRuntimeCoreArtifactSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Malformed lookup alias runtime core artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseLookupAliasBroadRecallRuntimeArtifact(
  raw: string,
  filePath: string,
): LookupAliasBroadRecallRuntimeArtifact {
  try {
    return LookupAliasBroadRecallRuntimeArtifactSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Malformed lookup alias broad-recall runtime artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isRuntimeArtifactRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRuntimeArtifactStringRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return isRuntimeArtifactRecord(value);
}

function requireNonEmptyString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} is required`);
  }
}

function requireString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
}

function requireBoolean(
  value: unknown,
  field: string,
): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean`);
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

function requireArray(
  value: unknown,
  field: string,
): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
}

function requireOptionalArray(
  value: unknown,
  field: string,
): void {
  if (value !== undefined && !Array.isArray(value)) {
    throw new Error(`${field} must be an array when present`);
  }
}

function requireOptionalRecord(
  value: unknown,
  field: string,
): void {
  if (value !== undefined && !isRuntimeArtifactRecord(value)) {
    throw new Error(`${field} must be an object when present`);
  }
}

function parseTrustedArtifactRoot(
  raw: string,
  filePath: string,
  {
    schemaVersion,
    errorPrefix,
  }: {
    readonly schemaVersion: string;
    readonly errorPrefix: string;
  },
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRuntimeArtifactRecord(parsed)) {
      throw new Error('root is not an object');
    }
    if (parsed.schemaVersion !== schemaVersion) {
      throw new Error(`schemaVersion must be ${schemaVersion}`);
    }
    requireNonEmptyString(parsed.snapshotId, 'snapshotId');
    requireNonEmptyString(parsed.generatedAt, 'generatedAt');
    return parsed;
  } catch (error) {
    throw new Error(
      `${errorPrefix} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseTrustedLookupAliasRuntimeArtifact(
  raw: string,
  filePath: string,
): LookupAliasRuntimeArtifact {
  try {
    const parsed = parseTrustedArtifactRoot(raw, filePath, {
      schemaVersion: LOOKUP_ALIAS_RUNTIME_SCHEMA_VERSION,
      errorPrefix: 'Malformed trusted lookup alias runtime artifact',
    });
    requireNonEmptyString(parsed.aliasRegistryHash, 'aliasRegistryHash');
    if (!Array.isArray(parsed.aliases)) {
      throw new Error('aliases must be an array');
    }
    if (parsed.surfaceForms !== undefined && !Array.isArray(parsed.surfaceForms)) {
      throw new Error('surfaceForms must be an array');
    }
    if (!isRuntimeArtifactStringRecord(parsed.exactIndex)) {
      throw new Error('exactIndex must be an object');
    }
    if (!isRuntimeArtifactStringRecord(parsed.compactIndex)) {
      throw new Error('compactIndex must be an object');
    }
    if (!isRuntimeArtifactStringRecord(parsed.wholeTokenIndex)) {
      throw new Error('wholeTokenIndex must be an object');
    }
    if (!isRuntimeArtifactStringRecord(parsed.phoneticIndex)) {
      throw new Error('phoneticIndex must be an object');
    }
    if (!isRuntimeArtifactStringRecord(parsed.doubleMetaphoneIndex)) {
      throw new Error('doubleMetaphoneIndex must be an object');
    }
    if (parsed.doubleMetaphoneKeysByAliasId !== undefined && !isRuntimeArtifactStringRecord(parsed.doubleMetaphoneKeysByAliasId)) {
      throw new Error('doubleMetaphoneKeysByAliasId must be an object');
    }
    if (!Array.isArray(parsed.prefixCatalog)) {
      throw new Error('prefixCatalog must be an array');
    }
    if (parsed.hangulCompletionRecords !== undefined && !Array.isArray(parsed.hangulCompletionRecords)) {
      throw new Error('hangulCompletionRecords must be an array');
    }
    return parsed as unknown as LookupAliasRuntimeArtifact;
  } catch (error) {
    throw new Error(
      `Malformed trusted lookup alias runtime artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseTrustedLookupAliasRuntimeCoreArtifact(
  raw: string,
  filePath: string,
): LookupAliasRuntimeCoreArtifact {
  try {
    const parsed = parseTrustedArtifactRoot(raw, filePath, {
      schemaVersion: LOOKUP_ALIAS_CORE_RUNTIME_SCHEMA_VERSION,
      errorPrefix: 'Malformed trusted lookup alias runtime core artifact',
    });
    requireNonEmptyString(parsed.aliasRegistryHash, 'aliasRegistryHash');
    if (!Array.isArray(parsed.aliases)) {
      throw new Error('aliases must be an array');
    }
    if (parsed.surfaceForms !== undefined && !Array.isArray(parsed.surfaceForms)) {
      throw new Error('surfaceForms must be an array');
    }
    if (!isRuntimeArtifactStringRecord(parsed.exactIndex)) {
      throw new Error('exactIndex must be an object');
    }
    if (!isRuntimeArtifactStringRecord(parsed.compactIndex)) {
      throw new Error('compactIndex must be an object');
    }
    return parsed as unknown as LookupAliasRuntimeCoreArtifact;
  } catch (error) {
    throw new Error(
      `Malformed trusted lookup alias runtime core artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseTrustedLookupAliasBroadRecallRuntimeArtifact(
  raw: string,
  filePath: string,
): LookupAliasBroadRecallRuntimeArtifact {
  try {
    const parsed = parseTrustedArtifactRoot(raw, filePath, {
      schemaVersion: LOOKUP_ALIAS_BROAD_RECALL_RUNTIME_SCHEMA_VERSION,
      errorPrefix: 'Malformed trusted lookup alias broad-recall runtime artifact',
    });
    requireNonEmptyString(parsed.aliasRegistryHash, 'aliasRegistryHash');
    if (!isRuntimeArtifactStringRecord(parsed.wholeTokenIndex)) {
      throw new Error('wholeTokenIndex must be an object');
    }
    if (!isRuntimeArtifactStringRecord(parsed.phoneticIndex)) {
      throw new Error('phoneticIndex must be an object');
    }
    if (!isRuntimeArtifactStringRecord(parsed.doubleMetaphoneIndex)) {
      throw new Error('doubleMetaphoneIndex must be an object');
    }
    if (parsed.doubleMetaphoneKeysByAliasId !== undefined && !isRuntimeArtifactStringRecord(parsed.doubleMetaphoneKeysByAliasId)) {
      throw new Error('doubleMetaphoneKeysByAliasId must be an object');
    }
    if (!Array.isArray(parsed.prefixCatalog)) {
      throw new Error('prefixCatalog must be an array');
    }
    if (parsed.hangulCompletionRecords !== undefined && !Array.isArray(parsed.hangulCompletionRecords)) {
      throw new Error('hangulCompletionRecords must be an array');
    }
    return parsed as unknown as LookupAliasBroadRecallRuntimeArtifact;
  } catch (error) {
    throw new Error(
      `Malformed trusted lookup alias broad-recall runtime artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseLookupEntityProjectionArtifact(
  raw: string,
  filePath: string,
): LookupEntityProjectionArtifact {
  try {
    return LookupEntityProjectionArtifactSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Malformed lookup entity projection artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseTrustedLookupEntityProjectionArtifact(
  raw: string,
  filePath: string,
): LookupEntityProjectionArtifact {
  try {
    const parsed = parseTrustedArtifactRoot(raw, filePath, {
      schemaVersion: LOOKUP_ENTITY_PROJECTION_SCHEMA_VERSION,
      errorPrefix: 'Malformed trusted lookup entity projection artifact',
    });
    requireArray(parsed.documents, 'documents');
    for (const [index, doc] of parsed.documents.entries()) {
      if (!isRuntimeArtifactRecord(doc)) {
        throw new Error(`documents[${index}] must be an object`);
      }
      requireNonEmptyString(doc.entityId, `documents[${index}].entityId`);
      requireNonEmptyString(doc.entityType, `documents[${index}].entityType`);
      requireNonEmptyString(doc.canonicalLabel, `documents[${index}].canonicalLabel`);
      requireArray(doc.aliasesIdentitySafe, `documents[${index}].aliasesIdentitySafe`);
      requireOptionalArray(doc.identitySafeKeys, `documents[${index}].identitySafeKeys`);
      requireOptionalArray(doc.familyCoreKeys, `documents[${index}].familyCoreKeys`);
      requireOptionalArray(doc.identityCertificates, `documents[${index}].identityCertificates`);
      requireArray(doc.aliasesNoisyRecall, `documents[${index}].aliasesNoisyRecall`);
      requireString(doc.producer, `documents[${index}].producer`);
      requireOptionalRecord(doc.attributeHints, `documents[${index}].attributeHints`);
      requireOptionalArray(doc.sourceRecordRefs, `documents[${index}].sourceRecordRefs`);
      requireString(doc.region, `documents[${index}].region`);
      requireArray(doc.grapes, `documents[${index}].grapes`);
      requireString(doc.searchTextKo, `documents[${index}].searchTextKo`);
      requireString(doc.searchTextEn, `documents[${index}].searchTextEn`);
      requireString(doc.semanticSummary, `documents[${index}].semanticSummary`);
      requireArray(doc.pairing, `documents[${index}].pairing`);
      requireBoolean(doc.availability, `documents[${index}].availability`);
      requireFiniteNumber(doc.popularityScore, `documents[${index}].popularityScore`);
    }
    return parsed as unknown as LookupEntityProjectionArtifact;
  } catch (error) {
    throw new Error(
      `Malformed trusted lookup entity projection artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseLookupResolverProjectionArtifact(
  raw: string,
  filePath: string,
): LookupResolverProjectionArtifact {
  try {
    return LookupResolverProjectionArtifactSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Malformed lookup resolver projection artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseTrustedLookupResolverProjectionArtifact(
  raw: string,
  filePath: string,
): LookupResolverProjectionArtifact {
  try {
    const parsed = parseTrustedArtifactRoot(raw, filePath, {
      schemaVersion: LOOKUP_RESOLVER_PROJECTION_SCHEMA_VERSION,
      errorPrefix: 'Malformed trusted lookup resolver projection artifact',
    });
    requireArray(parsed.documents, 'documents');
    for (const [index, doc] of parsed.documents.entries()) {
      if (!isRuntimeArtifactRecord(doc)) {
        throw new Error(`documents[${index}] must be an object`);
      }
      requireNonEmptyString(doc.entityId, `documents[${index}].entityId`);
      requireNonEmptyString(doc.entityType, `documents[${index}].entityType`);
      requireNonEmptyString(doc.canonicalLabel, `documents[${index}].canonicalLabel`);
      requireArray(doc.aliasesIdentitySafe, `documents[${index}].aliasesIdentitySafe`);
      requireArray(doc.identitySafeKeys, `documents[${index}].identitySafeKeys`);
      requireOptionalArray(doc.identityCertificates, `documents[${index}].identityCertificates`);
      if (doc.producer !== undefined) {
        requireString(doc.producer, `documents[${index}].producer`);
      }
      requireOptionalRecord(doc.attributeHints, `documents[${index}].attributeHints`);
      requireOptionalArray(doc.sourceRecordRefs, `documents[${index}].sourceRecordRefs`);
    }
    return parsed as unknown as LookupResolverProjectionArtifact;
  } catch (error) {
    throw new Error(
      `Malformed trusted lookup resolver projection artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseLookupAmbiguityRuntimeArtifact(
  raw: string,
  filePath: string,
): LookupAmbiguityRuntimeArtifact {
  try {
    return LookupAmbiguityRuntimeArtifactSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Malformed lookup ambiguity runtime artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseTrustedLookupAmbiguityRuntimeArtifact(
  raw: string,
  filePath: string,
): LookupAmbiguityRuntimeArtifact {
  try {
    const parsed = parseTrustedArtifactRoot(raw, filePath, {
      schemaVersion: LOOKUP_AMBIGUITY_RUNTIME_SCHEMA_VERSION,
      errorPrefix: 'Malformed trusted lookup ambiguity runtime artifact',
    });
    if (!isRuntimeArtifactStringRecord(parsed.entries)) {
      throw new Error('entries must be an object');
    }
    for (const [normalizedForm, entry] of Object.entries(parsed.entries)) {
      if (!isRuntimeArtifactRecord(entry)) {
        throw new Error(`entries.${normalizedForm} must be an object`);
      }
      requireNonEmptyString(entry.normalizedForm, `entries.${normalizedForm}.normalizedForm`);
      requireArray(entry.types, `entries.${normalizedForm}.types`);
      if (entry.severity !== 'low' && entry.severity !== 'medium' && entry.severity !== 'high') {
        throw new Error(`entries.${normalizedForm}.severity is invalid`);
      }
      requireOptionalArray(entry.entityIds, `entries.${normalizedForm}.entityIds`);
    }
    return parsed as unknown as LookupAmbiguityRuntimeArtifact;
  } catch (error) {
    throw new Error(
      `Malformed trusted lookup ambiguity runtime artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseLookupConceptRedirectRuntimeArtifact(
  raw: string,
  filePath: string,
): LookupConceptRedirectRuntimeArtifact {
  try {
    return LookupConceptRedirectRuntimeArtifactSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Malformed lookup concept redirect runtime artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseTrustedLookupConceptRedirectRuntimeArtifact(
  raw: string,
  filePath: string,
): LookupConceptRedirectRuntimeArtifact {
  try {
    const parsed = parseTrustedArtifactRoot(raw, filePath, {
      schemaVersion: LOOKUP_CONCEPT_REDIRECT_RUNTIME_SCHEMA_VERSION,
      errorPrefix: 'Malformed trusted lookup concept redirect runtime artifact',
    });
    if (!isRuntimeArtifactStringRecord(parsed.entries)) {
      throw new Error('entries must be an object');
    }
    for (const [normalizedForm, entry] of Object.entries(parsed.entries)) {
      if (!isRuntimeArtifactRecord(entry)) {
        throw new Error(`entries.${normalizedForm} must be an object`);
      }
      requireNonEmptyString(entry.normalizedForm, `entries.${normalizedForm}.normalizedForm`);
      if (entry.locale !== 'ko' && entry.locale !== 'global') {
        throw new Error(`entries.${normalizedForm}.locale is invalid`);
      }
      if (!['grape', 'region', 'style', 'recommendation', 'pairing', 'generic'].includes(String(entry.conceptClass))) {
        throw new Error(`entries.${normalizedForm}.conceptClass is invalid`);
      }
      if (!['concept_query', 'generic_non_entity_query'].includes(String(entry.redirectReason))) {
        throw new Error(`entries.${normalizedForm}.redirectReason is invalid`);
      }
      requireNonEmptyString(entry.sourceEvidence, `entries.${normalizedForm}.sourceEvidence`);
    }
    return parsed as unknown as LookupConceptRedirectRuntimeArtifact;
  } catch (error) {
    throw new Error(
      `Malformed trusted lookup concept redirect runtime artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseLookupExactSafeRuntimeArtifact(
  raw: string,
  filePath: string,
): LookupExactSafeRuntimeArtifact {
  try {
    return LookupExactSafeRuntimeArtifactSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Malformed lookup exact-safe runtime artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateTrustedLookupExactSafeEntry(
  entry: unknown,
  field: string,
  filePath: string,
): void {
  if (!isRuntimeArtifactRecord(entry)) {
    throw new Error(`Malformed trusted lookup exact-safe runtime artifact at ${filePath}: ${field} must be an object`);
  }
  requireNonEmptyString(entry.entityId, `${field}.entityId`);
  if (entry.locale !== 'ko' && entry.locale !== 'global') {
    throw new Error(`Malformed trusted lookup exact-safe runtime artifact at ${filePath}: ${field}.locale is invalid`);
  }
  if (!isRuntimeArtifactRecord(entry.certificate)) {
    throw new Error(`Malformed trusted lookup exact-safe runtime artifact at ${filePath}: ${field}.certificate must be an object`);
  }
  const certificate = entry.certificate;
  if (certificate.kind !== 'exact_safe' && certificate.kind !== 'compact_exact_safe') {
    throw new Error(`Malformed trusted lookup exact-safe runtime artifact at ${filePath}: ${field}.certificate.kind is invalid`);
  }
  requireNonEmptyString(certificate.normalizedSurface, `${field}.certificate.normalizedSurface`);
  if (certificate.compactSurface !== undefined) {
    requireNonEmptyString(certificate.compactSurface, `${field}.certificate.compactSurface`);
  }
  if (!['curated', 'catalog', 'translation'].includes(String(certificate.sourceTier))) {
    throw new Error(`Malformed trusted lookup exact-safe runtime artifact at ${filePath}: ${field}.certificate.sourceTier is invalid`);
  }
  if (certificate.singleton !== true || certificate.collisionFree !== true) {
    throw new Error(`Malformed trusted lookup exact-safe runtime artifact at ${filePath}: ${field}.certificate singleton/collisionFree must be true`);
  }
}

export function parseTrustedLookupExactSafeRuntimeArtifact(
  raw: string,
  filePath: string,
): LookupExactSafeRuntimeArtifact {
  try {
    const parsed = parseTrustedArtifactRoot(raw, filePath, {
      schemaVersion: LOOKUP_EXACT_SAFE_RUNTIME_SCHEMA_VERSION,
      errorPrefix: 'Malformed trusted lookup exact-safe runtime artifact',
    });
    if (!isRuntimeArtifactStringRecord(parsed.exactEntries)) {
      throw new Error('exactEntries must be an object');
    }
    if (!isRuntimeArtifactStringRecord(parsed.compactEntries)) {
      throw new Error('compactEntries must be an object');
    }
    for (const [surface, entry] of Object.entries(parsed.exactEntries)) {
      validateTrustedLookupExactSafeEntry(entry, `exactEntries.${surface}`, filePath);
    }
    for (const [surface, entry] of Object.entries(parsed.compactEntries)) {
      validateTrustedLookupExactSafeEntry(entry, `compactEntries.${surface}`, filePath);
    }
    return parsed as unknown as LookupExactSafeRuntimeArtifact;
  } catch (error) {
    throw new Error(
      `Malformed trusted lookup exact-safe runtime artifact at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function buildLookupAliasRuntimeArtifactHash(
  artifact: LookupAliasRuntimeArtifact,
): string {
  return hashStableJson({
    schemaVersion: artifact.schemaVersion,
    aliasRegistryHash: artifact.aliasRegistryHash,
    aliases: artifact.aliases,
    surfaceForms: artifact.surfaceForms,
    exactIndex: artifact.exactIndex,
    compactIndex: artifact.compactIndex,
    wholeTokenIndex: artifact.wholeTokenIndex,
    phoneticIndex: artifact.phoneticIndex,
    doubleMetaphoneIndex: artifact.doubleMetaphoneIndex,
    ...(artifact.doubleMetaphoneKeysByAliasId !== undefined
      ? { doubleMetaphoneKeysByAliasId: artifact.doubleMetaphoneKeysByAliasId }
      : {}),
    prefixCatalog: artifact.prefixCatalog,
    hangulCompletionRecords: artifact.hangulCompletionRecords,
  });
}

export function buildLookupAliasRuntimeCoreArtifactHash(
  artifact: LookupAliasRuntimeCoreArtifact,
): string {
  return hashStableJson({
    schemaVersion: artifact.schemaVersion,
    aliasRegistryHash: artifact.aliasRegistryHash,
    aliases: artifact.aliases,
    ...(artifact.surfaceForms !== undefined ? { surfaceForms: artifact.surfaceForms } : {}),
    exactIndex: artifact.exactIndex,
    compactIndex: artifact.compactIndex,
  });
}

export function buildLookupAliasBroadRecallRuntimeArtifactHash(
  artifact: LookupAliasBroadRecallRuntimeArtifact,
): string {
  return hashStableJson({
    schemaVersion: artifact.schemaVersion,
    aliasRegistryHash: artifact.aliasRegistryHash,
    wholeTokenIndex: artifact.wholeTokenIndex,
    phoneticIndex: artifact.phoneticIndex,
    doubleMetaphoneIndex: artifact.doubleMetaphoneIndex,
    ...(artifact.doubleMetaphoneKeysByAliasId !== undefined
      ? { doubleMetaphoneKeysByAliasId: artifact.doubleMetaphoneKeysByAliasId }
      : {}),
    prefixCatalog: artifact.prefixCatalog,
    ...(artifact.hangulCompletionRecords !== undefined
      ? { hangulCompletionRecords: artifact.hangulCompletionRecords }
      : {}),
  });
}

export function buildLookupEntityProjectionArtifactHash(
  artifact: LookupEntityProjectionArtifact,
): string {
  return hashStableJson({
    schemaVersion: artifact.schemaVersion,
    documents: artifact.documents,
  });
}

export function buildLookupResolverProjectionArtifactHash(
  artifact: LookupResolverProjectionArtifact,
): string {
  return hashStableJson({
    schemaVersion: artifact.schemaVersion,
    documents: artifact.documents,
  });
}

export function buildLookupAmbiguityRuntimeArtifactHash(
  artifact: LookupAmbiguityRuntimeArtifact,
): string {
  return hashStableJson({
    schemaVersion: artifact.schemaVersion,
    entries: artifact.entries,
  });
}

export function buildLookupConceptRedirectRuntimeArtifactHash(
  artifact: LookupConceptRedirectRuntimeArtifact,
): string {
  return hashStableJson({
    schemaVersion: artifact.schemaVersion,
    entries: artifact.entries,
  });
}

export function buildLookupExactSafeRuntimeArtifactHash(
  artifact: LookupExactSafeRuntimeArtifact,
): string {
  return hashStableJson({
    schemaVersion: artifact.schemaVersion,
    exactEntries: artifact.exactEntries,
    compactEntries: artifact.compactEntries,
  });
}

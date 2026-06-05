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
  readonly syllableBoundaryOffsets: readonly number[];
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
  readonly doubleMetaphoneKeysByAliasId: Readonly<Record<string, readonly string[]>>;
  readonly prefixCatalog: readonly LookupAliasRuntimePrefixEntry[];
  readonly hangulCompletionRecords: readonly LookupAliasRuntimeHangulCompletionEntry[];
}

export interface LookupEntityProjectionDocument {
  readonly entityId: string;
  readonly entityType: string;
  readonly canonicalLabel: string;
  readonly aliasesIdentitySafe: readonly string[];
  readonly aliasesNoisyRecall: readonly string[];
  readonly producer: string;
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
  syllableBoundaryOffsets: NonNegativeIntArraySchema,
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
  doubleMetaphoneKeysByAliasId: z.record(z.string().min(1), z.array(z.string().min(1))),
  prefixCatalog: z.array(LookupAliasRuntimePrefixEntrySchema),
  hangulCompletionRecords: z.array(LookupAliasRuntimeHangulCompletionEntrySchema),
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
  aliasesNoisyRecall: z.array(z.string()),
  producer: z.string(),
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
    doubleMetaphoneKeysByAliasId: artifact.doubleMetaphoneKeysByAliasId,
    prefixCatalog: artifact.prefixCatalog,
    hangulCompletionRecords: artifact.hangulCompletionRecords,
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

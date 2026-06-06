#!/usr/bin/env tsx

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { parseNdjson } from './ndjson.js';
import type { EnrichedSilverRecord, PriceBand, WineType } from './types.js';
import { atomicWriteFile } from './etl-utils.js';
import {
  buildSearchSnapshotContentHash,
  buildSearchSnapshotId,
  hashStableJson,
  hashText,
  serializeNdjson,
  stableJsonStringify,
  type EntitySnapshotRecord,
  type SearchSnapshotManifest,
} from './search-snapshot-schema.js';
import { resolveAliasClaimsAndBuildAmbiguityRegistry } from './build-ambiguity-registry.js';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../../src/domain/shared/constants/search-snapshot.js';
import { buildAliasArtifact } from './build-alias-artifact.js';
import type { SnapshotAliasOverlayProposal } from './build-alias-artifact.js';
import {
  loadActiveSourceEntityContinuity,
  loadGoldCanonicalLookupForBuild,
  resolveDefaultFixtureRepoRoot,
  resolveWineSnapshotEntity,
  type SourceEntityContinuityRecord as _SourceEntityContinuityRecord,
} from './snapshot-entity-identity.js';
import { normalizeCanonicalLabelForIdentity } from '../../src/domain/entity/model/identity-signature.js';
import type {
  CanonicalEntityId,
  SourceRecordId,
} from '../../src/domain/shared/types/entity-id.js';
import { parseAliasType } from '../../src/domain/alias/model/alias.js';
import {
  SOURCE_SYSTEM_BENCHMARK_ANCHOR_CATALOG,
  SOURCE_SYSTEM_VIVINO_SILVER,
} from '../../src/domain/shared/constants/source-systems.js';
import { ETL_ARTIFACT_FILES } from './artifact-contract.js';
import { assertCanonicalTrackCArtifactInput } from './artifact-contract.js';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import { loadRequiredFixtureTargetIds } from './verify-runtime-gold-catalog-coverage.js';
import { hasHangul } from './build-alias-artifact.js';
import {
  BEGINNER_SUITABILITY_VERSION,
  GIFT_SUITABILITY_VERSION,
} from '../../src/domain/attribute/service/ontology-normalizer.js';
import {
  type SearchFieldAvailabilityMetric,
  type SearchSnapshotFieldAvailability,
} from '../../src/domain/shared/types/search-field-availability.js';
import {
  canonicalizeAliasSnapshotRecords,
  canonicalizeAmbiguitySnapshotRows,
  canonicalizeEntitySnapshotRecords,
} from '../../src/domain/shared/utils/search-snapshot-canonicalization.js';
import {
  buildLookupAliasRuntimeArtifacts,
  buildLookupAmbiguityRuntimeArtifact,
  buildLookupConceptRedirectRuntimeArtifact,
  buildLookupEntityProjectionArtifact,
  buildLookupExactSafeRuntimeArtifact,
  buildLookupResolverProjectionArtifact,
} from './build-lookup-runtime-pack.js';
import {
  buildLookupReviewedFamilyRecallRuntimeArtifact,
  buildLookupScopeGraphRuntimeArtifact,
  buildLookupSemanticScopeRuntimeArtifact,
} from './build-lookup-semantic-runtime-pack.js';
import {
  buildLookupAliasBroadRecallRuntimeArtifactHash,
  buildLookupAliasRuntimeCoreArtifactHash,
  buildLookupAmbiguityRuntimeArtifactHash,
  buildLookupConceptRedirectRuntimeArtifactHash,
  buildLookupEntityProjectionArtifactHash,
  buildLookupExactSafeRuntimeArtifactHash,
  buildLookupResolverProjectionArtifactHash,
} from '../../src/domain/shared/types/search-snapshot-lookup-runtime.js';
import {
  buildLookupReviewedFamilyRecallRuntimeArtifactHash,
  buildLookupScopeGraphRuntimeArtifactHash,
  buildLookupSemanticScopeRuntimeArtifactHash,
} from '../../src/domain/shared/types/search-snapshot-lookup-semantic-runtime.js';
import {
  buildLookupRuntimeBundleCachePayload,
  writeLookupRuntimeBundleCache,
} from '../../src/config/lookup-runtime-bundle-cache.js';
import { createCanonicalEntityId } from '../../src/domain/shared/types/index.js';
import {
  CORE_KOREAN_ICON_AMBIGUITY_CASES,
  CORE_KOREAN_ICON_QUERY_CASES,
  CORE_KOREAN_ICON_RELEASE_GATE_CASES,
} from '../../test/support/core-korean-icon-fixtures.js';
import {
  assertLookupExactSafeRegistryCompatibleWithBaseAliases,
  buildLookupIdentityCertificatesByEntity,
  buildLookupRuntimeOverlayAliases,
  loadLookupExactSafeRegistry,
} from './lookup-exact-safe-registry.js';
import {
  buildLookupAmbiguityRegistryEntries,
  buildLookupConceptRedirectRegistryEntries,
  loadLookupAmbiguityRegistry,
  loadLookupConceptRedirectRegistry,
} from './lookup-authority-registries.js';
import { assertLookupAuthorityBoundaryConsistency } from './lookup-authority-boundaries.js';
import { loadLookupPolicyConflictRegistrySync } from '../eval/lookup-v2-policy-conflict-registry.js';
import { loadLookupV2FamilyCollisionRegistrySync } from '../eval/lookup-v2-family-collision-registry.js';
import { loadLookupV2FamilyCoreWitnessRegistrySync } from '../eval/lookup-v2-family-core-witness-registry.js';
import { loadLookupV2LocalizedSurfaceRegistrySync } from '../eval/lookup-v2-localized-surface-registry.js';
import { loadLookupV2PolicyFamilyDecisionRegistrySync } from '../eval/lookup-v2-policy-family-decision-registry.js';
import { loadLookupV2SemanticScopeTargetRegistrySync } from '../eval/lookup-v2-semantic-scope-target-registry.js';
import { buildLookupV2RuntimeSemanticDescriptorMapFromDocuments } from '../eval/lookup-v2-runtime-semantic-descriptors.js';
import { buildReviewedCollisionFamilyCoreKeysByEntity } from '../eval/lookup-v2-runtime-surface-owner-evidence.js';

export const DEFAULT_INPUT = ETL_ARTIFACT_FILES.trackc;
export const DEFAULT_OUTPUT_DIR = ETL_ARTIFACT_FILES.searchSnapshotsDir;
export const DEFAULT_NL_MAPPINGS = ETL_ARTIFACT_FILES.nlMappings;
export const DEFAULT_RUNTIME_STATE_PATH = resolveDataPath('data/runtime-search-snapshot.json');
const REPO_GOLD_CATALOG_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'data',
  'gold-wine-catalog.jsonl',
);

function buildReviewedFamilyCoreKeysByEntity(
  reviewedFamilyCoreWitnessRows: readonly {
    readonly entityId: string;
    readonly normalizedSurface: string;
  }[],
): ReadonlyMap<CanonicalEntityId, readonly string[]> {
  const grouped = new Map<CanonicalEntityId, Set<string>>();
  for (const row of reviewedFamilyCoreWitnessRows) {
    const existing = grouped.get(row.entityId as CanonicalEntityId) ?? new Set<string>();
    existing.add(row.normalizedSurface);
    grouped.set(row.entityId as CanonicalEntityId, existing);
  }
  return new Map(
    [...grouped.entries()].map(([entityId, surfaces]) => [
      entityId,
      [...surfaces].sort((left, right) => left.localeCompare(right)),
    ]),
  );
}

const RepoGoldCatalogRowSchema = z.object({
  entityId: z.string().min(1),
  canonicalLabel: z.string().min(1),
  producer: z.string().min(1),
  country: z.string().min(1),
  region: z.string().min(1),
  appellation: z.string().min(1).optional(),
  grapes: z.array(z.string().min(1)).min(1),
  wineType: z.enum(['red', 'white', 'sparkling', 'dessert', 'rosé', 'fortified']),
  vintageYear: z.number().int().min(0).max(2035),
  priceUsd: z.number().finite().positive(),
  body: z.number().int().min(1).max(5).nullable(),
  tannin: z.number().int().min(1).max(5).nullable(),
  acidity: z.number().int().min(1).max(5).nullable(),
  criticScore: z.number().int().min(0).max(100),
  style: z.string().min(1),
  koreanAliases: z.array(z.string().min(1)),
}).strict();

type RepoGoldCatalogRow = z.infer<typeof RepoGoldCatalogRowSchema>;

export interface Args {
  readonly input: string;
  readonly outputDir: string;
  readonly nlMappings: string;
  readonly fixtureRepoRoot?: string | undefined;
  readonly runtimeStatePath?: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  let input = DEFAULT_INPUT;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let nlMappings = DEFAULT_NL_MAPPINGS;
  let fixtureRepoRoot: string | undefined;
  let runtimeStatePath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' || arg === '-i') {
      input = argv[i + 1] ?? DEFAULT_INPUT;
      i += 1;
    } else if (arg === '--output-dir' || arg === '-o') {
      outputDir = argv[i + 1] ?? DEFAULT_OUTPUT_DIR;
      i += 1;
    } else if (arg === '--nl-mappings') {
      nlMappings = argv[i + 1] ?? DEFAULT_NL_MAPPINGS;
      i += 1;
    } else if (arg === '--fixture-repo') {
      fixtureRepoRoot = argv[i + 1];
      i += 1;
    } else if (arg === '--runtime-state') {
      runtimeStatePath = argv[i + 1] ?? DEFAULT_RUNTIME_STATE_PATH;
      i += 1;
    }
  }
  return { input, outputDir, nlMappings, fixtureRepoRoot, runtimeStatePath };
}

function parseNlMappings(raw: string): { readonly mappingCount: number; readonly payload: unknown } {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('NL mappings JSON must be an object');
  }
  const record = parsed as Record<string, unknown>;
  const mappings = record['mappings'];
  if (!Array.isArray(mappings)) {
    throw new Error('NL mappings JSON must contain a mappings[] array');
  }
  return {
    mappingCount: mappings.length,
    payload: parsed,
  };
}

export interface BuildSearchSnapshotResult {
  readonly manifest: SearchSnapshotManifest;
  readonly snapshotRoot: string;
  readonly manifestPath: string;
}

type SnapshotBuildRecord = EnrichedSilverRecord & {
  readonly benchmarkAnchorEntityId?: CanonicalEntityId | undefined;
  readonly sourceSystemOverride?: string | undefined;
  readonly certificationsExperimental?: unknown;
};

function buildFieldAvailability(
  records: readonly SnapshotBuildRecord[],
): SearchSnapshotFieldAvailability {
  const totalDocCount = records.length;
  const toMetric = (populatedDocCount: number): SearchFieldAvailabilityMetric => ({
    populatedDocCount,
    totalDocCount,
    populatedDocRatio: totalDocCount > 0 ? populatedDocCount / totalDocCount : 0,
  });
  const countWhere = (predicate: (record: SnapshotBuildRecord) => boolean): number =>
    records.filter(predicate).length;

  return {
    appellation: toMetric(countWhere((record) =>
      typeof record.appellation === 'string' && record.appellation.trim().length > 0,
    )),
    body: toMetric(countWhere((record) => record.body != null)),
    sweetness: toMetric(countWhere((record) => record.sweetness != null)),
    acidity: toMetric(countWhere((record) => record.acidity != null)),
    tannin: toMetric(countWhere((record) => record.tannin != null)),
  };
}

/**
 * Benchmark-anchor suitability artifact.
 *
 * Historically, gift/beginner suitability scores for the 6-7 benchmark
 * anchor wines were inlined as a TypeScript literal in this file.
 * That mixed catalog data with build code, blocked operator audit, and
 * made model/prompt version changes invisible to git diff of `data/`.
 *
 * The data now lives in `data/benchmarks/anchor-suitability-v1.json`,
 * loaded at runtime and validated against the Zod schema below.
 * Bumping the model / prompt version is a single-file JSON change;
 * code remains untouched.
 *
 * Path resolution: unlike build-generated artifacts (silver.ndjson, etc.)
 * this artifact is git-tracked and authoritative under the repo. We honour
 * the standard `WINE_DATA_DIR` / home-data-dir override via
 * `resolveDataPath`, but if the resolved file is missing we fall back to
 * the repo copy. That keeps the loader working in clean checkouts and
 * test environments that have no `~/.wine-search-engine/data/benchmarks/`.
 */
const BENCHMARK_ANCHOR_SUITABILITY_VERSION = 'v1';

const REPO_BENCHMARK_ANCHOR_SUITABILITY_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'data',
  'benchmarks',
  'anchor-suitability-v1.json',
);

export const DEFAULT_BENCHMARK_ANCHOR_SUITABILITY_PATH = resolveDataPath(
  'data/benchmarks/anchor-suitability-v1.json',
);

const BenchmarkAnchorSuitabilityScoreSchema = z.object({
  score: z.number().finite().min(0).max(1),
  evidenceAxes: z.array(z.string().min(1)).max(64),
  snippet: z.string().min(1),
  rationale: z.string().min(1),
}).strict();

const BenchmarkAnchorSuitabilityEntrySchema = z.object({
  gift: BenchmarkAnchorSuitabilityScoreSchema,
  beginner: BenchmarkAnchorSuitabilityScoreSchema,
}).strict();

const BenchmarkAnchorSuitabilityArtifactSchema = z.object({
  version: z.literal(BENCHMARK_ANCHOR_SUITABILITY_VERSION),
  generatedAt: z.string().datetime(),
  model: z.string().min(1),
  promptVersions: z.object({
    gift: z.string().min(1),
    beginner: z.string().min(1),
  }).strict(),
  entities: z.record(z.string().min(1), BenchmarkAnchorSuitabilityEntrySchema),
}).strict();

export type BenchmarkAnchorSuitabilityArtifact = z.infer<typeof BenchmarkAnchorSuitabilityArtifactSchema>;
export type BenchmarkAnchorSuitabilityEntry = z.infer<typeof BenchmarkAnchorSuitabilityEntrySchema>;

const benchmarkAnchorSuitabilityCache = new Map<string, BenchmarkAnchorSuitabilityArtifact>();

/**
 * Load + validate the benchmark anchor suitability artifact.
 * Memoized per absolute path so a single build does not re-read/re-validate.
 *
 * If the caller does not pass an explicit path, the loader prefers the
 * `WINE_DATA_DIR` / home-data-dir resolution (production convention) and
 * silently falls back to the in-repo git-tracked copy when the resolved
 * file is missing.
 */
export async function loadBenchmarkAnchorSuitabilityArtifact(
  artifactPath?: string,
): Promise<BenchmarkAnchorSuitabilityArtifact> {
  const resolvedPath = artifactPath ?? resolveBenchmarkAnchorSuitabilityPath();
  const cached = benchmarkAnchorSuitabilityCache.get(resolvedPath);
  if (cached !== undefined) {
    return cached;
  }
  const raw = await fs.readFile(resolvedPath, 'utf8');
  const parsedJson: unknown = JSON.parse(raw);
  const result = BenchmarkAnchorSuitabilityArtifactSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error(
      `Benchmark anchor suitability artifact "${resolvedPath}" failed schema validation: ${result.error.message}`,
    );
  }
  benchmarkAnchorSuitabilityCache.set(resolvedPath, result.data);
  return result.data;
}

function resolveBenchmarkAnchorSuitabilityPath(): string {
  if (existsSync(DEFAULT_BENCHMARK_ANCHOR_SUITABILITY_PATH)) {
    return DEFAULT_BENCHMARK_ANCHOR_SUITABILITY_PATH;
  }
  return REPO_BENCHMARK_ANCHOR_SUITABILITY_PATH;
}

/** Test-only: reset memoization between cases. */
export function _resetBenchmarkAnchorSuitabilityArtifactCache(): void {
  benchmarkAnchorSuitabilityCache.clear();
}

const SILVER_WINE_TYPES: readonly WineType[] = [
  'red',
  'white',
  'rosé',
  'sparkling',
  'dessert',
  'fortified',
] as const;

const SILVER_PRICE_BANDS: readonly PriceBand[] = [
  'value',
  'mid',
  'premium',
  'luxury',
] as const;


function assertSuitabilityCoverage(records: readonly EnrichedSilverRecord[]): void {
  const missingGift = records.filter((record) => record.giftSuitabilityClassification?.score == null);
  if (missingGift.length > 0) {
    throw new Error(
      `Search snapshot build requires full giftSuitabilityClassification coverage; missing ${missingGift.length}/${records.length} records`,
    );
  }

  const missingBeginner = records.filter((record) => record.beginnerSuitabilityClassification?.score == null);
  if (missingBeginner.length > 0) {
    throw new Error(
      `Search snapshot build requires full beginnerSuitabilityClassification coverage; missing ${missingBeginner.length}/${records.length} records`,
    );
  }
}

function resolveFixtureRepoRoot(explicit: string | undefined): string | undefined {
  if (explicit != null && explicit.length > 0) {
    return explicit;
  }
  return resolveDefaultFixtureRepoRoot();
}

function collectCoreIconRequiredBenchmarkTargetIds(): readonly string[] {
  const targetIds = new Set<string>();
  for (const testCase of CORE_KOREAN_ICON_QUERY_CASES) {
    targetIds.add(testCase.expectedEntityId);
  }
  for (const testCase of CORE_KOREAN_ICON_RELEASE_GATE_CASES) {
    targetIds.add(testCase.expectedEntityId);
  }
  return [...targetIds].sort();
}

export async function loadRepoLocalCoreIconBenchmarkTargetIds(): Promise<readonly string[]> {
  if (!existsSync(REPO_GOLD_CATALOG_PATH)) {
    return [];
  }

  const content = await fs.readFile(REPO_GOLD_CATALOG_PATH, 'utf8');
  const repoEntityIds = new Set<string>();
  for (const [index, line] of content.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parsed = RepoGoldCatalogRowSchema.safeParse(JSON.parse(trimmed) as unknown);
    if (!parsed.success) {
      throw new Error(
        `Repo gold catalog schema validation failed at ${REPO_GOLD_CATALOG_PATH}:${index + 1}: ${parsed.error.message}`,
      );
    }
    repoEntityIds.add(parsed.data.entityId);
  }

  return collectCoreIconRequiredBenchmarkTargetIds()
    .filter((entityId) => repoEntityIds.has(entityId));
}

async function loadRequiredBenchmarkTargetIds(
  explicitFixtureRepoRoot: string | undefined,
): Promise<readonly string[]> {
  const required = new Set<string>();

  if (explicitFixtureRepoRoot == null || explicitFixtureRepoRoot.length === 0) {
    for (const entityId of await loadRepoLocalCoreIconBenchmarkTargetIds()) {
      required.add(entityId);
    }
  }

  const fixtureRepoRoot = resolveFixtureRepoRoot(explicitFixtureRepoRoot);
  if (fixtureRepoRoot == null) {
    return [...required].sort();
  }

  try {
    for (const entityId of await loadRequiredFixtureTargetIds(fixtureRepoRoot)) {
      required.add(entityId);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  return [...required].sort();
}

async function loadRepoLocalCoreIconBenchmarkIdentitySignaturesByTargetId(): Promise<ReadonlyMap<string, string>> {
  if (!existsSync(REPO_GOLD_CATALOG_PATH)) {
    return new Map();
  }

  const content = await fs.readFile(REPO_GOLD_CATALOG_PATH, 'utf8');
  const rows = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const parsed = RepoGoldCatalogRowSchema.safeParse(JSON.parse(line) as unknown);
      if (!parsed.success) {
        throw new Error(
          `Repo gold catalog schema validation failed at ${REPO_GOLD_CATALOG_PATH}:${index + 1}: ${parsed.error.message}`,
        );
      }
      return parsed.data;
    });

  const identitySafeQueriesByEntityId = collectCoreIconIdentitySafeQueriesByEntityId();
  const recallOnlyQueriesByEntityId = collectCoreIconRecallOnlyQueriesByEntityId();
  const suitabilityArtifact = await loadBenchmarkAnchorSuitabilityArtifact();
  const signatures = new Map<string, string>();

  for (const entry of rows) {
    const caseQueries = identitySafeQueriesByEntityId.get(entry.entityId) ?? [];
    const recallOnlyQueries = recallOnlyQueriesByEntityId.get(entry.entityId) ?? [];
    const identitySafeProjection = uniqueSurfaceList([
      entry.canonicalLabel,
      ...entry.koreanAliases,
      ...caseQueries,
    ]).filter(isIdentitySafeCoreIconSurface);
    const noisyRecallProjection = uniqueSurfaceList([
      ...entry.koreanAliases,
      ...caseQueries,
      ...recallOnlyQueries,
    ]);

    const record = attachBenchmarkAnchorSuitability({
      sourceId: `benchmark-anchor-${entry.entityId}` as SourceRecordId,
      externalId: entry.entityId,
      canonicalLabel: entry.canonicalLabel,
      producer: entry.producer,
      vintageYear: entry.vintageYear,
      country: entry.country,
      region: entry.region,
      appellation: entry.appellation ?? null,
      wineType: entry.wineType,
      grapePrimary: entry.grapes[0] ?? null,
      grapes: entry.grapes,
      body: normalizeSensoryNullable(entry.body),
      sweetness: inferBenchmarkAnchorSweetness(entry.wineType),
      acidity: normalizeSensoryNullable(entry.acidity),
      tannin: normalizeSensoryNullable(entry.tannin),
      pairingTags: [],
      flavorProfiles: [],
      searchTextEn: buildBenchmarkAnchorSearchTextEn(entry),
      ratingAvg: Number((entry.criticScore / 20).toFixed(2)),
      ratingsCount: 1_000,
      priceUsd: entry.priceUsd,
      priceBand: deriveBenchmarkAnchorPriceBand(entry.priceUsd),
      popularityScore: Number(Math.max(0.75, entry.criticScore / 100).toFixed(3)),
      scrapedAt: BENCHMARK_ANCHOR_FIXTURE_SCRAPED_AT,
      alcoholPct: null,
      producerPrestige: Number((entry.criticScore / 100).toFixed(3)),
      isTopRated: entry.criticScore >= 97,
      benchmarkAnchorEntityId: entry.entityId as CanonicalEntityId,
      sourceSystemOverride: SOURCE_SYSTEM_BENCHMARK_ANCHOR_CATALOG,
      aliases: {
        proposed: identitySafeProjection
          .filter((value) => value !== entry.canonicalLabel)
          .map((value) => ({
            value,
            type: 'translation' as const,
            source: 'benchmark-anchor:repo_gold_core_icon_v1',
            confidencePrior: 0.95,
            needsReview: false,
          })),
        identitySafeProjection,
        noisyRecallProjection,
      },
    }, suitabilityArtifact);

    const resolved = resolveWineSnapshotEntity(record, new Map(), new Map());
    signatures.set(entry.entityId, resolved.identitySignature);
  }

  return signatures;
}

async function loadRepoLocalCoreIconEquivalentPublicIdsByTargetId(
  explicitFixtureRepoRoot: string | undefined,
): Promise<ReadonlyMap<string, CanonicalEntityId>> {
  const fixtureRepoRoot = resolveFixtureRepoRoot(explicitFixtureRepoRoot);
  if (fixtureRepoRoot == null || !existsSync(REPO_GOLD_CATALOG_PATH)) {
    return new Map();
  }

  const [content, fixtureGoldLookup] = await Promise.all([
    fs.readFile(REPO_GOLD_CATALOG_PATH, 'utf8'),
    loadGoldCanonicalLookupForBuild({ fixtureRepoRoot: explicitFixtureRepoRoot }),
  ]);
  const equivalentPublicIds = new Map<string, CanonicalEntityId>();

  for (const [index, line] of content.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parsed = RepoGoldCatalogRowSchema.safeParse(JSON.parse(trimmed) as unknown);
    if (!parsed.success) {
      throw new Error(
        `Repo gold catalog schema validation failed at ${REPO_GOLD_CATALOG_PATH}:${index + 1}: ${parsed.error.message}`,
      );
    }
    const key = `${normalizeCanonicalLabelForIdentity(parsed.data.canonicalLabel)}|${parsed.data.vintageYear}`;
    const equivalentPublicId = fixtureGoldLookup.get(key);
    if (equivalentPublicId !== undefined && equivalentPublicId !== parsed.data.entityId) {
      equivalentPublicIds.set(parsed.data.entityId, equivalentPublicId as CanonicalEntityId);
    }
  }

  return equivalentPublicIds;
}

async function loadActiveBenchmarkCarryForwardRecords(args: {
  readonly currentRecords: readonly SnapshotBuildRecord[];
  readonly fixtureRepoRoot?: string | undefined;
  readonly runtimeStatePath?: string | undefined;
}): Promise<readonly SnapshotBuildRecord[]> {
  const runtimeStatePath = args.runtimeStatePath ?? DEFAULT_RUNTIME_STATE_PATH;
  if (!existsSync(runtimeStatePath)) {
    return [];
  }

  const requiredTargetIds = await loadRequiredBenchmarkTargetIds(args.fixtureRepoRoot);
  if (requiredTargetIds.length === 0) {
    return [];
  }

  const runtimeStateRaw = await fs.readFile(runtimeStatePath, 'utf8');
  const runtimeState = JSON.parse(runtimeStateRaw) as { manifestPath?: unknown };
  if (typeof runtimeState.manifestPath !== 'string' || runtimeState.manifestPath.length === 0) {
    return [];
  }
  if (!existsSync(runtimeState.manifestPath)) {
    return [];
  }

  const manifestRaw = await fs.readFile(runtimeState.manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw) as {
    artifacts?: { documentsNdjson?: unknown; entitiesNdjson?: unknown };
  };
  const documentsPath = manifest.artifacts?.documentsNdjson;
  const entitiesPath = manifest.artifacts?.entitiesNdjson;
  if (
    typeof documentsPath !== 'string' || documentsPath.length === 0 || !existsSync(documentsPath)
    || typeof entitiesPath !== 'string' || entitiesPath.length === 0 || !existsSync(entitiesPath)
  ) {
    return [];
  }

  const [documentsRaw, entitiesRaw] = await Promise.all([
    fs.readFile(documentsPath, 'utf8'),
    fs.readFile(entitiesPath, 'utf8'),
  ]);
  const previousRecords = parseNdjson<EnrichedSilverRecord>(documentsRaw, documentsPath).records;
  const previousEntities = parseNdjson<EntitySnapshotRecord>(entitiesRaw, entitiesPath).records;
  const previousRecordBySourceId = new Map(previousRecords.map((record) => [record.sourceId, record] as const));
  const currentSourceIds = new Set(args.currentRecords.map((record) => record.sourceId));
  const requiredSet = new Set(requiredTargetIds);
  const carryForward = new Map<SourceRecordId, SnapshotBuildRecord>();

  for (const entity of previousEntities) {
    const metadata = entity.metadata as {
      benchmarkEntityId?: unknown;
      sourceRecordRefs?: readonly { sourceSystem?: string; sourceRecordId?: string }[];
    };
    const benchmarkEntityId =
      typeof metadata.benchmarkEntityId === 'string' ? metadata.benchmarkEntityId : undefined;
    if (!requiredSet.has(entity.entityId) && (benchmarkEntityId == null || !requiredSet.has(benchmarkEntityId))) {
      continue;
    }
    const refs = Array.isArray(metadata.sourceRecordRefs) ? metadata.sourceRecordRefs : [];
    for (const ref of refs) {
      if (ref?.sourceSystem !== SOURCE_SYSTEM_VIVINO_SILVER || typeof ref.sourceRecordId !== 'string') {
        continue;
      }
      if (currentSourceIds.has(ref.sourceRecordId as SourceRecordId)) {
        continue;
      }
      const record = previousRecordBySourceId.get(ref.sourceRecordId as SourceRecordId);
      if (record !== undefined) {
        carryForward.set(record.sourceId, record);
      }
    }
  }

  return [...carryForward.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

async function assertRequiredBenchmarkCoverage(args: {
  readonly fixtureRepoRoot?: string | undefined;
  readonly entities: readonly EntitySnapshotRecord[];
}): Promise<void> {
  const missing = await findMissingRequiredBenchmarkCoverage(args);
  if (missing.length > 0) {
    throw new Error(
      `Search snapshot build is missing required benchmark anchor coverage: ${missing.join(', ')}`,
    );
  }
}

async function findMissingRequiredBenchmarkCoverage(args: {
  readonly fixtureRepoRoot?: string | undefined;
  readonly entities: readonly EntitySnapshotRecord[];
}): Promise<readonly string[]> {
  const requiredTargetIds = await loadRequiredBenchmarkTargetIds(args.fixtureRepoRoot);
  if (requiredTargetIds.length === 0) {
    return [];
  }

  const covered = new Set<string>();
  const existingIdentitySignatures = new Set<string>(args.entities.map((entity) => entity.identitySignature));
  const equivalentPublicIdsByTargetId =
    args.fixtureRepoRoot == null || args.fixtureRepoRoot.length === 0
      ? await loadRepoLocalCoreIconEquivalentPublicIdsByTargetId(args.fixtureRepoRoot)
      : new Map<string, CanonicalEntityId>();
  const repoLocalIdentitySignaturesByTargetId =
    args.fixtureRepoRoot == null || args.fixtureRepoRoot.length === 0
      ? await loadRepoLocalCoreIconBenchmarkIdentitySignaturesByTargetId()
      : new Map<string, string>();
  for (const entity of args.entities) {
    if (requiredTargetIds.includes(entity.entityId)) {
      covered.add(entity.entityId);
    }
    const benchmarkEntityId = (entity.metadata as { benchmarkEntityId?: unknown }).benchmarkEntityId;
    if (typeof benchmarkEntityId === 'string' && requiredTargetIds.includes(benchmarkEntityId)) {
      covered.add(benchmarkEntityId);
    }
  }

  for (const [targetId, identitySignature] of repoLocalIdentitySignaturesByTargetId) {
    if (requiredTargetIds.includes(targetId) && existingIdentitySignatures.has(identitySignature)) {
      covered.add(targetId);
    }
  }
  for (const [targetId, equivalentPublicId] of equivalentPublicIdsByTargetId) {
    if (requiredTargetIds.includes(targetId) && covered.has(equivalentPublicId)) {
      covered.add(targetId);
    }
  }

  const missing = requiredTargetIds.filter((targetId) => !covered.has(targetId));
  return missing;
}

const BENCHMARK_ANCHOR_FIXTURE_SCRAPED_AT = '2026-06-04T00:00:00.000Z';

function uniqueSurfaceList(values: readonly string[]): readonly string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      deduped.add(trimmed);
    }
  }
  return [...deduped];
}

function normalizeCoreIconSurfaceKey(value: string): string {
  return value.normalize('NFC').trim().toLowerCase();
}

const CORE_KOREAN_ICON_AMBIGUOUS_SURFACES = new Set(
  CORE_KOREAN_ICON_AMBIGUITY_CASES.map((testCase) => normalizeCoreIconSurfaceKey(testCase.query)),
);

function isIdentitySafeCoreIconSurface(value: string): boolean {
  return !CORE_KOREAN_ICON_AMBIGUOUS_SURFACES.has(normalizeCoreIconSurfaceKey(value));
}

function collectCoreIconIdentitySafeQueriesByEntityId(): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>();
  for (const testCase of CORE_KOREAN_ICON_QUERY_CASES) {
    if (testCase.identitySafe === false) {
      continue;
    }
    const existing = grouped.get(testCase.expectedEntityId) ?? [];
    if (!existing.includes(testCase.query)) {
      existing.push(testCase.query);
    }
    grouped.set(testCase.expectedEntityId, existing);
  }
  for (const testCase of CORE_KOREAN_ICON_RELEASE_GATE_CASES) {
    if (testCase.identitySafe === false) {
      continue;
    }
    const existing = grouped.get(testCase.expectedEntityId) ?? [];
    if (!existing.includes(testCase.query)) {
      existing.push(testCase.query);
    }
    grouped.set(testCase.expectedEntityId, existing);
  }
  return grouped;
}

function collectCoreIconRecallOnlyQueriesByEntityId(): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>();
  for (const testCase of CORE_KOREAN_ICON_AMBIGUITY_CASES) {
    if (testCase.expectedCandidateEntityId === undefined) {
      continue;
    }
    const existing = grouped.get(testCase.expectedCandidateEntityId) ?? [];
    if (!existing.includes(testCase.query)) {
      existing.push(testCase.query);
    }
    grouped.set(testCase.expectedCandidateEntityId, existing);
  }
  for (const testCase of CORE_KOREAN_ICON_RELEASE_GATE_CASES) {
    if (testCase.identitySafe !== false) {
      continue;
    }
    const existing = grouped.get(testCase.expectedEntityId) ?? [];
    if (!existing.includes(testCase.query)) {
      existing.push(testCase.query);
    }
    grouped.set(testCase.expectedEntityId, existing);
  }
  return grouped;
}

function normalizeSensoryNullable(value: number | null): number | null {
  return value === null ? null : Number((value / 5).toFixed(3));
}

function inferBenchmarkAnchorSweetness(wineType: RepoGoldCatalogRow['wineType']): number {
  switch (wineType) {
    case 'dessert':
      return 0.95;
    case 'sparkling':
      return 0.2;
    default:
      return 0.1;
  }
}

function deriveBenchmarkAnchorPriceBand(priceUsd: number): PriceBand {
  if (priceUsd < 30) return 'value';
  if (priceUsd < 100) return 'mid';
  if (priceUsd < 300) return 'premium';
  return 'luxury';
}

function buildBenchmarkAnchorSearchTextEn(entry: RepoGoldCatalogRow): string {
  return [
    entry.canonicalLabel,
    entry.producer,
    entry.country,
    entry.region,
    ...(entry.appellation !== undefined ? [entry.appellation] : []),
    ...entry.grapes,
    entry.style,
  ].join(' ');
}

export async function loadRepoLocalGoldBenchmarkAnchorRecords(
  missingTargetIds: readonly string[],
): Promise<readonly SnapshotBuildRecord[]> {
  if (missingTargetIds.length === 0 || !existsSync(REPO_GOLD_CATALOG_PATH)) {
    return [];
  }

  const content = await fs.readFile(REPO_GOLD_CATALOG_PATH, 'utf8');
  const rows = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const parsed = RepoGoldCatalogRowSchema.safeParse(JSON.parse(line) as unknown);
      if (!parsed.success) {
        throw new Error(
          `Repo gold catalog schema validation failed at ${REPO_GOLD_CATALOG_PATH}:${index + 1}: ${parsed.error.message}`,
        );
      }
      return parsed.data;
    });

  const rowByEntityId = new Map(rows.map((row) => [row.entityId, row] as const));
  const identitySafeQueriesByEntityId = collectCoreIconIdentitySafeQueriesByEntityId();
  const recallOnlyQueriesByEntityId = collectCoreIconRecallOnlyQueriesByEntityId();
  const suitabilityArtifact = await loadBenchmarkAnchorSuitabilityArtifact();
  const records: SnapshotBuildRecord[] = [];

  for (const entityId of missingTargetIds) {
    const entry = rowByEntityId.get(entityId);
    if (entry === undefined) {
      continue;
    }

    const caseQueries = identitySafeQueriesByEntityId.get(entityId) ?? [];
    const recallOnlyQueries = recallOnlyQueriesByEntityId.get(entityId) ?? [];
    const identitySafeProjection = uniqueSurfaceList([
      entry.canonicalLabel,
      ...entry.koreanAliases,
      ...caseQueries,
    ]).filter(isIdentitySafeCoreIconSurface);
    const noisyRecallProjection = uniqueSurfaceList([
      ...entry.koreanAliases,
      ...caseQueries,
      ...recallOnlyQueries,
    ]);

    records.push(attachBenchmarkAnchorSuitability({
      sourceId: `benchmark-anchor-${entry.entityId}` as SourceRecordId,
      externalId: entry.entityId,
      canonicalLabel: entry.canonicalLabel,
      producer: entry.producer,
      vintageYear: entry.vintageYear,
      country: entry.country,
      region: entry.region,
      appellation: entry.appellation ?? null,
      wineType: entry.wineType,
      grapePrimary: entry.grapes[0] ?? null,
      grapes: entry.grapes,
      body: normalizeSensoryNullable(entry.body),
      sweetness: inferBenchmarkAnchorSweetness(entry.wineType),
      acidity: normalizeSensoryNullable(entry.acidity),
      tannin: normalizeSensoryNullable(entry.tannin),
      pairingTags: [],
      flavorProfiles: [],
      searchTextEn: buildBenchmarkAnchorSearchTextEn(entry),
      ratingAvg: Number((entry.criticScore / 20).toFixed(2)),
      ratingsCount: 1_000,
      priceUsd: entry.priceUsd,
      priceBand: deriveBenchmarkAnchorPriceBand(entry.priceUsd),
      popularityScore: Number(Math.max(0.75, entry.criticScore / 100).toFixed(3)),
      scrapedAt: BENCHMARK_ANCHOR_FIXTURE_SCRAPED_AT,
      alcoholPct: null,
      producerPrestige: Number((entry.criticScore / 100).toFixed(3)),
      isTopRated: entry.criticScore >= 97,
      benchmarkAnchorEntityId: entry.entityId as CanonicalEntityId,
      sourceSystemOverride: SOURCE_SYSTEM_BENCHMARK_ANCHOR_CATALOG,
      aliases: {
        proposed: identitySafeProjection
          .filter((value) => value !== entry.canonicalLabel)
          .map((value) => ({
            value,
            type: 'translation' as const,
            source: 'benchmark-anchor:repo_gold_core_icon_v1',
            confidencePrior: 0.95,
            needsReview: false,
          })),
        identitySafeProjection,
        noisyRecallProjection,
      },
    }, suitabilityArtifact));
  }

  return records.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

async function loadBenchmarkAnchorCatalogRecords(missingTargetIds: readonly string[]): Promise<readonly SnapshotBuildRecord[]> {
  if (missingTargetIds.length === 0) {
    return [];
  }

  const { WINES } = await import('../seed-wines-real.js');
  const suitabilityArtifact = await loadBenchmarkAnchorSuitabilityArtifact();
  const requiredSet = new Set(missingTargetIds);
  const records: SnapshotBuildRecord[] = [];

  for (const doc of WINES) {
    if (!requiredSet.has(doc.entityId)) {
      continue;
    }

    const identitySafeAliases = doc.aliasesIdentitySafe ?? [];
    const noisyRecallAliases = doc.aliasesNoisyRecall ?? [];
    const proposedAliases = [
      ...identitySafeAliases.map((value) => ({
        value,
        type: 'translation' as const,
        source: 'benchmark-anchor:identity_safe_v1',
        confidencePrior: 0.95,
        needsReview: false,
      })),
      ...noisyRecallAliases.map((value) => ({
        value,
        type: hasHangul(value) ? 'phonetic' as const : 'catalog_noise_alias' as const,
        source: 'benchmark-anchor:noisy_recall_v1',
        confidencePrior: hasHangul(value) ? 0.82 : 0.68,
        needsReview: false,
      })),
    ];

    records.push(attachBenchmarkAnchorSuitability({
      sourceId: `benchmark-anchor-${doc.entityId}` as SourceRecordId,
      externalId: doc.entityId,
      canonicalLabel: doc.canonicalLabel,
      producer: doc.producer ?? doc.canonicalLabel,
      vintageYear: doc.vintageYear ?? null,
      country: doc.country ?? '',
      region: doc.region ?? '',
      appellation: doc.appellation ?? null,
      wineType: toRequiredSilverWineType(doc.wineType, doc.entityId),
      grapePrimary: doc.grapePrimary ?? null,
      grapes: doc.grapes ?? [],
      body: doc.body ?? null,
      sweetness: doc.sweetness ?? null,
      acidity: doc.acidity ?? null,
      tannin: doc.tannin ?? null,
      pairingTags: doc.pairing ?? [],
      ...(doc.occasion !== undefined ? { occasion: doc.occasion } : {}),
      flavorProfiles: doc.flavorProfiles ?? [],
      searchTextEn: doc.searchTextEn ?? doc.semanticSummary ?? doc.canonicalLabel,
      ratingAvg: null,
      ratingsCount: 0,
      priceUsd: doc.priceUsd ?? null,
      ...(toOptionalSilverPriceBand(doc.priceBand, doc.entityId) !== undefined
        ? { priceBand: toOptionalSilverPriceBand(doc.priceBand, doc.entityId) }
        : {}),
      popularityScore: doc.popularityScore ?? 0,
      scrapedAt: null,
      alcoholPct: doc.alcoholPct ?? null,
      ...(doc.bottleSizeMl !== undefined ? { bottleSizeMl: doc.bottleSizeMl } : {}),
      ...(doc.bottleSize !== undefined ? { bottleSize: doc.bottleSize } : {}),
      ...(doc.closure !== undefined ? { closure: doc.closure } : {}),
      producerPrestige: doc.producerPrestige ?? null,
      isTopRated: readSeedIsTopRated(doc, doc.entityId),
      ...(doc.grapeFamily !== undefined ? { grapeFamily: doc.grapeFamily } : {}),
      ...(doc.regionHierarchy !== undefined ? { regionHierarchy: doc.regionHierarchy } : {}),
      ...(doc.finishLength !== undefined ? { finishLength: doc.finishLength } : {}),
      ...(doc.classification !== undefined ? { classification: doc.classification } : {}),
      ...(doc.oakTreatment !== undefined ? { oakTreatment: doc.oakTreatment } : {}),
      ...(doc.soilType !== undefined ? { soilType: doc.soilType } : {}),
      ...(doc.producerType !== undefined ? { producerType: doc.producerType } : {}),
      benchmarkAnchorEntityId: doc.entityId,
      sourceSystemOverride: SOURCE_SYSTEM_BENCHMARK_ANCHOR_CATALOG,
      aliases: {
        proposed: proposedAliases,
        identitySafeProjection: identitySafeAliases,
        noisyRecallProjection: noisyRecallAliases,
      },
    }, suitabilityArtifact));
  }

  const covered = new Set(
    records
      .map((record) => record.benchmarkAnchorEntityId)
      .filter((id): id is CanonicalEntityId => id !== undefined),
  );
  const coveredIdentitySignatures = new Set(
    records.map((record) => resolveWineSnapshotEntity(record, new Map(), new Map()).identitySignature),
  );
  const repoLocalIdentitySignaturesByTargetId = await loadRepoLocalCoreIconBenchmarkIdentitySignaturesByTargetId();
  const equivalentPublicIdsByTargetId = await loadRepoLocalCoreIconEquivalentPublicIdsByTargetId(undefined);
  for (const [targetId, equivalentPublicId] of equivalentPublicIdsByTargetId) {
    if (covered.has(equivalentPublicId)) {
      covered.add(targetId as CanonicalEntityId);
    }
  }
  for (const [targetId, identitySignature] of repoLocalIdentitySignaturesByTargetId) {
    if (coveredIdentitySignatures.has(identitySignature)) {
      covered.add(targetId as CanonicalEntityId);
    }
  }
  const unresolved = missingTargetIds.filter((entityId) => !covered.has(entityId as CanonicalEntityId));
  if (unresolved.length > 0) {
    records.push(...await loadRepoLocalGoldBenchmarkAnchorRecords(unresolved));
  }

  return records
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
    .filter((record, index, all) => all.findIndex((candidate) => candidate.sourceId === record.sourceId) === index);
}

export function filterIdentityConflictingBenchmarkAnchorRecords(args: {
  readonly existingEntities: readonly EntitySnapshotRecord[];
  readonly candidateRecords: readonly SnapshotBuildRecord[];
  readonly goldLookup: ReadonlyMap<string, string>;
  readonly sourceContinuityLookup: ReadonlyMap<SourceRecordId, {
    readonly entityId: CanonicalEntityId;
    readonly identitySignature: string;
    readonly benchmarkEntityId?: CanonicalEntityId;
  }>;
}): readonly SnapshotBuildRecord[] {
  const existingEntityIdByIdentitySignature = new Map<string, CanonicalEntityId>(
    args.existingEntities.map((entity) => [entity.identitySignature, entity.entityId as CanonicalEntityId]),
  );

  return args.candidateRecords.filter((record) => {
    if (record.benchmarkAnchorEntityId === undefined) {
      return true;
    }
    const resolved = resolveWineSnapshotEntity(
      record,
      args.goldLookup,
      args.sourceContinuityLookup,
    );
    const existingEntityId = existingEntityIdByIdentitySignature.get(resolved.identitySignature);
    return existingEntityId === undefined || existingEntityId === record.benchmarkAnchorEntityId;
  });
}

function resolveSourceSystemForRecord(record: EnrichedSilverRecord): string {
  return (record as SnapshotBuildRecord).sourceSystemOverride
    ?? (record.sourceId.startsWith('benchmark-anchor-')
      ? SOURCE_SYSTEM_BENCHMARK_ANCHOR_CATALOG
      : SOURCE_SYSTEM_VIVINO_SILVER);
}

function stripExperimentalSnapshotFields(record: SnapshotBuildRecord): SnapshotBuildRecord {
  const { certificationsExperimental: _certificationsExperimental, ...canonical } = record;
  void _certificationsExperimental;
  return canonical;
}

function toRequiredSilverWineType(value: string | undefined, entityId: string): WineType {
  if (value !== undefined && (SILVER_WINE_TYPES as readonly string[]).includes(value)) {
    return value as WineType;
  }
  throw new Error(`benchmark anchor ${entityId} has invalid wineType=${JSON.stringify(value)}`);
}

function toOptionalSilverPriceBand(value: string | undefined, entityId: string): PriceBand | undefined {
  if (value === undefined) {
    return undefined;
  }
  if ((SILVER_PRICE_BANDS as readonly string[]).includes(value)) {
    return value as PriceBand;
  }
  throw new Error(`benchmark anchor ${entityId} has invalid priceBand=${JSON.stringify(value)}`);
}

function readSeedIsTopRated(doc: object, entityId: string): boolean {
  const value = (doc as { readonly isTopRated?: unknown }).isTopRated;
  if (value === undefined) {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  throw new Error(`benchmark anchor ${entityId} has invalid isTopRated=${JSON.stringify(value)}`);
}

export function buildGiftSuitabilityContentHash(record: EnrichedSilverRecord): string {
  return crypto.createHash('sha256').update([
    record.canonicalLabel,
    record.producer,
    record.country,
    record.region,
    record.wineType,
    record.priceBand ?? '',
    record.searchTextEn,
    record.pairingTags.join('|'),
    record.flavorProfiles.join('|'),
    record.classification ?? '',
    String(record.producerPrestige ?? ''),
    String(record.alcoholPct ?? ''),
    (record.occasion ?? []).join('|'),
  ].join('\n')).digest('hex');
}

export function buildBeginnerSuitabilityContentHash(record: EnrichedSilverRecord): string {
  return crypto.createHash('sha256').update([
    record.canonicalLabel,
    record.producer,
    record.wineType,
    record.priceBand ?? '',
    String(record.body ?? ''),
    String(record.sweetness ?? ''),
    String(record.acidity ?? ''),
    String(record.tannin ?? ''),
    String(record.alcoholPct ?? ''),
    record.grapePrimary ?? '',
    record.flavorProfiles.join('|'),
    record.searchTextEn,
  ].join('\n')).digest('hex');
}

export function attachBenchmarkAnchorSuitability(
  record: SnapshotBuildRecord,
  artifact: BenchmarkAnchorSuitabilityArtifact,
): SnapshotBuildRecord {
  if (record.benchmarkAnchorEntityId === undefined) {
    return record;
  }
  const seed = artifact.entities[record.benchmarkAnchorEntityId];
  if (seed === undefined) {
    return record;
  }
  return {
    ...record,
    giftSuitabilityClassification: {
      score: seed.gift.score,
      fingerprint: {
        modelId: artifact.model,
        contentHash: buildGiftSuitabilityContentHash(record),
        version: GIFT_SUITABILITY_VERSION,
        generatedAt: artifact.generatedAt,
      },
      provenance: {
        source: 'llm_gift_suitability_scorer',
        promptVersion: artifact.promptVersions.gift,
        evidenceAxes: seed.gift.evidenceAxes,
        snippet: seed.gift.snippet,
        rationale: seed.gift.rationale,
      },
    },
    beginnerSuitabilityClassification: {
      score: seed.beginner.score,
      fingerprint: {
        modelId: artifact.model,
        contentHash: buildBeginnerSuitabilityContentHash(record),
        version: BEGINNER_SUITABILITY_VERSION,
        generatedAt: artifact.generatedAt,
      },
      provenance: {
        source: 'llm_beginner_suitability_scorer',
        promptVersion: artifact.promptVersions.beginner,
        evidenceAxes: seed.beginner.evidenceAxes,
        snippet: seed.beginner.snippet,
        rationale: seed.beginner.rationale,
      },
    },
  };
}

async function buildArtifactsForRecords(args: {
  readonly records: readonly SnapshotBuildRecord[];
  readonly goldLookup: ReadonlyMap<string, string>;
  readonly sourceContinuityLookup: ReadonlyMap<SourceRecordId, {
    readonly entityId: CanonicalEntityId;
    readonly identitySignature: string;
    readonly benchmarkEntityId?: CanonicalEntityId;
  }>;
}): Promise<{
  readonly entityArtifact: readonly EntitySnapshotRecord[];
  readonly resolvedAliases: ReturnType<typeof resolveAliasClaimsAndBuildAmbiguityRegistry>['resolvedAliases'];
  readonly ambiguityRows: ReturnType<typeof resolveAliasClaimsAndBuildAmbiguityRegistry>['ambiguityRows'];
  readonly entityIdBySourceId: ReadonlyMap<SourceRecordId, CanonicalEntityId>;
}> {
  const entityArtifact: EntitySnapshotRecord[] = [];
  const entityIdBySourceId = new Map<SourceRecordId, CanonicalEntityId>();

  for (const record of args.records) {
    const resolved = resolveWineSnapshotEntity(record, args.goldLookup, args.sourceContinuityLookup);
    const runtimeEntityId = record.benchmarkAnchorEntityId ?? resolved.entityId;
    const benchmarkEntityId = record.benchmarkAnchorEntityId ?? resolved.benchmarkEntityId;
    const occasion = record.occasionClassification?.values ?? record.occasion;
    entityArtifact.push({
      entityId: runtimeEntityId,
      entityType: 'wine',
      canonicalLabel: record.canonicalLabel,
      identitySignature: resolved.identitySignature,
      relations: {},
      attributes: {
        ...(record.grapePrimary != null ? { grapePrimary: record.grapePrimary } : {}),
        grapes: record.grapes,
        wineType: record.wineType,
        style: record.wineType,
        ...(record.body != null ? { body: record.body } : {}),
        ...(record.sweetness != null ? { sweetness: record.sweetness } : {}),
        ...(record.acidity != null ? { acidity: record.acidity } : {}),
        ...(record.tannin != null ? { tannin: record.tannin } : {}),
        region: record.region,
        priceBand: record.priceBand,
        giftSuitabilityScore: record.giftSuitabilityClassification?.score,
        beginnerSuitabilityScore: record.beginnerSuitabilityClassification?.score,
        ...(record.vintageYear != null ? { vintage: record.vintageYear } : {}),
        pairing: record.pairingTags,
        ...(occasion !== undefined && occasion.length > 0
          ? { occasion: [...occasion] }
          : {}),
      },
      metadata: {
        source: 'snapshot:silver_trackc_v1',
        trustTier: 'high',
        externalId: record.externalId,
        producer: record.producer,
        country: record.country,
        region: record.region,
        ...(record.appellation != null ? { appellation: record.appellation } : {}),
        identityResolution: resolved.resolution,
        ...(benchmarkEntityId != null ? { benchmarkEntityId } : {}),
        sourceRecordRefs: [
          { sourceSystem: resolveSourceSystemForRecord(record), sourceRecordId: record.sourceId },
        ],
      },
    } as const);
    entityIdBySourceId.set(record.sourceId, runtimeEntityId);
  }
  entityArtifact.sort((left, right) => left.entityId.localeCompare(right.entityId));
  const approvedAbbreviationOverlay = await loadApprovedAbbreviationAliasOverlay(
    [...entityIdBySourceId.values()],
  );
  const baseAliasArtifact = buildAliasArtifact(
    args.records,
    entityIdBySourceId,
    approvedAbbreviationOverlay,
  );
  const aliasArtifact = buildAliasArtifact(
    args.records,
    entityIdBySourceId,
    approvedAbbreviationOverlay,
  );
  const { resolvedAliases, ambiguityRows } = resolveAliasClaimsAndBuildAmbiguityRegistry(aliasArtifact);
  return { entityArtifact, resolvedAliases, ambiguityRows, entityIdBySourceId };
}

interface ApprovedAbbreviationAliasProposalRow {
  readonly surface_form: string;
  readonly target_entity_id: string;
  readonly proposed_type: string;
  readonly evidence: unknown;
  readonly confidence: number;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseApprovedAbbreviationAliasProposal(
  row: ApprovedAbbreviationAliasProposalRow,
): { readonly targetEntityId: CanonicalEntityId; readonly proposal: SnapshotAliasOverlayProposal } {
  const aliasType = parseAliasType(row.proposed_type);
  if (aliasType !== 'abbreviation') {
    throw new Error(`Unsupported approved alias proposal type=${JSON.stringify(row.proposed_type)}`);
  }
  if (typeof row.surface_form !== 'string' || row.surface_form.length === 0) {
    throw new Error(`Approved abbreviation proposal is missing surface_form for ${row.target_entity_id}`);
  }
  if (!Number.isFinite(row.confidence) || row.confidence <= 0) {
    throw new Error(`Approved abbreviation proposal has invalid confidence for ${row.target_entity_id}`);
  }
  if (!isRecordValue(row.evidence)) {
    throw new Error(`Approved abbreviation proposal evidence is malformed for ${row.target_entity_id}`);
  }

  const source = row.evidence['source'];
  const sourceTrust = row.evidence['sourceTrust'];
  const aliasScope = row.evidence['aliasScope'];
  if (
    typeof source !== 'string'
    || source.length === 0
    || typeof aliasScope !== 'string'
    || aliasScope.length === 0
    || typeof sourceTrust !== 'number'
    || !Number.isFinite(sourceTrust)
  ) {
    throw new Error(`Approved abbreviation proposal evidence is incomplete for ${row.target_entity_id}`);
  }

  return {
    targetEntityId: row.target_entity_id as CanonicalEntityId,
    proposal: {
      value: row.surface_form,
      type: aliasType,
      source,
      sourceTrust,
      confidencePrior: row.confidence,
      scope: aliasScope,
    },
  };
}

async function loadApprovedAbbreviationAliasOverlay(
  entityIds: readonly CanonicalEntityId[],
): Promise<ReadonlyMap<CanonicalEntityId, readonly SnapshotAliasOverlayProposal[]>> {
  const uniqueEntityIds = [...new Set(entityIds)];
  if (uniqueEntityIds.length === 0) {
    return new Map();
  }
  if (process.env['DATABASE_URL'] === undefined && process.env['PG_HOST'] === undefined) {
    return new Map();
  }

  const [{ loadConfig }, { createPgPool, shouldUsePgPool }] = await Promise.all([
    import('../../src/config/env.js'),
    import('../../src/infrastructure/db/pg-pool.js'),
  ]);
  const config = loadConfig();
  if (!shouldUsePgPool(config.pg)) {
    return new Map();
  }

  const pool = createPgPool(config.pg);
  try {
    const result = await pool.query<ApprovedAbbreviationAliasProposalRow>(
      `SELECT surface_form, target_entity_id, proposed_type, evidence, confidence
         FROM alias_proposals
        WHERE proposed_type = 'abbreviation'
          AND status IN ('approved', 'promoted')
          AND target_entity_id = ANY($1::text[])
        ORDER BY target_entity_id ASC, confidence DESC, proposal_id ASC`,
      [uniqueEntityIds],
    );

    const overlay = new Map<CanonicalEntityId, SnapshotAliasOverlayProposal[]>();
    for (const row of result.rows) {
      const parsed = parseApprovedAbbreviationAliasProposal(row);
      const existing = overlay.get(parsed.targetEntityId) ?? [];
      existing.push(parsed.proposal);
      overlay.set(parsed.targetEntityId, existing);
    }
    return overlay;
  } finally {
    await pool.end();
  }
}


export async function buildSearchSnapshot(args: Args): Promise<BuildSearchSnapshotResult> {
  assertCanonicalTrackCArtifactInput(args.input, 'build-search-snapshot');
  const [recordContent, nlMappingsRaw] = await Promise.all([
    fs.readFile(args.input, 'utf8'),
    fs.readFile(args.nlMappings, 'utf8'),
  ]);

  const parsed = parseNdjson<EnrichedSilverRecord>(recordContent, args.input);
  const baseRecords: SnapshotBuildRecord[] = [...parsed.records]
    .map((record) => stripExperimentalSnapshotFields(record as SnapshotBuildRecord))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  assertSuitabilityCoverage(baseRecords);
  const [goldLookup, sourceContinuityLookup, carryForwardRecords] = await Promise.all([
    loadGoldCanonicalLookupForBuild({ fixtureRepoRoot: args.fixtureRepoRoot }),
    loadActiveSourceEntityContinuity(args.runtimeStatePath, {
      sourceIds: baseRecords.map((record) => record.sourceId),
    }),
    loadActiveBenchmarkCarryForwardRecords({
      currentRecords: baseRecords,
      fixtureRepoRoot: args.fixtureRepoRoot,
      runtimeStatePath: args.runtimeStatePath,
    }),
  ]);
  const records = [...baseRecords, ...carryForwardRecords]
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  let finalRecords = records;
  let {
    entityArtifact,
    resolvedAliases,
    ambiguityRows,
    entityIdBySourceId,
  } = await buildArtifactsForRecords({
    records: finalRecords,
    goldLookup,
    sourceContinuityLookup,
  });
  const missingBenchmarkCoverage = await findMissingRequiredBenchmarkCoverage({
    fixtureRepoRoot: args.fixtureRepoRoot,
    entities: entityArtifact,
  });
  if (missingBenchmarkCoverage.length > 0) {
    const benchmarkAnchorRecords = filterIdentityConflictingBenchmarkAnchorRecords({
      existingEntities: entityArtifact,
      candidateRecords: await loadBenchmarkAnchorCatalogRecords(missingBenchmarkCoverage),
      goldLookup,
      sourceContinuityLookup,
    });
    finalRecords = [...finalRecords, ...benchmarkAnchorRecords]
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    ({
      entityArtifact,
      resolvedAliases,
      ambiguityRows,
      entityIdBySourceId,
    } = await buildArtifactsForRecords({
      records: finalRecords,
      goldLookup,
      sourceContinuityLookup,
    }));
  }
  await assertRequiredBenchmarkCoverage({
    fixtureRepoRoot: args.fixtureRepoRoot,
    entities: entityArtifact,
  });
  const nlMappings = parseNlMappings(nlMappingsRaw);

  const generatedAt = new Date().toISOString();
  const documentsNdjson = serializeNdjson(finalRecords);
  const entitiesNdjson = serializeNdjson(entityArtifact);
  const aliasesNdjson = serializeNdjson(resolvedAliases);
  const ambiguityNdjson = serializeNdjson(ambiguityRows);
  const nlMappingsCanonical = `${stableJsonStringify(nlMappings.payload)}\n`;
  const entityArtifactHash = hashStableJson(canonicalizeEntitySnapshotRecords(entityArtifact));
  const aliasArtifactHash = hashStableJson(canonicalizeAliasSnapshotRecords(resolvedAliases));
  const ambiguityArtifactHash = hashStableJson(canonicalizeAmbiguitySnapshotRows(ambiguityRows));
  const snapshotEntityIds = new Set<CanonicalEntityId>([...entityIdBySourceId.values()]);
  const lookupExactSafeRegistry = await loadLookupExactSafeRegistry();
  const lookupAmbiguityRegistry = await loadLookupAmbiguityRegistry();
  const lookupConceptRedirectRegistry = await loadLookupConceptRedirectRegistry();
  const lookupPolicyConflictRegistry = loadLookupPolicyConflictRegistrySync();
  const lookupPolicyFamilyDecisionRegistry = loadLookupV2PolicyFamilyDecisionRegistrySync();
  assertLookupExactSafeRegistryCompatibleWithBaseAliases({
    baseAliases: resolvedAliases,
    registryRows: lookupExactSafeRegistry,
  });
  assertLookupAuthorityBoundaryConsistency({
    exactSafeRows: lookupExactSafeRegistry,
    ambiguityRows: lookupAmbiguityRegistry,
    policyConflictRows: lookupPolicyConflictRegistry,
    policyFamilyDecisionRows: lookupPolicyFamilyDecisionRegistry,
  });
  const lookupRuntimeOverlayAliases = buildLookupRuntimeOverlayAliases(
    lookupExactSafeRegistry,
    snapshotEntityIds,
  );
  const lookupIdentityCertificatesByEntity = buildLookupIdentityCertificatesByEntity(
    lookupExactSafeRegistry,
    snapshotEntityIds,
  );

  const {
    coreArtifact: lookupAliasRuntimeArtifact,
    broadRecallArtifact: lookupAliasBroadRecallRuntimeArtifact,
  } = buildLookupAliasRuntimeArtifacts({
    snapshotId: '',
    generatedAt,
    aliasRegistryHash: aliasArtifactHash,
    aliases: resolvedAliases,
    runtimeOverlayAliases: lookupRuntimeOverlayAliases,
  });
  const lookupExactSafeRuntimeArtifact = buildLookupExactSafeRuntimeArtifact({
    snapshotId: '',
    generatedAt,
    rows: lookupExactSafeRegistry,
    snapshotEntityIds,
  });
  const lookupResolverProjectionArtifact = buildLookupResolverProjectionArtifact({
    snapshotId: '',
    generatedAt,
    records: finalRecords,
    entityIdBySourceId,
    goldCanonicalLookup: goldLookup,
    sourceContinuityLookup,
    identityCertificatesByEntity: lookupIdentityCertificatesByEntity,
  });
  const lookupReviewedFamilyCoreWitnessRegistry = loadLookupV2FamilyCoreWitnessRegistrySync();
  const lookupReviewedFamilyCollisionRegistry = loadLookupV2FamilyCollisionRegistrySync();
  const lookupLocalizedSurfaceRegistry = loadLookupV2LocalizedSurfaceRegistrySync();
  const reviewedFamilyCoreKeysByEntity = buildReviewedFamilyCoreKeysByEntity(
    lookupReviewedFamilyCoreWitnessRegistry,
  );
  const provisionalLookupEntityProjectionArtifact = buildLookupEntityProjectionArtifact({
    snapshotId: '',
    generatedAt,
    records: finalRecords,
    entityIdBySourceId,
    goldCanonicalLookup: goldLookup,
    sourceContinuityLookup,
    identityCertificatesByEntity: lookupIdentityCertificatesByEntity,
    reviewedFamilyCoreKeysByEntity,
  });
  const reviewedCollisionFamilyCoreKeysByEntity = buildReviewedCollisionFamilyCoreKeysByEntity({
    documents: provisionalLookupEntityProjectionArtifact.documents,
    reviewedCollisionRows: lookupReviewedFamilyCollisionRegistry,
    reviewedFamilyCoreWitnessRows: lookupReviewedFamilyCoreWitnessRegistry,
  });
  const mergedReviewedFamilyCoreKeysByEntity = new Map<CanonicalEntityId, readonly string[]>();
  for (const [entityId, surfaces] of reviewedFamilyCoreKeysByEntity.entries()) {
    mergedReviewedFamilyCoreKeysByEntity.set(entityId, surfaces);
  }
  for (const [entityId, surfaces] of reviewedCollisionFamilyCoreKeysByEntity.entries()) {
    const existing = mergedReviewedFamilyCoreKeysByEntity.get(entityId as CanonicalEntityId) ?? [];
    mergedReviewedFamilyCoreKeysByEntity.set(
      entityId as CanonicalEntityId,
      [...new Set([...existing, ...surfaces])].sort((left, right) => left.localeCompare(right)),
    );
  }
  const lookupEntityProjectionArtifact = buildLookupEntityProjectionArtifact({
    snapshotId: '',
    generatedAt,
    records: finalRecords,
    entityIdBySourceId,
    goldCanonicalLookup: goldLookup,
    sourceContinuityLookup,
    identityCertificatesByEntity: lookupIdentityCertificatesByEntity,
    reviewedFamilyCoreKeysByEntity: mergedReviewedFamilyCoreKeysByEntity,
  });
  const lookupSemanticRuntimeDescriptorMap = buildLookupV2RuntimeSemanticDescriptorMapFromDocuments(
    lookupEntityProjectionArtifact.documents,
  );
  const lookupSemanticScopeTargetRegistry = loadLookupV2SemanticScopeTargetRegistrySync(
    undefined,
    lookupSemanticRuntimeDescriptorMap,
  );
  const lookupSemanticScopeRuntimeArtifact = buildLookupSemanticScopeRuntimeArtifact({
    snapshotId: '',
    generatedAt,
    reviewedRows: lookupSemanticScopeTargetRegistry,
  });
  const lookupReviewedFamilyRecallRuntimeArtifact = buildLookupReviewedFamilyRecallRuntimeArtifact({
    snapshotId: '',
    generatedAt,
    entityProjectionDocuments: lookupEntityProjectionArtifact.documents,
    reviewedCollisionRows: lookupReviewedFamilyCollisionRegistry,
    reviewedFamilyCoreWitnessRows: lookupReviewedFamilyCoreWitnessRegistry,
    localizedSurfaceRegistryRows: lookupLocalizedSurfaceRegistry,
  });
  const lookupScopeGraphRuntimeArtifact = buildLookupScopeGraphRuntimeArtifact({
    snapshotId: '',
    generatedAt,
    entityProjectionDocuments: lookupEntityProjectionArtifact.documents,
  });
  const lookupAmbiguityRuntimeArtifact = buildLookupAmbiguityRuntimeArtifact({
    snapshotId: '',
    generatedAt,
    ambiguityRows,
    curatedEntries: buildLookupAmbiguityRegistryEntries(lookupAmbiguityRegistry),
  });
  const lookupConceptRedirectRuntimeArtifact = buildLookupConceptRedirectRuntimeArtifact({
    snapshotId: '',
    generatedAt,
    entries: buildLookupConceptRedirectRegistryEntries(lookupConceptRedirectRegistry),
  });

  const hashes = {
    documents: hashText(documentsNdjson),
    vespaFeed: hashText(''),
    entities: entityArtifactHash,
    aliases: aliasArtifactHash,
    lookupAliasRuntime: buildLookupAliasRuntimeCoreArtifactHash(lookupAliasRuntimeArtifact),
    lookupAliasBroadRecallRuntime: buildLookupAliasBroadRecallRuntimeArtifactHash(lookupAliasBroadRecallRuntimeArtifact),
    lookupExactSafeRuntime: buildLookupExactSafeRuntimeArtifactHash(lookupExactSafeRuntimeArtifact),
    lookupResolverProjection: buildLookupResolverProjectionArtifactHash(lookupResolverProjectionArtifact),
    lookupEntityProjection: buildLookupEntityProjectionArtifactHash(lookupEntityProjectionArtifact),
    lookupSemanticScopeRuntime: buildLookupSemanticScopeRuntimeArtifactHash(lookupSemanticScopeRuntimeArtifact),
    lookupReviewedFamilyRecallRuntime: buildLookupReviewedFamilyRecallRuntimeArtifactHash(lookupReviewedFamilyRecallRuntimeArtifact),
    lookupScopeGraphRuntime: buildLookupScopeGraphRuntimeArtifactHash(lookupScopeGraphRuntimeArtifact),
    lookupAmbiguityRuntime: buildLookupAmbiguityRuntimeArtifactHash(lookupAmbiguityRuntimeArtifact),
    lookupConceptRedirectRuntime: buildLookupConceptRedirectRuntimeArtifactHash(lookupConceptRedirectRuntimeArtifact),
    ambiguityRegistry: ambiguityArtifactHash,
    nlMappings: hashText(nlMappingsCanonical),
  } as const;

  const contentHash = buildSearchSnapshotContentHash(hashes);
  const snapshotId = buildSearchSnapshotId(contentHash);
  const snapshotRoot = path.join(args.outputDir, snapshotId);
  const finalizedLookupAliasRuntimeArtifact = {
    ...lookupAliasRuntimeArtifact,
    snapshotId,
    aliasRegistryHash: hashes.aliases,
  };
  const finalizedLookupAliasBroadRecallRuntimeArtifact = {
    ...lookupAliasBroadRecallRuntimeArtifact,
    snapshotId,
    aliasRegistryHash: hashes.aliases,
  };
  const finalizedLookupExactSafeRuntimeArtifact = {
    ...lookupExactSafeRuntimeArtifact,
    snapshotId,
  };
  const finalizedLookupResolverProjectionArtifact = {
    ...lookupResolverProjectionArtifact,
    snapshotId,
  };
  const finalizedLookupEntityProjectionArtifact = {
    ...lookupEntityProjectionArtifact,
    snapshotId,
  };
  const finalizedLookupSemanticScopeRuntimeArtifact = {
    ...lookupSemanticScopeRuntimeArtifact,
    snapshotId,
  };
  const finalizedLookupReviewedFamilyRecallRuntimeArtifact = {
    ...lookupReviewedFamilyRecallRuntimeArtifact,
    snapshotId,
  };
  const finalizedLookupScopeGraphRuntimeArtifact = {
    ...lookupScopeGraphRuntimeArtifact,
    snapshotId,
  };
  const finalizedLookupAmbiguityRuntimeArtifact = {
    ...lookupAmbiguityRuntimeArtifact,
    snapshotId,
  };
  const finalizedLookupConceptRedirectRuntimeArtifact = {
    ...lookupConceptRedirectRuntimeArtifact,
    snapshotId,
  };
  const lookupAliasRuntimeJson = `${stableJsonStringify(finalizedLookupAliasRuntimeArtifact)}\n`;
  const lookupAliasBroadRecallRuntimeJson = `${stableJsonStringify(finalizedLookupAliasBroadRecallRuntimeArtifact)}\n`;
  const lookupExactSafeRuntimeJson = `${stableJsonStringify(finalizedLookupExactSafeRuntimeArtifact)}\n`;
  const lookupResolverProjectionJson = `${stableJsonStringify(finalizedLookupResolverProjectionArtifact)}\n`;
  const lookupEntityProjectionJson = `${stableJsonStringify(finalizedLookupEntityProjectionArtifact)}\n`;
  const lookupSemanticScopeRuntimeJson = `${stableJsonStringify(finalizedLookupSemanticScopeRuntimeArtifact)}\n`;
  const lookupReviewedFamilyRecallRuntimeJson = `${stableJsonStringify(finalizedLookupReviewedFamilyRecallRuntimeArtifact)}\n`;
  const lookupScopeGraphRuntimeJson = `${stableJsonStringify(finalizedLookupScopeGraphRuntimeArtifact)}\n`;
  const lookupAmbiguityRuntimeJson = `${stableJsonStringify(finalizedLookupAmbiguityRuntimeArtifact)}\n`;
  const lookupConceptRedirectRuntimeJson = `${stableJsonStringify(finalizedLookupConceptRedirectRuntimeArtifact)}\n`;
  const fieldAvailability = buildFieldAvailability(finalRecords);
  const quality = {
    status: 'canonical' as const,
    blockers: [] as string[],
    bypasses: carryForwardRecords.length > 0 ? ['benchmark_carry_forward'] : [],
    carryForwardBenchmarkCount: carryForwardRecords.length,
    experimentalInputsPresent: false,
  };

  const manifest: SearchSnapshotManifest = {
    schemaVersion: SEARCH_SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    generatedAt,
    contentHash,
    sourceInputPath: args.input,
    artifacts: {
      documentsNdjson: path.join(snapshotRoot, 'documents.ndjson'),
      vespaFeedNdjson: path.join(snapshotRoot, 'vespa-feed.ndjson'),
      entitiesNdjson: path.join(snapshotRoot, 'entities.ndjson'),
      aliasesNdjson: path.join(snapshotRoot, 'aliases.ndjson'),
      lookupAliasRuntimeJson: path.join(snapshotRoot, 'lookup-alias-runtime.json'),
      lookupAliasBroadRecallRuntimeJson: path.join(snapshotRoot, 'lookup-alias-broad-recall-runtime.json'),
      lookupExactSafeRuntimeJson: path.join(snapshotRoot, 'lookup-exact-safe-runtime.json'),
      lookupResolverProjectionJson: path.join(snapshotRoot, 'lookup-resolver-projection.json'),
      lookupEntityProjectionJson: path.join(snapshotRoot, 'lookup-entity-projection.json'),
      lookupSemanticScopeRuntimeJson: path.join(snapshotRoot, 'lookup-semantic-scope-runtime.json'),
      lookupReviewedFamilyRecallRuntimeJson: path.join(snapshotRoot, 'lookup-reviewed-family-recall-runtime.json'),
      lookupScopeGraphRuntimeJson: path.join(snapshotRoot, 'lookup-scope-graph-runtime.json'),
      lookupAmbiguityRuntimeJson: path.join(snapshotRoot, 'lookup-ambiguity-runtime.json'),
      lookupConceptRedirectRuntimeJson: path.join(snapshotRoot, 'lookup-concept-redirect-runtime.json'),
      ambiguityRegistryNdjson: path.join(snapshotRoot, 'ambiguity-registry.ndjson'),
      nlMappingsJson: path.join(snapshotRoot, 'nl-mappings.json'),
      metadataJson: path.join(snapshotRoot, 'metadata.json'),
    },
    counts: {
      documents: finalRecords.length,
      vespaFeed: 0,
      entities: entityArtifact.length,
      aliases: resolvedAliases.length,
      lookupAliasRuntimeAliases: finalizedLookupAliasRuntimeArtifact.aliases.length,
      lookupAliasBroadRecallRuntimeEntries:
        Object.keys(finalizedLookupAliasBroadRecallRuntimeArtifact.wholeTokenIndex).length
        + Object.keys(finalizedLookupAliasBroadRecallRuntimeArtifact.phoneticIndex).length
        + Object.keys(finalizedLookupAliasBroadRecallRuntimeArtifact.doubleMetaphoneIndex).length
        + Object.keys(finalizedLookupAliasBroadRecallRuntimeArtifact.doubleMetaphoneKeysByAliasId ?? {}).length
        + finalizedLookupAliasBroadRecallRuntimeArtifact.prefixCatalog.length
        + (finalizedLookupAliasBroadRecallRuntimeArtifact.hangulCompletionRecords?.length ?? 0),
      lookupExactSafeRuntimeEntries:
        Object.keys(finalizedLookupExactSafeRuntimeArtifact.exactEntries).length
        + Object.keys(finalizedLookupExactSafeRuntimeArtifact.compactEntries).length,
      lookupResolverProjectionDocuments: finalizedLookupResolverProjectionArtifact.documents.length,
      lookupEntityProjectionDocuments: finalizedLookupEntityProjectionArtifact.documents.length,
      lookupSemanticScopeRuntimeEntries: Object.keys(finalizedLookupSemanticScopeRuntimeArtifact.entries).length,
      lookupReviewedFamilyRecallRuntimeEntries: Object.keys(finalizedLookupReviewedFamilyRecallRuntimeArtifact.entries).length,
      lookupScopeGraphRuntimeEdges: Object.values(finalizedLookupScopeGraphRuntimeArtifact.adjacency)
        .reduce((sum, edges) => sum + edges.length, 0),
      lookupAmbiguityRuntimeEntries: Object.keys(finalizedLookupAmbiguityRuntimeArtifact.entries).length,
      lookupConceptRedirectRuntimeEntries: Object.keys(finalizedLookupConceptRedirectRuntimeArtifact.entries).length,
      ambiguityRegistry: ambiguityRows.length,
      nlMappings: nlMappings.mappingCount,
    },
    hashes,
    fieldAvailability,
    quality,
  };

  const metadata = {
    snapshotId,
    generatedAt: manifest.generatedAt,
    sourceInputPath: args.input,
    counts: manifest.counts,
    hashes: manifest.hashes,
    fieldAvailability: manifest.fieldAvailability,
    quality: manifest.quality,
  } as const;

  await fs.mkdir(snapshotRoot, { recursive: true });
  await Promise.all([
    atomicWriteFile(manifest.artifacts.documentsNdjson, documentsNdjson),
    fs.rm(manifest.artifacts.vespaFeedNdjson, { force: true }),
    atomicWriteFile(manifest.artifacts.entitiesNdjson, entitiesNdjson),
    atomicWriteFile(manifest.artifacts.aliasesNdjson, aliasesNdjson),
    atomicWriteFile(manifest.artifacts.lookupAliasRuntimeJson, lookupAliasRuntimeJson),
    atomicWriteFile(manifest.artifacts.lookupAliasBroadRecallRuntimeJson, lookupAliasBroadRecallRuntimeJson),
    atomicWriteFile(manifest.artifacts.lookupExactSafeRuntimeJson, lookupExactSafeRuntimeJson),
    atomicWriteFile(manifest.artifacts.lookupResolverProjectionJson, lookupResolverProjectionJson),
    atomicWriteFile(manifest.artifacts.lookupEntityProjectionJson, lookupEntityProjectionJson),
    atomicWriteFile(manifest.artifacts.lookupSemanticScopeRuntimeJson, lookupSemanticScopeRuntimeJson),
    atomicWriteFile(manifest.artifacts.lookupReviewedFamilyRecallRuntimeJson, lookupReviewedFamilyRecallRuntimeJson),
    atomicWriteFile(manifest.artifacts.lookupScopeGraphRuntimeJson, lookupScopeGraphRuntimeJson),
    atomicWriteFile(manifest.artifacts.lookupAmbiguityRuntimeJson, lookupAmbiguityRuntimeJson),
    atomicWriteFile(manifest.artifacts.lookupConceptRedirectRuntimeJson, lookupConceptRedirectRuntimeJson),
    atomicWriteFile(manifest.artifacts.ambiguityRegistryNdjson, ambiguityNdjson),
    atomicWriteFile(manifest.artifacts.nlMappingsJson, nlMappingsCanonical),
    atomicWriteFile(manifest.artifacts.metadataJson, `${JSON.stringify(metadata, null, 2)}\n`),
    atomicWriteFile(path.join(snapshotRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
  ]);

  const finalizedSemanticDescriptors = [
    ...buildLookupV2RuntimeSemanticDescriptorMapFromDocuments(
      finalizedLookupEntityProjectionArtifact.documents,
    ).entries(),
  ];

  await writeLookupRuntimeBundleCache(
    buildLookupRuntimeBundleCachePayload({
      snapshotId,
      aliasContentHash: hashes.aliases,
      manifestPath: path.join(snapshotRoot, 'manifest.json'),
      artifactPaths: {
        lookupAliasRuntimeJson: manifest.artifacts.lookupAliasRuntimeJson,
        lookupAliasBroadRecallRuntimeJson: manifest.artifacts.lookupAliasBroadRecallRuntimeJson,
        lookupExactSafeRuntimeJson: manifest.artifacts.lookupExactSafeRuntimeJson,
        lookupResolverProjectionJson: manifest.artifacts.lookupResolverProjectionJson,
        lookupSemanticScopeRuntimeJson: manifest.artifacts.lookupSemanticScopeRuntimeJson,
        lookupReviewedFamilyRecallRuntimeJson: manifest.artifacts.lookupReviewedFamilyRecallRuntimeJson,
        lookupScopeGraphRuntimeJson: manifest.artifacts.lookupScopeGraphRuntimeJson,
        lookupAmbiguityRuntimeJson: manifest.artifacts.lookupAmbiguityRuntimeJson,
        lookupConceptRedirectRuntimeJson: manifest.artifacts.lookupConceptRedirectRuntimeJson,
      },
      aliasRuntimeArtifact: finalizedLookupAliasRuntimeArtifact,
      aliasBroadRecallRuntimeArtifact: finalizedLookupAliasBroadRecallRuntimeArtifact,
      exactEntries: Object.entries(finalizedLookupExactSafeRuntimeArtifact.exactEntries).map(([surface, entry]) => [
        surface,
        {
          entityId: createCanonicalEntityId(entry.entityId),
          locale: entry.locale,
          kind: entry.certificate.kind,
          normalizedSurface: entry.certificate.normalizedSurface,
          ...(entry.certificate.compactSurface !== undefined
            ? { compactSurface: entry.certificate.compactSurface }
            : {}),
        },
      ] as const),
      compactEntries: Object.entries(finalizedLookupExactSafeRuntimeArtifact.compactEntries).map(([surface, entry]) => [
        surface,
        {
          entityId: createCanonicalEntityId(entry.entityId),
          locale: entry.locale,
          kind: entry.certificate.kind,
          normalizedSurface: entry.certificate.normalizedSurface,
          ...(entry.certificate.compactSurface !== undefined
            ? { compactSurface: entry.certificate.compactSurface }
            : {}),
        },
      ] as const),
      resolverProjectionDocuments: finalizedLookupResolverProjectionArtifact.documents.map((doc) => [
        doc.entityId,
        {
          ...doc,
          entityId: createCanonicalEntityId(doc.entityId),
        },
      ] as const),
      semanticDescriptors: finalizedSemanticDescriptors,
      semanticScopeEntries: Object.entries(finalizedLookupSemanticScopeRuntimeArtifact.entries),
      reviewedFamilyRecallEntries: Object.entries(finalizedLookupReviewedFamilyRecallRuntimeArtifact.entries),
      scopeGraphAdjacency: Object.entries(finalizedLookupScopeGraphRuntimeArtifact.adjacency),
      ambiguityEntries: Object.entries(finalizedLookupAmbiguityRuntimeArtifact.entries).map(([normalizedForm, entry]) => [
        normalizedForm,
        {
          types: [...entry.types],
          severity: entry.severity,
          ...(entry.entityIds !== undefined ? { entityIds: [...entry.entityIds] } : {}),
        },
      ] as const),
      conceptRedirectEntries: Object.entries(finalizedLookupConceptRedirectRuntimeArtifact.entries).map(([normalizedForm, entry]) => [
        normalizedForm,
        entry,
      ] as const),
    }),
  );

  return {
    manifest,
    snapshotRoot,
    manifestPath: path.join(snapshotRoot, 'manifest.json'),
  };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await buildSearchSnapshot(args);
  console.log(`Built search snapshot ${result.manifest.snapshotId}`);
  console.log(`snapshot_root=${result.snapshotRoot}`);
  console.log(`manifest=${result.manifestPath}`);
  console.log(`documents=${result.manifest.counts.documents}`);
  console.log(`entities=${result.manifest.counts.entities}`);
  console.log(`aliases=${result.manifest.counts.aliases}`);
  console.log(`ambiguity_registry=${result.manifest.counts.ambiguityRegistry}`);
  console.log(`nl_mappings=${result.manifest.counts.nlMappings}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}

#!/usr/bin/env tsx

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseNdjson } from './ndjson.js';
import type { EnrichedSilverRecord } from './types.js';
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
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../../src/shared/constants/search-snapshot.js';
import { buildAliasArtifact } from './build-alias-artifact.js';
import {
  loadGoldCanonicalLookupForBuild,
  resolveWineSnapshotEntity,
} from './snapshot-entity-identity.js';
import type {
  CanonicalEntityId,
  SourceRecordId,
} from '../../src/domain/shared/types/entity-id.js';
import { SOURCE_SYSTEM_VIVINO_SILVER } from '../../src/shared/constants/source-systems.js';
import { ETL_ARTIFACT_FILES } from './artifact-contract.js';

export const DEFAULT_INPUT = ETL_ARTIFACT_FILES.trackc;
export const DEFAULT_OUTPUT_DIR = ETL_ARTIFACT_FILES.searchSnapshotsDir;
export const DEFAULT_NL_MAPPINGS = ETL_ARTIFACT_FILES.nlMappings;

export interface Args {
  readonly input: string;
  readonly outputDir: string;
  readonly nlMappings: string;
  readonly fixtureRepoRoot?: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  let input = DEFAULT_INPUT;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let nlMappings = DEFAULT_NL_MAPPINGS;
  let fixtureRepoRoot: string | undefined;
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
    }
  }
  return { input, outputDir, nlMappings, fixtureRepoRoot };
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

export async function buildSearchSnapshot(args: Args): Promise<BuildSearchSnapshotResult> {
  const [recordContent, nlMappingsRaw] = await Promise.all([
    fs.readFile(args.input, 'utf8'),
    fs.readFile(args.nlMappings, 'utf8'),
  ]);

  const parsed = parseNdjson<EnrichedSilverRecord>(recordContent, args.input);
  const records = [...parsed.records].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const goldLookup = await loadGoldCanonicalLookupForBuild({ fixtureRepoRoot: args.fixtureRepoRoot });
  const entityArtifact: EntitySnapshotRecord[] = [];
  const entityIdBySourceId = new Map<SourceRecordId, CanonicalEntityId>();

  for (const record of records) {
    const resolved = resolveWineSnapshotEntity(record, goldLookup);
    const occasion = record.occasionClassification?.values ?? record.occasion;
    entityArtifact.push({
      entityId: resolved.entityId,
      entityType: 'wine',
      canonicalLabel: record.canonicalLabel,
      identitySignature: resolved.identitySignature,
      relations: {},
      attributes: {
        grapes: record.grapes,
        style: record.wineType,
        ...(record.body != null ? { body: record.body } : {}),
        ...(record.sweetness != null ? { sweetness: record.sweetness } : {}),
        ...(record.acidity != null ? { acidity: record.acidity } : {}),
        ...(record.tannin != null ? { tannin: record.tannin } : {}),
        region: record.region,
        priceBand: record.priceBand,
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
        ...(resolved.benchmarkEntityId != null ? { benchmarkEntityId: resolved.benchmarkEntityId } : {}),
        sourceRecordRefs: [
          { sourceSystem: SOURCE_SYSTEM_VIVINO_SILVER, sourceRecordId: record.sourceId },
        ],
      },
    } as const);
    entityIdBySourceId.set(record.sourceId, resolved.entityId);
  }
  entityArtifact.sort((left, right) => left.entityId.localeCompare(right.entityId));
  const aliasArtifact = buildAliasArtifact(records, entityIdBySourceId);
  const { resolvedAliases, ambiguityRows } = resolveAliasClaimsAndBuildAmbiguityRegistry(aliasArtifact);
  const nlMappings = parseNlMappings(nlMappingsRaw);

  const documentsNdjson = serializeNdjson(records);
  const vespaFeedNdjson = recordContent;
  const entitiesNdjson = serializeNdjson(entityArtifact);
  const aliasesNdjson = serializeNdjson(resolvedAliases);
  const ambiguityNdjson = serializeNdjson(ambiguityRows);
  const nlMappingsCanonical = `${stableJsonStringify(nlMappings.payload)}\n`;

  const hashes = {
    documents: hashText(documentsNdjson),
    vespaFeed: hashText(vespaFeedNdjson),
    entities: hashStableJson(entityArtifact),
    aliases: hashStableJson(resolvedAliases),
    ambiguityRegistry: hashStableJson(ambiguityRows),
    nlMappings: hashText(nlMappingsCanonical),
  } as const;

  const contentHash = buildSearchSnapshotContentHash(hashes);
  const snapshotId = buildSearchSnapshotId(contentHash);
  const snapshotRoot = path.join(args.outputDir, snapshotId);

  const manifest: SearchSnapshotManifest = {
    schemaVersion: SEARCH_SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    generatedAt: new Date().toISOString(),
    contentHash,
    sourceInputPath: args.input,
    artifacts: {
      documentsNdjson: path.join(snapshotRoot, 'documents.ndjson'),
      vespaFeedNdjson: path.join(snapshotRoot, 'vespa-feed.ndjson'),
      entitiesNdjson: path.join(snapshotRoot, 'entities.ndjson'),
      aliasesNdjson: path.join(snapshotRoot, 'aliases.ndjson'),
      ambiguityRegistryNdjson: path.join(snapshotRoot, 'ambiguity-registry.ndjson'),
      nlMappingsJson: path.join(snapshotRoot, 'nl-mappings.json'),
      metadataJson: path.join(snapshotRoot, 'metadata.json'),
    },
    counts: {
      documents: records.length,
      vespaFeed: records.length,
      entities: entityArtifact.length,
      aliases: resolvedAliases.length,
      ambiguityRegistry: ambiguityRows.length,
      nlMappings: nlMappings.mappingCount,
    },
    hashes,
  };

  const metadata = {
    snapshotId,
    generatedAt: manifest.generatedAt,
    sourceInputPath: args.input,
    counts: manifest.counts,
    hashes: manifest.hashes,
  } as const;

  await fs.mkdir(snapshotRoot, { recursive: true });
  await Promise.all([
    atomicWriteFile(manifest.artifacts.documentsNdjson, documentsNdjson),
    fs.copyFile(args.input, manifest.artifacts.vespaFeedNdjson),
    atomicWriteFile(manifest.artifacts.entitiesNdjson, entitiesNdjson),
    atomicWriteFile(manifest.artifacts.aliasesNdjson, aliasesNdjson),
    atomicWriteFile(manifest.artifacts.ambiguityRegistryNdjson, ambiguityNdjson),
    atomicWriteFile(manifest.artifacts.nlMappingsJson, nlMappingsCanonical),
    atomicWriteFile(manifest.artifacts.metadataJson, `${JSON.stringify(metadata, null, 2)}\n`),
    atomicWriteFile(path.join(snapshotRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
  ]);

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

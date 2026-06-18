#!/usr/bin/env tsx

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CanonicalEntityId, SourceRecordId } from '../../src/domain/shared/types/entity-id.js';
import {
  buildSearchSnapshot,
  DEFAULT_INPUT,
  DEFAULT_NL_MAPPINGS,
  DEFAULT_RUNTIME_STATE_PATH,
} from './build-search-snapshot.js';
import { atomicWriteFile } from './etl-utils.js';
import {
  DEFAULT_LOOKUP_EXACT_SAFE_REGISTRY_PATH,
  loadLookupExactSafeRegistry,
  pruneLookupExactSafeRegistryRowsByVintageConsistency,
  serializeLookupExactSafeRegistryRows,
} from './lookup-exact-safe-registry.js';
import { parseNdjson } from './ndjson.js';
import type { EntitySnapshotRecord } from './search-snapshot-schema.js';
import type { EnrichedSilverRecord } from './types.js';

const DEFAULT_PRUNED_REGISTRY_OUTPUT = '/tmp/korean-exact-safe-registry-v1.pruned.jsonl';
const DEFAULT_MISMATCH_SUMMARY_OUTPUT = '/tmp/lookup-v2-exact-safe-vintage-mismatches.json';

interface Args {
  readonly input: string;
  readonly output?: string | undefined;
  readonly summaryOutput: string;
  readonly trackCInput: string;
  readonly nlMappings: string;
  readonly runtimeStatePath: string;
  readonly fixtureRepoRoot?: string | undefined;
  readonly snapshotOutputDir?: string | undefined;
  readonly preserveSnapshotOutput: boolean;
  readonly write: boolean;
}

interface LookupExactSafeVintagePruneSummary {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly summaryOutputPath: string;
  readonly snapshotId: string;
  readonly snapshotOutputDir: string;
  readonly keptCount: number;
  readonly removedCount: number;
  readonly issues: readonly {
    readonly surface: string;
    readonly entityId: CanonicalEntityId;
    readonly surfaceVintage: number;
    readonly entityVintages: readonly number[];
    readonly reason: 'missing_entity_vintages' | 'entity_vintage_mismatch';
  }[];
}

function parseArgs(argv: readonly string[]): Args {
  let input = DEFAULT_LOOKUP_EXACT_SAFE_REGISTRY_PATH;
  let output: string | undefined;
  let summaryOutput = DEFAULT_MISMATCH_SUMMARY_OUTPUT;
  let trackCInput = DEFAULT_INPUT;
  let nlMappings = DEFAULT_NL_MAPPINGS;
  let runtimeStatePath = DEFAULT_RUNTIME_STATE_PATH;
  let fixtureRepoRoot: string | undefined;
  let snapshotOutputDir: string | undefined;
  let preserveSnapshotOutput = false;
  let write = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      input = argv[i + 1] ?? input;
      i += 1;
    } else if (arg === '--output') {
      output = argv[i + 1] ?? output;
      i += 1;
    } else if (arg === '--summary-output') {
      summaryOutput = argv[i + 1] ?? summaryOutput;
      i += 1;
    } else if (arg === '--trackc-input') {
      trackCInput = argv[i + 1] ?? trackCInput;
      i += 1;
    } else if (arg === '--nl-mappings') {
      nlMappings = argv[i + 1] ?? nlMappings;
      i += 1;
    } else if (arg === '--runtime-state') {
      runtimeStatePath = argv[i + 1] ?? runtimeStatePath;
      i += 1;
    } else if (arg === '--fixture-repo') {
      fixtureRepoRoot = argv[i + 1] ?? fixtureRepoRoot;
      i += 1;
    } else if (arg === '--snapshot-output-dir') {
      snapshotOutputDir = argv[i + 1] ?? snapshotOutputDir;
      i += 1;
    } else if (arg === '--preserve-snapshot-output') {
      preserveSnapshotOutput = true;
    } else if (arg === '--write') {
      write = true;
    }
  }

  if (write && output !== undefined) {
    throw new Error('--write and --output are mutually exclusive; omit --output to rewrite the input registry');
  }

  return {
    input,
    output,
    summaryOutput,
    trackCInput,
    nlMappings,
    runtimeStatePath,
    fixtureRepoRoot,
    snapshotOutputDir,
    preserveSnapshotOutput,
    write,
  };
}

function readEntitySourceRecordIds(entity: EntitySnapshotRecord): readonly SourceRecordId[] {
  if (typeof entity.metadata !== 'object' || entity.metadata === null) {
    return [];
  }
  const refs = (entity.metadata as Record<string, unknown>).sourceRecordRefs;
  if (!Array.isArray(refs)) {
    return [];
  }
  const sourceRecordIds: SourceRecordId[] = [];
  for (const ref of refs) {
    if (typeof ref !== 'object' || ref === null) {
      continue;
    }
    const sourceRecordId = (ref as Record<string, unknown>).sourceRecordId;
    if (typeof sourceRecordId === 'string' && sourceRecordId.length > 0) {
      sourceRecordIds.push(sourceRecordId as SourceRecordId);
    }
  }
  return sourceRecordIds;
}

export function buildLookupExactSafeEntityVintagesByIdFromSnapshotArtifacts(args: {
  readonly documents: readonly EnrichedSilverRecord[];
  readonly entities: readonly EntitySnapshotRecord[];
}): ReadonlyMap<CanonicalEntityId, readonly number[]> {
  const vintageBySourceId = new Map<SourceRecordId, number>();
  for (const document of args.documents) {
    if (document.vintageYear == null) {
      continue;
    }
    vintageBySourceId.set(document.sourceId as SourceRecordId, document.vintageYear);
  }

  const grouped = new Map<CanonicalEntityId, Set<number>>();
  for (const entity of args.entities) {
    for (const sourceRecordId of readEntitySourceRecordIds(entity)) {
      const vintage = vintageBySourceId.get(sourceRecordId);
      if (vintage === undefined) {
        continue;
      }
      const existing = grouped.get(entity.entityId as CanonicalEntityId) ?? new Set<number>();
      existing.add(vintage);
      grouped.set(entity.entityId as CanonicalEntityId, existing);
    }
  }

  return new Map(
    [...grouped.entries()].map(([entityId, vintages]) => [
      entityId,
      [...vintages].sort((left, right) => left - right),
    ]),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outputPath = args.write ? args.input : (args.output ?? DEFAULT_PRUNED_REGISTRY_OUTPUT);
  const registryRows = await loadLookupExactSafeRegistry(args.input);
  const snapshotOutputDir = args.snapshotOutputDir
    ?? await fs.mkdtemp(path.join(os.tmpdir(), 'lookup-exact-safe-prune-'));
  const shouldCleanupSnapshot =
    args.snapshotOutputDir === undefined && !args.preserveSnapshotOutput;

  try {
    const snapshot = await buildSearchSnapshot({
      input: args.trackCInput,
      outputDir: snapshotOutputDir,
      nlMappings: args.nlMappings,
      fixtureRepoRoot: args.fixtureRepoRoot,
      runtimeStatePath: args.runtimeStatePath,
      reviewedRegistryOverrides: {
        exactSafeRows: [],
      },
    });

    const documents = parseNdjson<EnrichedSilverRecord>(
      await fs.readFile(snapshot.manifest.artifacts.documentsNdjson, 'utf8'),
      snapshot.manifest.artifacts.documentsNdjson,
    ).records;
    const entities = parseNdjson<EntitySnapshotRecord>(
      await fs.readFile(snapshot.manifest.artifacts.entitiesNdjson, 'utf8'),
      snapshot.manifest.artifacts.entitiesNdjson,
    ).records;
    const entityVintagesById = buildLookupExactSafeEntityVintagesByIdFromSnapshotArtifacts({
      documents,
      entities,
    });
    const pruneResult = pruneLookupExactSafeRegistryRowsByVintageConsistency({
      rows: registryRows,
      entityVintagesById,
    });

    await atomicWriteFile(outputPath, serializeLookupExactSafeRegistryRows(pruneResult.keptRows));
    const summary: LookupExactSafeVintagePruneSummary = {
      inputPath: args.input,
      outputPath,
      summaryOutputPath: args.summaryOutput,
      snapshotId: snapshot.manifest.snapshotId,
      snapshotOutputDir,
      keptCount: pruneResult.keptRows.length,
      removedCount: pruneResult.removedIssues.length,
      issues: pruneResult.removedIssues.map((issue) => ({
        surface: issue.row.surface,
        entityId: issue.row.entityId,
        surfaceVintage: issue.surfaceVintage,
        entityVintages: issue.entityVintages,
        reason: issue.reason,
      })),
    };
    await atomicWriteFile(args.summaryOutput, `${JSON.stringify(summary, null, 2)}\n`);

    console.log(`[lookup-exact-safe-prune] snapshot_id=${summary.snapshotId}`);
    console.log(`[lookup-exact-safe-prune] registry_rows=${registryRows.length}`);
    console.log(`[lookup-exact-safe-prune] kept_rows=${summary.keptCount}`);
    console.log(`[lookup-exact-safe-prune] removed_rows=${summary.removedCount}`);
    console.log(`[lookup-exact-safe-prune] output=${outputPath}`);
    console.log(`[lookup-exact-safe-prune] summary=${args.summaryOutput}`);
  } finally {
    if (shouldCleanupSnapshot) {
      await fs.rm(snapshotOutputDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(
    `FATAL: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

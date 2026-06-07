import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import type { LookupV2CurationDraftRow } from './export-lookup-v2-curation-drafts.js';
import type { LookupV2RuntimeSurfaceOwnerEvidence } from './lookup-v2-runtime-surface-owner-evidence.js';
import { loadLookupV2RuntimeSurfaceOwnerEvidenceSync } from './lookup-v2-runtime-surface-owner-evidence.js';
import { resolveCliDataPathArg } from './cli-data-path.js';

export type LookupV2ReviewedCollisionProducerTopology =
  | 'single_producer'
  | 'multi_producer'
  | 'unknown_producer';

export type LookupV2ReviewedCollisionWitnessTopology =
  | 'producer_only'
  | 'family_core_only'
  | 'family_core_plus_noisy_recall'
  | 'mixed_witness';

export type LookupV2ReviewedCollisionTopology =
  `${LookupV2ReviewedCollisionProducerTopology}_${LookupV2ReviewedCollisionWitnessTopology}`;

export type LookupV2ReviewedCollisionGovernanceClass =
  | 'reviewed_family_core_collision'
  | 'native_family_core_collision'
  | 'family_recall_collision'
  | 'producer_surface_region_line_collision'
  | 'producer_surface_secondary_line_collision'
  | 'mixed_collision';

export interface LookupV2ReviewedCollisionFamilyClusterRow {
  readonly benchmarkGoldHint: string;
  readonly normalizedBenchmarkGoldHint: string;
  readonly collisionStatus: 'active_entity_collision';
  readonly collisionTopology: LookupV2ReviewedCollisionTopology;
  readonly governanceClass: LookupV2ReviewedCollisionGovernanceClass;
  readonly producerTopology: LookupV2ReviewedCollisionProducerTopology;
  readonly witnessTopology: LookupV2ReviewedCollisionWitnessTopology;
  readonly familyScopeRows: number;
  readonly locales: readonly LookupV2CurationDraftRow['locale'][];
  readonly suggestedAliasTypes: readonly LookupV2CurationDraftRow['suggestedAliasType'][];
  readonly holeClasses: readonly string[];
  readonly surfaces: readonly string[];
  readonly sourceArtifacts: readonly string[];
  readonly sourceEvidenceSamples: readonly string[];
  readonly witnessSources: readonly string[];
  readonly collisionEntityProducers: readonly string[];
  readonly collisionEntityRegions: readonly string[];
  readonly collisionEntityAppellations: readonly string[];
  readonly producerCardinality: number;
  readonly regionCardinality: number;
  readonly appellationCardinality: number;
  readonly runtimeCollisionEntityIds: readonly string[];
  readonly runtimeCollisionEntityLabels: readonly string[];
  readonly runtimeCollisionWitnesses?: LookupV2RuntimeSurfaceOwnerEvidence['collidingOwnerWitnesses'] extends ReadonlyMap<string, infer T> ? T : never;
}

export interface LookupV2ReviewedCollisionFamilyClusterIndex {
  readonly sourceDraftPath: string;
  readonly generatedAt: string;
  readonly totalRows: number;
  readonly totalFamilies: number;
  readonly outputPath: string;
  readonly topologyCounts: Readonly<Record<string, number>>;
  readonly governanceCounts: Readonly<Record<string, number>>;
  readonly topologyOutputDir: string;
  readonly topologyIndexPath: string;
  readonly governanceOutputDir: string;
  readonly governanceIndexPath: string;
}

function isLookupV2CurationDraftRow(value: unknown): value is LookupV2CurationDraftRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return typeof row['surface'] === 'string' && typeof row['triageBucket'] === 'string';
}

function parseDraftJsonl(filePath: string): readonly LookupV2CurationDraftRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isLookupV2CurationDraftRow);
}

function sortUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function serializeJsonl(rows: readonly unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

function sortUniqueNonEmpty(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function classifyProducerTopology(args: {
  readonly collisionEntityIds: readonly string[];
  readonly runtimeOwnerEvidence: LookupV2RuntimeSurfaceOwnerEvidence;
}): LookupV2ReviewedCollisionProducerTopology {
  const normalizedProducers = args.collisionEntityIds.map((entityId) => {
    const producer = args.runtimeOwnerEvidence.entityProducers.get(entityId);
    return producer !== undefined && producer.trim().length > 0
      ? normalizeForMatch(producer)
      : undefined;
  });
  if (normalizedProducers.some((producer) => producer === undefined || producer.length === 0)) {
    return 'unknown_producer';
  }
  return new Set(normalizedProducers).size === 1 ? 'single_producer' : 'multi_producer';
}

function classifyWitnessTopology(
  witnessSources: readonly string[],
): LookupV2ReviewedCollisionWitnessTopology {
  const familyCoreSources = new Set(['family_core_key', 'reviewed_family_core_registry']);
  if (witnessSources.length > 0 && witnessSources.every((source) => source === 'producer')) {
    return 'producer_only';
  }
  if (witnessSources.length > 0 && witnessSources.every((source) => familyCoreSources.has(source))) {
    return 'family_core_only';
  }
  if (
    witnessSources.includes('aliases_noisy_recall')
    && witnessSources.every((source) => familyCoreSources.has(source) || source === 'aliases_noisy_recall')
  ) {
    return 'family_core_plus_noisy_recall';
  }
  return 'mixed_witness';
}

function classifyGovernanceClass(args: {
  readonly witnessSources: readonly string[];
  readonly producerTopology: LookupV2ReviewedCollisionProducerTopology;
  readonly regionCardinality: number;
  readonly appellationCardinality: number;
}): LookupV2ReviewedCollisionGovernanceClass {
  if (args.witnessSources.includes('aliases_noisy_recall')) {
    return 'family_recall_collision';
  }
  if (args.witnessSources.length > 0 && args.witnessSources.every((source) => source === 'producer')) {
    return args.regionCardinality > 1 || args.appellationCardinality > 1
      ? 'producer_surface_region_line_collision'
      : 'producer_surface_secondary_line_collision';
  }
  if (args.witnessSources.length > 0 && args.witnessSources.every((source) => source === 'reviewed_family_core_registry')) {
    return 'reviewed_family_core_collision';
  }
  if (
    args.witnessSources.length > 0
    && args.witnessSources.every((source) => source === 'family_core_key' || source === 'reviewed_family_core_registry')
  ) {
    return args.witnessSources.includes('reviewed_family_core_registry')
      ? 'reviewed_family_core_collision'
      : 'native_family_core_collision';
  }
  if (args.producerTopology === 'single_producer' && args.witnessSources.length > 0 && args.witnessSources.every((source) => source === 'producer')) {
    return 'producer_surface_secondary_line_collision';
  }
  return 'mixed_collision';
}

export function writeLookupV2ReviewedCollisionFamilyClusters(args: {
  readonly draftRows: readonly LookupV2CurationDraftRow[];
  readonly runtimeOwnerEvidence?: LookupV2RuntimeSurfaceOwnerEvidence;
  readonly sourceDraftPath: string;
  readonly outputPath: string;
  readonly generatedAt: string;
}): LookupV2ReviewedCollisionFamilyClusterIndex {
  const runtimeOwnerEvidence = args.runtimeOwnerEvidence ?? loadLookupV2RuntimeSurfaceOwnerEvidenceSync();
  const groups = new Map<string, LookupV2CurationDraftRow[]>();
  for (const row of args.draftRows) {
    if (row.triageBucket !== 'reviewed_collision') {
      continue;
    }
    if (row.benchmarkGoldHint === undefined || row.collisionStatus !== 'active_entity_collision') {
      throw new Error(`reviewed_collision draft row is missing collision metadata for surface=${JSON.stringify(row.surface)}`);
    }
    const key = row.benchmarkGoldHint;
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }

  const clusterRows: readonly LookupV2ReviewedCollisionFamilyClusterRow[] = [...groups.entries()]
    .map(([benchmarkGoldHint, rows]) => {
      const exemplar = rows[0]!;
      const normalizedBenchmarkGoldHint = normalizeForMatch(exemplar.benchmarkGoldHint ?? benchmarkGoldHint);
      const collisionEntityIds = runtimeOwnerEvidence.collidingOwners.get(normalizedBenchmarkGoldHint) ?? [];
      if (collisionEntityIds.length === 0) {
        throw new Error(`reviewed_collision family is missing runtime collision evidence for benchmarkGoldHint=${JSON.stringify(benchmarkGoldHint)}`);
      }
      const collisionWitnesses = runtimeOwnerEvidence.collidingOwnerWitnesses.get(normalizedBenchmarkGoldHint) ?? [];
      const witnessSources = sortUnique(collisionWitnesses.map((witness) => witness.witnessSource));
      const producerTopology = classifyProducerTopology({
        collisionEntityIds,
        runtimeOwnerEvidence,
      });
      const witnessTopology = classifyWitnessTopology(witnessSources);
      const collisionEntityProducers = sortUniqueNonEmpty(
        collisionEntityIds.map((entityId) => runtimeOwnerEvidence.entityProducers.get(entityId)),
      );
      const collisionEntityRegions = sortUniqueNonEmpty(
        collisionEntityIds.map((entityId) => runtimeOwnerEvidence.entityRegions.get(entityId)),
      );
      const collisionEntityAppellations = sortUniqueNonEmpty(
        collisionEntityIds.map((entityId) => runtimeOwnerEvidence.entityAppellations.get(entityId)),
      );
      const governanceClass = classifyGovernanceClass({
        witnessSources,
        producerTopology,
        regionCardinality: collisionEntityRegions.length,
        appellationCardinality: collisionEntityAppellations.length,
      });
      return {
        benchmarkGoldHint,
        normalizedBenchmarkGoldHint,
        collisionStatus: 'active_entity_collision',
        collisionTopology: `${producerTopology}_${witnessTopology}` as LookupV2ReviewedCollisionTopology,
        governanceClass,
        producerTopology,
        witnessTopology,
        familyScopeRows: rows.length,
        locales: sortUnique(rows.map((row) => row.locale)) as readonly LookupV2CurationDraftRow['locale'][],
        suggestedAliasTypes: sortUnique(rows.map((row) => row.suggestedAliasType)) as readonly LookupV2CurationDraftRow['suggestedAliasType'][],
        holeClasses: sortUnique(rows.map((row) => row.holeClass)),
        surfaces: sortUnique(rows.map((row) => row.surface)),
        sourceArtifacts: sortUnique(rows.map((row) => row.sourceArtifact)),
        sourceEvidenceSamples: sortUnique(rows.map((row) => row.sourceEvidence)),
        witnessSources,
        collisionEntityProducers,
        collisionEntityRegions,
        collisionEntityAppellations,
        producerCardinality: collisionEntityProducers.length,
        regionCardinality: collisionEntityRegions.length,
        appellationCardinality: collisionEntityAppellations.length,
        runtimeCollisionEntityIds: collisionEntityIds,
        runtimeCollisionEntityLabels: collisionEntityIds.map((entityId) => runtimeOwnerEvidence.entityLabels.get(entityId) ?? entityId),
        ...(runtimeOwnerEvidence.collidingOwnerWitnesses.get(normalizedBenchmarkGoldHint) !== undefined
          ? { runtimeCollisionWitnesses: runtimeOwnerEvidence.collidingOwnerWitnesses.get(normalizedBenchmarkGoldHint)! }
          : {}),
      };
    })
    .sort((left, right) => left.benchmarkGoldHint.localeCompare(right.benchmarkGoldHint));

  mkdirSync(path.dirname(args.outputPath), { recursive: true });
  writeFileSync(args.outputPath, serializeJsonl(clusterRows), 'utf8');

  const topologyBaseName = path.basename(args.outputPath).replace(/\.jsonl$/u, '');
  const topologyOutputDir = path.join(path.dirname(args.outputPath), `${topologyBaseName}-by-topology`);
  mkdirSync(topologyOutputDir, { recursive: true });
  const topologyGroups = new Map<LookupV2ReviewedCollisionTopology, LookupV2ReviewedCollisionFamilyClusterRow[]>();
  for (const row of clusterRows) {
    const existing = topologyGroups.get(row.collisionTopology) ?? [];
    existing.push(row);
    topologyGroups.set(row.collisionTopology, existing);
  }
  const topologyCounts = Object.fromEntries(
    [...topologyGroups.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([topology, rows]) => [topology, rows.length]),
  ) as Readonly<Record<string, number>>;
  for (const [topology, rows] of topologyGroups.entries()) {
    writeFileSync(path.join(topologyOutputDir, `${topology}.jsonl`), serializeJsonl(rows), 'utf8');
  }
  const topologyIndexPath = path.join(topologyOutputDir, 'topology-index.json');
  writeFileSync(
    topologyIndexPath,
    JSON.stringify({
      sourceDraftPath: args.sourceDraftPath,
      generatedAt: args.generatedAt,
      totalFamilies: clusterRows.length,
      topologyCounts,
    }, null, 2) + '\n',
    'utf8',
  );

  const governanceOutputDir = path.join(path.dirname(args.outputPath), `${topologyBaseName}-by-governance`);
  mkdirSync(governanceOutputDir, { recursive: true });
  const governanceGroups = new Map<LookupV2ReviewedCollisionGovernanceClass, LookupV2ReviewedCollisionFamilyClusterRow[]>();
  for (const row of clusterRows) {
    const existing = governanceGroups.get(row.governanceClass) ?? [];
    existing.push(row);
    governanceGroups.set(row.governanceClass, existing);
  }
  const governanceCounts = Object.fromEntries(
    [...governanceGroups.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([governanceClass, rows]) => [governanceClass, rows.length]),
  ) as Readonly<Record<string, number>>;
  for (const [governanceClass, rows] of governanceGroups.entries()) {
    writeFileSync(path.join(governanceOutputDir, `${governanceClass}.jsonl`), serializeJsonl(rows), 'utf8');
  }
  const governanceIndexPath = path.join(governanceOutputDir, 'governance-index.json');
  writeFileSync(
    governanceIndexPath,
    JSON.stringify({
      sourceDraftPath: args.sourceDraftPath,
      generatedAt: args.generatedAt,
      totalFamilies: clusterRows.length,
      governanceCounts,
    }, null, 2) + '\n',
    'utf8',
  );

  return {
    sourceDraftPath: args.sourceDraftPath,
    generatedAt: args.generatedAt,
    totalRows: clusterRows.reduce((sum, row) => sum + row.familyScopeRows, 0),
    totalFamilies: clusterRows.length,
    outputPath: args.outputPath,
    topologyCounts,
    governanceCounts,
    topologyOutputDir,
    topologyIndexPath,
    governanceOutputDir,
    governanceIndexPath,
  };
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl' },
      output: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-reviewed-collision-family-clusters.jsonl' },
      generatedAt: { type: 'string', default: new Date().toISOString() },
    },
  });

  const inputPath = resolveCliDataPathArg(
    values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl',
  );
  const outputPath = resolveCliDataPathArg(
    values.output ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-reviewed-collision-family-clusters.jsonl',
  );
  const generatedAt = values.generatedAt ?? new Date().toISOString();
  const draftRows = parseDraftJsonl(inputPath);
  const index = writeLookupV2ReviewedCollisionFamilyClusters({
    draftRows,
    sourceDraftPath: inputPath,
    outputPath,
    generatedAt,
  });

  console.log(`[elv2-reviewed-collision-family-clusters] total_rows=${index.totalRows}`);
  console.log(`[elv2-reviewed-collision-family-clusters] total_families=${index.totalFamilies}`);
  console.log(`[elv2-reviewed-collision-family-clusters] topology_output_dir=${index.topologyOutputDir}`);
  console.log(`[elv2-reviewed-collision-family-clusters] governance_output_dir=${index.governanceOutputDir}`);
  console.log(`[elv2-reviewed-collision-family-clusters] output=${index.outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

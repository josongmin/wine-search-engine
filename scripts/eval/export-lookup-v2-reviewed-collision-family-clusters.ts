import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import type { LookupV2CurationDraftRow } from './export-lookup-v2-curation-drafts.js';
import {
  buildLookupV2ReviewedCollisionFamilyReviewPacketRows,
  type LookupV2ManualTargetFamilyReviewPacketRow,
  type LookupV2RuntimeCollisionClarificationAxis,
  type LookupV2RuntimeCollisionScopeDescriptor,
} from './export-lookup-v2-manual-target-family-review-packet.js';
import type { LookupV2RuntimeSurfaceOwnerEvidence } from './lookup-v2-runtime-surface-owner-evidence.js';
import { loadLookupV2RuntimeSurfaceOwnerEvidenceSync } from './lookup-v2-runtime-surface-owner-evidence.js';
import { lookupV2DraftCliPath, resolveCliDataPathArg } from './cli-data-path.js';

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
  readonly reviewTarget: 'lookup_reviewed_collision_resolution_v1';
  readonly familyScopeRows: number;
  readonly reviewScopeRowCount: number;
  readonly reviewScopeKeys: readonly string[];
  readonly scopeAxes: readonly LookupV2ManualTargetFamilyReviewPacketRow['scopeAxis'][];
  readonly surfaceFormKinds: readonly LookupV2CurationDraftRow['surfaceFormKind'][];
  readonly scopeRisks: readonly LookupV2ManualTargetFamilyReviewPacketRow['scopeRisk'][];
  readonly locales: readonly LookupV2CurationDraftRow['locale'][];
  readonly suggestedAliasTypes: readonly LookupV2CurationDraftRow['suggestedAliasType'][];
  readonly holeClasses: readonly string[];
  readonly surfaces: readonly string[];
  readonly sourceArtifacts: readonly string[];
  readonly sourceEvidenceSamples: readonly string[];
  readonly witnessSources: readonly string[];
  readonly clarificationAxisSignature: string;
  readonly runtimeClarificationAxes?: readonly LookupV2RuntimeCollisionClarificationAxis[] | undefined;
  readonly collisionEntityProducers: readonly string[];
  readonly collisionEntityRegions: readonly string[];
  readonly collisionEntityAppellations: readonly string[];
  readonly producerCardinality: number;
  readonly regionCardinality: number;
  readonly appellationCardinality: number;
  readonly runtimeCollisionEntityIds: readonly string[];
  readonly runtimeCollisionEntityLabels: readonly string[];
  readonly runtimeCollisionScopeDescriptors?: readonly LookupV2RuntimeCollisionScopeDescriptor[] | undefined;
  readonly runtimeCollisionWitnesses?: LookupV2RuntimeSurfaceOwnerEvidence['collidingOwnerWitnesses'] extends ReadonlyMap<string, infer T> ? T : never;
}

export interface LookupV2ReviewedCollisionFamilyClusterIndex {
  readonly sourceDraftPath?: string | undefined;
  readonly sourcePacketPath?: string | undefined;
  readonly generatedAt: string;
  readonly totalRows: number;
  readonly totalReviewScopeRows: number;
  readonly totalFamilies: number;
  readonly outputPath: string;
  readonly topologyCounts: Readonly<Record<string, number>>;
  readonly governanceCounts: Readonly<Record<string, number>>;
  readonly clarificationAxisCounts: Readonly<Record<string, number>>;
  readonly topologyOutputDir: string;
  readonly topologyIndexPath: string;
  readonly governanceOutputDir: string;
  readonly governanceIndexPath: string;
  readonly clarificationOutputDir: string;
  readonly clarificationIndexPath: string;
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

const CLARIFICATION_AXIS_ORDER: readonly LookupV2RuntimeCollisionClarificationAxis[] = [
  'line',
  'region',
  'appellation',
  'vintage',
];

function sortClarificationAxes(
  values: readonly LookupV2RuntimeCollisionClarificationAxis[],
): readonly LookupV2RuntimeCollisionClarificationAxis[] {
  const order = new Map(CLARIFICATION_AXIS_ORDER.map((axis, index) => [axis, index]));
  return [...new Set(values)]
    .sort((left, right) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER));
}

function buildClarificationAxisSignature(
  axes: readonly LookupV2RuntimeCollisionClarificationAxis[],
): string {
  return axes.length > 0 ? axes.join('-') : 'none';
}

function buildCollisionScopeDescriptorKey(descriptor: LookupV2RuntimeCollisionScopeDescriptor): string {
  return [
    descriptor.entityId,
    descriptor.entityLabel,
    descriptor.familyKey,
    descriptor.lineKey ?? '',
    descriptor.regionKey ?? '',
    descriptor.appellationKey ?? '',
    descriptor.vintage ?? '',
  ].join('::');
}

function sortCollisionScopeDescriptors(
  values: readonly LookupV2RuntimeCollisionScopeDescriptor[],
): readonly LookupV2RuntimeCollisionScopeDescriptor[] {
  const descriptorMap = new Map<string, LookupV2RuntimeCollisionScopeDescriptor>();
  for (const descriptor of values) {
    descriptorMap.set(buildCollisionScopeDescriptorKey(descriptor), descriptor);
  }
  return [...descriptorMap.values()]
    .sort((left, right) =>
      left.entityId.localeCompare(right.entityId)
      || left.entityLabel.localeCompare(right.entityLabel)
      || left.familyKey.localeCompare(right.familyKey)
      || (left.lineKey ?? '').localeCompare(right.lineKey ?? '')
      || (left.regionKey ?? '').localeCompare(right.regionKey ?? '')
      || (left.appellationKey ?? '').localeCompare(right.appellationKey ?? '')
      || (left.vintage ?? Number.MIN_SAFE_INTEGER) - (right.vintage ?? Number.MIN_SAFE_INTEGER),
    );
}

function buildRuntimeClarificationAxesFromDescriptors(
  descriptors: readonly LookupV2RuntimeCollisionScopeDescriptor[],
): readonly LookupV2RuntimeCollisionClarificationAxis[] {
  if (descriptors.length <= 1) {
    return [];
  }
  const axes: LookupV2RuntimeCollisionClarificationAxis[] = [];
  const axisValues = {
    line: new Set(descriptors.map((descriptor) => descriptor.lineKey ?? '__missing__')),
    region: new Set(descriptors.map((descriptor) => descriptor.regionKey ?? '__missing__')),
    appellation: new Set(descriptors.map((descriptor) => descriptor.appellationKey ?? '__missing__')),
    vintage: new Set(descriptors.map((descriptor) => String(descriptor.vintage ?? '__missing__'))),
  };
  if (axisValues.line.size > 1) {
    axes.push('line');
  }
  if (axisValues.region.size > 1) {
    axes.push('region');
  }
  if (axisValues.appellation.size > 1) {
    axes.push('appellation');
  }
  if (axisValues.vintage.size > 1) {
    axes.push('vintage');
  }
  return axes;
}

function buildCollisionWitnessKey(
  witness: NonNullable<LookupV2ManualTargetFamilyReviewPacketRow['runtimeCollisionWitnesses']>[number],
): string {
  return `${witness.entityId}::${witness.witnessSurface}::${witness.witnessSource}`;
}

function sortCollisionWitnesses(
  values: readonly NonNullable<LookupV2ManualTargetFamilyReviewPacketRow['runtimeCollisionWitnesses']>[number][],
): readonly NonNullable<LookupV2ManualTargetFamilyReviewPacketRow['runtimeCollisionWitnesses']>[number][] {
  const witnessMap = new Map<string, NonNullable<LookupV2ManualTargetFamilyReviewPacketRow['runtimeCollisionWitnesses']>[number]>();
  for (const witness of values) {
    witnessMap.set(buildCollisionWitnessKey(witness), witness);
  }
  return [...witnessMap.values()]
    .sort((left, right) =>
      left.entityId.localeCompare(right.entityId)
      || left.witnessSource.localeCompare(right.witnessSource)
      || left.witnessSurface.localeCompare(right.witnessSurface),
    );
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
  readonly draftRows?: readonly LookupV2CurationDraftRow[];
  readonly packetRows?: readonly LookupV2ManualTargetFamilyReviewPacketRow[];
  readonly runtimeOwnerEvidence?: LookupV2RuntimeSurfaceOwnerEvidence;
  readonly sourceDraftPath?: string;
  readonly sourcePacketPath?: string;
  readonly outputPath: string;
  readonly generatedAt: string;
}): LookupV2ReviewedCollisionFamilyClusterIndex {
  const runtimeOwnerEvidence = args.runtimeOwnerEvidence ?? loadLookupV2RuntimeSurfaceOwnerEvidenceSync();
  const familyReviewRows = args.packetRows ?? (
    args.draftRows !== undefined
      ? buildLookupV2ReviewedCollisionFamilyReviewPacketRows({
          draftRows: args.draftRows,
          runtimeOwnerEvidence,
        })
      : undefined
  );
  if (familyReviewRows === undefined) {
    throw new Error('reviewed_collision family clusters require draftRows or packetRows');
  }

  const groups = new Map<string, LookupV2ManualTargetFamilyReviewPacketRow[]>();
  for (const row of familyReviewRows) {
    if (row.reviewTarget !== 'lookup_reviewed_collision_resolution_v1') {
      continue;
    }
    if (row.runtimeEvidenceStatus !== 'collision_candidates') {
      throw new Error(`reviewed_collision family review row is missing collision runtime evidence for reviewScopeKey=${JSON.stringify(row.reviewScopeKey)}`);
    }
    const key = row.normalizedBenchmarkGoldHint;
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }

  const clusterRows: readonly LookupV2ReviewedCollisionFamilyClusterRow[] = [...groups.entries()]
    .map(([normalizedBenchmarkGoldHint, rows]) => {
      const exemplar = rows[0]!;
      const collisionEntityIds = sortUnique(
        rows.flatMap((row) => row.runtimeCollisionEntityIds ?? []),
      );
      const resolvedCollisionEntityIds = collisionEntityIds.length > 0
        ? collisionEntityIds
        : (runtimeOwnerEvidence.collidingOwners.get(normalizedBenchmarkGoldHint) ?? []);
      const collisionScopeDescriptors = sortCollisionScopeDescriptors(
        rows.flatMap((row) => row.runtimeCollisionScopeDescriptors ?? []),
      );
      const runtimeClarificationAxes = sortClarificationAxes(
        rows.flatMap((row) => row.runtimeClarificationAxes ?? []),
      );
      const resolvedRuntimeClarificationAxes = runtimeClarificationAxes.length > 0
        ? runtimeClarificationAxes
        : buildRuntimeClarificationAxesFromDescriptors(collisionScopeDescriptors);
      const clarificationAxisSignature = buildClarificationAxisSignature(resolvedRuntimeClarificationAxes);
      const collisionWitnesses = sortCollisionWitnesses(
        rows.flatMap((row) => row.runtimeCollisionWitnesses ?? []),
      );
      const resolvedCollisionWitnesses = collisionWitnesses.length > 0
        ? collisionWitnesses
        : (runtimeOwnerEvidence.collidingOwnerWitnesses.get(normalizedBenchmarkGoldHint) ?? []);
      const benchmarkGoldHint = exemplar.benchmarkGoldHint;
      if (resolvedCollisionEntityIds.length === 0) {
        throw new Error(`reviewed_collision family is missing runtime collision evidence for benchmarkGoldHint=${JSON.stringify(benchmarkGoldHint)}`);
      }
      const witnessSources = sortUnique(resolvedCollisionWitnesses.map((witness) => witness.witnessSource));
      const producerTopology = classifyProducerTopology({
        collisionEntityIds: resolvedCollisionEntityIds,
        runtimeOwnerEvidence,
      });
      const witnessTopology = classifyWitnessTopology(witnessSources);
      const collisionEntityProducers = sortUniqueNonEmpty(
        resolvedCollisionEntityIds.map((entityId) => runtimeOwnerEvidence.entityProducers.get(entityId)),
      );
      const collisionEntityRegions = sortUniqueNonEmpty(
        collisionScopeDescriptors.length > 0
          ? collisionScopeDescriptors.map((descriptor) => descriptor.regionKey)
          : resolvedCollisionEntityIds.map((entityId) => runtimeOwnerEvidence.entityRegions.get(entityId)),
      );
      const collisionEntityAppellations = sortUniqueNonEmpty(
        collisionScopeDescriptors.length > 0
          ? collisionScopeDescriptors.map((descriptor) => descriptor.appellationKey)
          : resolvedCollisionEntityIds.map((entityId) => runtimeOwnerEvidence.entityAppellations.get(entityId)),
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
        reviewTarget: exemplar.reviewTarget,
        familyScopeRows: rows.reduce((sum, row) => sum + row.rowCount, 0),
        reviewScopeRowCount: rows.length,
        reviewScopeKeys: sortUnique(rows.map((row) => row.reviewScopeKey)),
        scopeAxes: sortUnique(rows.map((row) => row.scopeAxis)) as readonly LookupV2ManualTargetFamilyReviewPacketRow['scopeAxis'][],
        surfaceFormKinds: sortUnique(rows.map((row) => row.surfaceFormKind)) as readonly LookupV2CurationDraftRow['surfaceFormKind'][],
        scopeRisks: sortUnique(rows.map((row) => row.scopeRisk)) as readonly LookupV2ManualTargetFamilyReviewPacketRow['scopeRisk'][],
        locales: sortUnique(rows.flatMap((row) => row.locales)) as readonly LookupV2CurationDraftRow['locale'][],
        suggestedAliasTypes: sortUnique(rows.flatMap((row) => row.suggestedAliasTypes)) as readonly LookupV2CurationDraftRow['suggestedAliasType'][],
        holeClasses: sortUnique(rows.flatMap((row) => row.holeClasses)),
        surfaces: sortUnique(rows.flatMap((row) => row.surfaces)),
        sourceArtifacts: sortUnique(rows.flatMap((row) => row.sourceArtifacts)),
        sourceEvidenceSamples: sortUnique(rows.flatMap((row) => row.sourceEvidenceSamples)),
        witnessSources,
        clarificationAxisSignature,
        ...(resolvedRuntimeClarificationAxes.length > 0
          ? { runtimeClarificationAxes: resolvedRuntimeClarificationAxes }
          : {}),
        collisionEntityProducers,
        collisionEntityRegions,
        collisionEntityAppellations,
        producerCardinality: collisionEntityProducers.length,
        regionCardinality: collisionEntityRegions.length,
        appellationCardinality: collisionEntityAppellations.length,
        runtimeCollisionEntityIds: resolvedCollisionEntityIds,
        runtimeCollisionEntityLabels: resolvedCollisionEntityIds.map((entityId) => runtimeOwnerEvidence.entityLabels.get(entityId) ?? entityId),
        ...(collisionScopeDescriptors.length > 0
          ? { runtimeCollisionScopeDescriptors: collisionScopeDescriptors }
          : {}),
        ...(resolvedCollisionWitnesses.length > 0
          ? { runtimeCollisionWitnesses: resolvedCollisionWitnesses }
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
      ...(args.sourceDraftPath !== undefined ? { sourceDraftPath: args.sourceDraftPath } : {}),
      ...(args.sourcePacketPath !== undefined ? { sourcePacketPath: args.sourcePacketPath } : {}),
      generatedAt: args.generatedAt,
      totalRows: clusterRows.reduce((sum, row) => sum + row.familyScopeRows, 0),
      totalReviewScopeRows: clusterRows.reduce((sum, row) => sum + row.reviewScopeRowCount, 0),
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
      ...(args.sourceDraftPath !== undefined ? { sourceDraftPath: args.sourceDraftPath } : {}),
      ...(args.sourcePacketPath !== undefined ? { sourcePacketPath: args.sourcePacketPath } : {}),
      generatedAt: args.generatedAt,
      totalRows: clusterRows.reduce((sum, row) => sum + row.familyScopeRows, 0),
      totalReviewScopeRows: clusterRows.reduce((sum, row) => sum + row.reviewScopeRowCount, 0),
      totalFamilies: clusterRows.length,
      governanceCounts,
    }, null, 2) + '\n',
    'utf8',
  );

  const clarificationOutputDir = path.join(path.dirname(args.outputPath), `${topologyBaseName}-by-clarification-axis`);
  mkdirSync(clarificationOutputDir, { recursive: true });
  const clarificationGroups = new Map<string, LookupV2ReviewedCollisionFamilyClusterRow[]>();
  for (const row of clusterRows) {
    const existing = clarificationGroups.get(row.clarificationAxisSignature) ?? [];
    existing.push(row);
    clarificationGroups.set(row.clarificationAxisSignature, existing);
  }
  const clarificationAxisCounts = Object.fromEntries(
    [...clarificationGroups.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([clarificationAxisSignature, rows]) => [clarificationAxisSignature, rows.length]),
  ) as Readonly<Record<string, number>>;
  for (const [clarificationAxisSignature, rows] of clarificationGroups.entries()) {
    writeFileSync(path.join(clarificationOutputDir, `${clarificationAxisSignature}.jsonl`), serializeJsonl(rows), 'utf8');
  }
  const clarificationIndexPath = path.join(clarificationOutputDir, 'clarification-axis-index.json');
  writeFileSync(
    clarificationIndexPath,
    JSON.stringify({
      ...(args.sourceDraftPath !== undefined ? { sourceDraftPath: args.sourceDraftPath } : {}),
      ...(args.sourcePacketPath !== undefined ? { sourcePacketPath: args.sourcePacketPath } : {}),
      generatedAt: args.generatedAt,
      totalRows: clusterRows.reduce((sum, row) => sum + row.familyScopeRows, 0),
      totalReviewScopeRows: clusterRows.reduce((sum, row) => sum + row.reviewScopeRowCount, 0),
      totalFamilies: clusterRows.length,
      clarificationAxisCounts,
    }, null, 2) + '\n',
    'utf8',
  );

  return {
    ...(args.sourceDraftPath !== undefined ? { sourceDraftPath: args.sourceDraftPath } : {}),
    ...(args.sourcePacketPath !== undefined ? { sourcePacketPath: args.sourcePacketPath } : {}),
    generatedAt: args.generatedAt,
    totalRows: clusterRows.reduce((sum, row) => sum + row.familyScopeRows, 0),
    totalReviewScopeRows: clusterRows.reduce((sum, row) => sum + row.reviewScopeRowCount, 0),
    totalFamilies: clusterRows.length,
    outputPath: args.outputPath,
    topologyCounts,
    governanceCounts,
    clarificationAxisCounts,
    topologyOutputDir,
    topologyIndexPath,
    governanceOutputDir,
    governanceIndexPath,
    clarificationOutputDir,
    clarificationIndexPath,
  };
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl') },
      output: { type: 'string', default: lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-reviewed-collision-family-clusters.jsonl') },
      generatedAt: { type: 'string', default: new Date().toISOString() },
    },
  });

  const inputPath = resolveCliDataPathArg(
    values.input ?? lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-entity-no-policy-draft.jsonl'),
  );
  const outputPath = resolveCliDataPathArg(
    values.output ?? lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-reviewed-collision-family-clusters.jsonl'),
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
  console.log(`[elv2-reviewed-collision-family-clusters] total_review_scope_rows=${index.totalReviewScopeRows}`);
  console.log(`[elv2-reviewed-collision-family-clusters] total_families=${index.totalFamilies}`);
  console.log(`[elv2-reviewed-collision-family-clusters] topology_output_dir=${index.topologyOutputDir}`);
  console.log(`[elv2-reviewed-collision-family-clusters] governance_output_dir=${index.governanceOutputDir}`);
  console.log(`[elv2-reviewed-collision-family-clusters] clarification_output_dir=${index.clarificationOutputDir}`);
  console.log(`[elv2-reviewed-collision-family-clusters] output=${index.outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

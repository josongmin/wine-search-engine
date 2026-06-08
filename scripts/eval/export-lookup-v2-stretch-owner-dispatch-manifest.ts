import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { LookupV2ManualTargetFamilyReviewPacketRow } from './export-lookup-v2-manual-target-family-review-packet.js';
import type { LookupV2ManualTargetOwnerEvidenceFamilyClusterRow } from './export-lookup-v2-manual-target-owner-family-clusters.js';
import type { LookupV2ReviewedCollisionFamilyClusterRow } from './export-lookup-v2-reviewed-collision-family-clusters.js';
import { lookupV2DraftCliPath, resolveCliDataPathArg } from './cli-data-path.js';

export type LookupV2StretchOwnerDispatchPacketClass =
  | 'runtime_backfill'
  | 'manual_target_collision'
  | 'reviewed_collision_scope';

export interface LookupV2StretchOwnerDispatchReviewTemplateCandidateEntity {
  readonly entityId: string;
  readonly entityLabel?: string | undefined;
  readonly lineKey?: string | undefined;
  readonly regionKey?: string | undefined;
  readonly appellationKey?: string | undefined;
  readonly vintage?: number | undefined;
}

export interface LookupV2StretchOwnerDispatchReviewTemplateRow {
  readonly reviewScopeKey: string;
  readonly legacyReviewScopeKeys: readonly string[];
  readonly benchmarkGoldHint: string;
  readonly proposalStatus: LookupV2ManualTargetFamilyReviewPacketRow['proposalStatus'];
  readonly reviewTarget: LookupV2ManualTargetFamilyReviewPacketRow['reviewTarget'];
  readonly scopeAxis: LookupV2ManualTargetFamilyReviewPacketRow['scopeAxis'];
  readonly scopeRisk: LookupV2ManualTargetFamilyReviewPacketRow['scopeRisk'];
  readonly surfaces: readonly string[];
  readonly holeClasses: readonly string[];
  readonly suggestedAliasTypes: readonly LookupV2ManualTargetFamilyReviewPacketRow['scopeSuggestedAliasType'][];
  readonly candidateEntities: readonly LookupV2StretchOwnerDispatchReviewTemplateCandidateEntity[];
  readonly decisionTemplate: {
    readonly decision: '<assign_target|reject>';
    readonly entityId: '<required when decision=assign_target>';
    readonly reviewedBy: '<reviewer>';
    readonly decisionReason: '<why>';
    readonly reviewedAt: '<ISO-8601>';
  };
}

export interface LookupV2StretchOwnerDispatchReviewTemplate {
  readonly packetId: string;
  readonly packetClass: Exclude<LookupV2StretchOwnerDispatchPacketClass, 'runtime_backfill'>;
  readonly reviewTarget: 'lookup_manual_target_resolution_v1' | 'lookup_reviewed_collision_resolution_v1';
  readonly sourcePacketPath: string;
  readonly decisionInputPath: string;
  readonly reviewedOutputPath: string;
  readonly registryOutputPath: string;
  readonly instructions: readonly string[];
  readonly rows: readonly LookupV2StretchOwnerDispatchReviewTemplateRow[];
}

export interface LookupV2StretchOwnerDispatchPacket {
  readonly packetId: string;
  readonly packetClass: LookupV2StretchOwnerDispatchPacketClass;
  readonly dispatchSignature: string;
  readonly dispatchLane: 'runtime_catalog_backfill' | 'semantic_scope_target_review';
  readonly inputArtifact: string;
  readonly sourceJsonlPath: string;
  readonly decisionInputPath?: string | undefined;
  readonly reviewedOutputPath?: string | undefined;
  readonly registryOutputPath?: string | undefined;
  readonly reviewTemplatePath?: string | undefined;
  readonly handoffPath: string;
  readonly reviewTarget?: 'lookup_manual_target_resolution_v1' | 'lookup_reviewed_collision_resolution_v1' | undefined;
  readonly familyCount: number;
  readonly rowCount: number;
  readonly benchmarkGoldHints: readonly string[];
  readonly reviewCommands: readonly string[];
  readonly rerunCommands: readonly string[];
  readonly families:
    | readonly LookupV2ManualTargetOwnerEvidenceFamilyClusterRow[]
    | readonly LookupV2ReviewedCollisionFamilyClusterRow[];
}

export interface LookupV2StretchOwnerDispatchManifest {
  readonly generatedAt: string;
  readonly inputArtifact: string;
  readonly outputDir: string;
  readonly totalPackets: number;
  readonly packetClassCounts: Readonly<Record<LookupV2StretchOwnerDispatchPacketClass, number>>;
  readonly packets: readonly LookupV2StretchOwnerDispatchPacket[];
}

function parseJsonlRows<T>(filePath: string): readonly T[] {
  const raw = readFileSync(filePath, 'utf8').trim();
  if (raw.length === 0) {
    return [];
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

function sortUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function buildGapReasonFileStem(signature: string): string {
  return signature
    .replaceAll('+', '__')
    .replaceAll('_', '-');
}

function slugifyDispatchSignature(value: string): string {
  return value
    .replaceAll(/[^a-z0-9]+/giu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .toLowerCase();
}

function buildCoverageRerunCommand(inputArtifact: string): string {
  return [
    'node',
    '--import',
    'tsx',
    'scripts/eval/run-lookup-v2-coverage-report.ts',
    '--use-active-runtime',
    '--corpus',
    'test/fixtures/lookup-v2-korean-realworld-stretch.jsonl',
    '--partition',
    'entity-no-policy',
    '--output',
    inputArtifact,
  ].join(' ');
}

function buildHandoffMarkdown(args: {
  readonly packet: LookupV2StretchOwnerDispatchPacket;
  readonly reviewTemplate?: LookupV2StretchOwnerDispatchReviewTemplate | undefined;
}): string {
  const lines: string[] = [
    `# ${args.packet.packetId}`,
    '',
    `- packetClass: \`${args.packet.packetClass}\``,
    `- dispatchLane: \`${args.packet.dispatchLane}\``,
    `- dispatchSignature: \`${args.packet.dispatchSignature}\``,
    `- familyCount: ${args.packet.familyCount}`,
    `- rowCount: ${args.packet.rowCount}`,
    `- inputArtifact: \`${args.packet.inputArtifact}\``,
    `- sourceJsonlPath: \`${args.packet.sourceJsonlPath}\``,
  ];

  if (args.packet.reviewTarget !== undefined) {
    lines.push(`- reviewTarget: \`${args.packet.reviewTarget}\``);
  }
  if (args.packet.decisionInputPath !== undefined) {
    lines.push(`- decisionInputPath: \`${args.packet.decisionInputPath}\``);
  }
  if (args.packet.reviewTemplatePath !== undefined) {
    lines.push(`- reviewTemplatePath: \`${args.packet.reviewTemplatePath}\``);
  }
  if (args.packet.reviewedOutputPath !== undefined) {
    lines.push(`- reviewedOutputPath: \`${args.packet.reviewedOutputPath}\``);
  }
  if (args.packet.registryOutputPath !== undefined) {
    lines.push(`- registryOutputPath: \`${args.packet.registryOutputPath}\``);
  }

  lines.push('');
  lines.push('## Execution');
  lines.push('');
  if (args.packet.packetClass === 'runtime_backfill') {
    lines.push('- Do not write semantic scope target registry for this packet.');
    lines.push('- Repair runtime/catalog ownership so the missing family or requested vintage exists in active runtime.');
  } else {
    lines.push('- Fill the review template first, then emit final decision JSONL at `decisionInputPath`.');
    lines.push('- Run both review commands in order, then rerun refresh and coverage.');
  }

  lines.push('');
  lines.push('## Commands');
  lines.push('');
  if (args.packet.reviewCommands.length > 0) {
    for (const command of args.packet.reviewCommands) {
      lines.push('```sh');
      lines.push(command);
      lines.push('```');
    }
  } else {
    lines.push('_No direct review commands for this packet._');
  }
  for (const command of args.packet.rerunCommands) {
    lines.push('```sh');
    lines.push(command);
    lines.push('```');
  }

  if (args.reviewTemplate !== undefined) {
    lines.push('');
    lines.push('## Review Template Rows');
    lines.push('');
    lines.push(`- rows: ${args.reviewTemplate.rows.length}`);
    for (const row of args.reviewTemplate.rows) {
      const candidateSummary = row.candidateEntities.length > 0
        ? row.candidateEntities
          .map((candidate) => {
            const scopeBits = [
              candidate.lineKey,
              candidate.regionKey,
              candidate.appellationKey,
              candidate.vintage !== undefined ? String(candidate.vintage) : undefined,
            ].filter((value): value is string => value !== undefined && value.length > 0);
            return scopeBits.length > 0
              ? `${candidate.entityId} (${candidate.entityLabel ?? 'unknown'} | ${scopeBits.join(' / ')})`
              : `${candidate.entityId} (${candidate.entityLabel ?? 'unknown'})`;
          })
          .join('; ')
        : 'none';
      lines.push(`- \`${row.reviewScopeKey}\` :: hint=\`${row.benchmarkGoldHint}\` :: candidates=${candidateSummary}`);
    }
  }

  lines.push('');
  lines.push('## Families');
  lines.push('');
  for (const family of args.packet.families) {
    if ('runtimeGapReasonSignature' in family || args.packet.packetClass === 'runtime_backfill') {
      const gapBits = family.runtimeGapReasonSignature !== undefined
        ? [`gap=${family.runtimeGapReasonSignature}`]
        : [];
      if ('runtimeGapAvailableVintages' in family && family.runtimeGapAvailableVintages !== undefined && family.runtimeGapAvailableVintages.length > 0) {
        gapBits.push(`available_vintages=${family.runtimeGapAvailableVintages.join(',')}`);
      }
      lines.push(`- \`${family.benchmarkGoldHint}\` :: ${gapBits.join(' :: ') || 'runtime gap'}`);
      continue;
    }
    if ('clarificationAxisSignature' in family) {
      const candidateLabels = family.runtimeCollisionEntityLabels.join('; ');
      lines.push(
        `- \`${family.benchmarkGoldHint}\` :: axes=\`${family.clarificationAxisSignature}\` :: reviewScopeRows=${family.reviewScopeRowCount} :: candidates=${candidateLabels}`,
      );
      continue;
    }
    const collisionLabels = family.runtimeCollisionEntityLabels?.join('; ') ?? '';
    lines.push(
      `- \`${family.benchmarkGoldHint}\` :: status=\`${family.runtimeEvidenceStatus}\` :: reviewScopeRows=${family.familyReviewRowCount} :: candidates=${collisionLabels || 'none'}`,
    );
  }

  return lines.join('\n') + '\n';
}

function buildRefreshWritePlaneCommand(inputArtifact: string, outputDir: string): string {
  return [
    'node',
    '--import',
    'tsx',
    'scripts/eval/refresh-lookup-v2-stretch-write-plane.ts',
    '--input',
    inputArtifact,
    '--outputDir',
    outputDir,
  ].join(' ');
}

function buildRuntimeBackfillPacket(args: {
  readonly inputArtifact: string;
  readonly outputDir: string;
  readonly packetsDir: string;
  readonly sourceJsonlPath: string;
  readonly dispatchSignature: string;
  readonly families: readonly LookupV2ManualTargetOwnerEvidenceFamilyClusterRow[];
}): LookupV2StretchOwnerDispatchPacket {
  const packetId = `runtime-backfill-${slugifyDispatchSignature(args.dispatchSignature)}`;
  return {
    packetId,
    packetClass: 'runtime_backfill',
    dispatchSignature: args.dispatchSignature,
    dispatchLane: 'runtime_catalog_backfill',
    inputArtifact: args.inputArtifact,
    sourceJsonlPath: args.sourceJsonlPath,
    handoffPath: path.join(args.packetsDir, `${packetId}.handoff.md`),
    familyCount: args.families.length,
    rowCount: args.families.reduce((sum, row) => sum + row.rowCount, 0),
    benchmarkGoldHints: sortUnique(args.families.map((row) => row.benchmarkGoldHint)),
    reviewCommands: [],
    rerunCommands: [
      buildCoverageRerunCommand(args.inputArtifact),
      buildRefreshWritePlaneCommand(args.inputArtifact, args.outputDir),
    ],
    families: args.families,
  };
}

function buildSemanticScopeReviewCommands(args: {
  readonly packetInputPath: string;
  readonly decisionInputPath: string;
  readonly reviewedOutputPath: string;
  readonly registryOutputPath: string;
}): readonly string[] {
  return [
    [
      'node',
      '--import',
      'tsx',
      'scripts/eval/review-lookup-v2-manual-target-family-review-packet.ts',
      '--input',
      args.packetInputPath,
      '--decisions',
      args.decisionInputPath,
      '--output',
      args.reviewedOutputPath,
    ].join(' '),
    [
      'node',
      '--import',
      'tsx',
      'scripts/eval/apply-lookup-v2-semantic-scope-target-registry.ts',
      '--input',
      args.reviewedOutputPath,
      '--output',
      args.registryOutputPath,
    ].join(' '),
  ];
}

function buildManualTargetCollisionPacket(args: {
  readonly inputArtifact: string;
  readonly outputDir: string;
  readonly packetsDir: string;
  readonly sourceJsonlPath: string;
  readonly packetInputPath: string;
  readonly dispatchSignature: string;
  readonly families: readonly LookupV2ManualTargetOwnerEvidenceFamilyClusterRow[];
}): LookupV2StretchOwnerDispatchPacket {
  const packetSlug = `manual-target-collision-${slugifyDispatchSignature(args.dispatchSignature)}`;
  const decisionInputPath = path.join(args.outputDir, `${packetSlug}.review-decisions.jsonl`);
  const reviewedOutputPath = path.join(args.outputDir, `${packetSlug}.reviewed.jsonl`);
  const registryOutputPath = path.join(args.outputDir, `${packetSlug}.semantic-scope-target-registry.jsonl`);
  const reviewTemplatePath = path.join(args.packetsDir, `${packetSlug}.review-template.json`);
  return {
    packetId: packetSlug,
    packetClass: 'manual_target_collision',
    dispatchSignature: args.dispatchSignature,
    dispatchLane: 'semantic_scope_target_review',
    inputArtifact: args.inputArtifact,
    sourceJsonlPath: args.sourceJsonlPath,
    decisionInputPath,
    reviewedOutputPath,
    registryOutputPath,
    reviewTemplatePath,
    handoffPath: path.join(args.packetsDir, `${packetSlug}.handoff.md`),
    reviewTarget: 'lookup_manual_target_resolution_v1',
    familyCount: args.families.length,
    rowCount: args.families.reduce((sum, row) => sum + row.rowCount, 0),
    benchmarkGoldHints: sortUnique(args.families.map((row) => row.benchmarkGoldHint)),
    reviewCommands: buildSemanticScopeReviewCommands({
      packetInputPath: args.packetInputPath,
      decisionInputPath,
      reviewedOutputPath,
      registryOutputPath,
    }),
    rerunCommands: [
      buildRefreshWritePlaneCommand(args.inputArtifact, args.outputDir),
      buildCoverageRerunCommand(args.inputArtifact),
    ],
    families: args.families,
  };
}

function buildReviewedCollisionPacket(args: {
  readonly inputArtifact: string;
  readonly outputDir: string;
  readonly packetsDir: string;
  readonly sourceJsonlPath: string;
  readonly packetInputPath: string;
  readonly dispatchSignature: string;
  readonly families: readonly LookupV2ReviewedCollisionFamilyClusterRow[];
}): LookupV2StretchOwnerDispatchPacket {
  const packetSlug = `reviewed-collision-${slugifyDispatchSignature(args.dispatchSignature)}`;
  const decisionInputPath = path.join(args.outputDir, `${packetSlug}.review-decisions.jsonl`);
  const reviewedOutputPath = path.join(args.outputDir, `${packetSlug}.reviewed.jsonl`);
  const registryOutputPath = path.join(args.outputDir, `${packetSlug}.semantic-scope-target-registry.jsonl`);
  const reviewTemplatePath = path.join(args.packetsDir, `${packetSlug}.review-template.json`);
  return {
    packetId: packetSlug,
    packetClass: 'reviewed_collision_scope',
    dispatchSignature: args.dispatchSignature,
    dispatchLane: 'semantic_scope_target_review',
    inputArtifact: args.inputArtifact,
    sourceJsonlPath: args.sourceJsonlPath,
    decisionInputPath,
    reviewedOutputPath,
    registryOutputPath,
    reviewTemplatePath,
    handoffPath: path.join(args.packetsDir, `${packetSlug}.handoff.md`),
    reviewTarget: 'lookup_reviewed_collision_resolution_v1',
    familyCount: args.families.length,
    rowCount: args.families.reduce((sum, row) => sum + row.familyScopeRows, 0),
    benchmarkGoldHints: sortUnique(args.families.map((row) => row.benchmarkGoldHint)),
    reviewCommands: buildSemanticScopeReviewCommands({
      packetInputPath: args.packetInputPath,
      decisionInputPath,
      reviewedOutputPath,
      registryOutputPath,
    }),
    rerunCommands: [
      buildRefreshWritePlaneCommand(args.inputArtifact, args.outputDir),
      buildCoverageRerunCommand(args.inputArtifact),
    ],
    families: args.families,
  };
}

function countByPacketClass(
  packets: readonly LookupV2StretchOwnerDispatchPacket[],
): Readonly<Record<LookupV2StretchOwnerDispatchPacketClass, number>> {
  const counts: Record<LookupV2StretchOwnerDispatchPacketClass, number> = {
    runtime_backfill: 0,
    manual_target_collision: 0,
    reviewed_collision_scope: 0,
  };
  for (const packet of packets) {
    counts[packet.packetClass] += 1;
  }
  return counts;
}

function buildCandidateEntityRows(args: {
  readonly entityIds: readonly string[] | undefined;
  readonly entityLabels: readonly string[] | undefined;
  readonly scopeDescriptors?: readonly LookupV2ReviewedCollisionFamilyClusterRow['runtimeCollisionScopeDescriptors'] | undefined;
}): readonly LookupV2StretchOwnerDispatchReviewTemplateCandidateEntity[] {
  const labelById = new Map<string, string>();
  for (const [index, entityId] of (args.entityIds ?? []).entries()) {
    const entityLabel = args.entityLabels?.[index];
    if (entityLabel !== undefined) {
      labelById.set(entityId, entityLabel);
    }
  }
  const descriptorById = new Map<string, NonNullable<LookupV2ReviewedCollisionFamilyClusterRow['runtimeCollisionScopeDescriptors']>[number]>();
  for (const descriptor of args.scopeDescriptors ?? []) {
    descriptorById.set(descriptor.entityId, descriptor);
  }

  return sortUnique(args.entityIds ?? []).map((entityId) => {
    const descriptor = descriptorById.get(entityId);
    return {
      entityId,
      ...(labelById.get(entityId) !== undefined ? { entityLabel: labelById.get(entityId) } : {}),
      ...(descriptor?.lineKey !== undefined ? { lineKey: descriptor.lineKey } : {}),
      ...(descriptor?.regionKey !== undefined ? { regionKey: descriptor.regionKey } : {}),
      ...(descriptor?.appellationKey !== undefined ? { appellationKey: descriptor.appellationKey } : {}),
      ...(descriptor?.vintage !== undefined ? { vintage: descriptor.vintage } : {}),
    };
  });
}

function buildReviewTemplateRows(args: {
  readonly packetRows: readonly LookupV2ManualTargetFamilyReviewPacketRow[];
  readonly candidateEntitiesByReviewScopeKey: ReadonlyMap<string, readonly LookupV2StretchOwnerDispatchReviewTemplateCandidateEntity[]>;
}): readonly LookupV2StretchOwnerDispatchReviewTemplateRow[] {
  return args.packetRows.map((row) => ({
    reviewScopeKey: row.reviewScopeKey,
    legacyReviewScopeKeys: row.legacyReviewScopeKeys ?? [],
    benchmarkGoldHint: row.benchmarkGoldHint,
    proposalStatus: row.proposalStatus,
    reviewTarget: row.reviewTarget,
    scopeAxis: row.scopeAxis,
    scopeRisk: row.scopeRisk,
    surfaces: row.surfaces,
    holeClasses: row.holeClasses,
    suggestedAliasTypes: row.suggestedAliasTypes,
    candidateEntities: args.candidateEntitiesByReviewScopeKey.get(row.reviewScopeKey) ?? [],
    decisionTemplate: {
      decision: '<assign_target|reject>',
      entityId: '<required when decision=assign_target>',
      reviewedBy: '<reviewer>',
      decisionReason: '<why>',
      reviewedAt: '<ISO-8601>',
    },
  }));
}

function buildManualTargetCollisionReviewTemplate(args: {
  readonly packet: LookupV2StretchOwnerDispatchPacket & {
    readonly decisionInputPath: string;
    readonly reviewedOutputPath: string;
    readonly registryOutputPath: string;
    readonly reviewTemplatePath: string;
    readonly reviewTarget: 'lookup_manual_target_resolution_v1';
    readonly families: readonly LookupV2ManualTargetOwnerEvidenceFamilyClusterRow[];
  };
  readonly packetInputPath: string;
}): LookupV2StretchOwnerDispatchReviewTemplate {
  const packetRows = parseJsonlRows<LookupV2ManualTargetFamilyReviewPacketRow>(args.packetInputPath);
  const reviewScopeKeySet = new Set(args.packet.families.flatMap((row) => row.reviewScopeKeys));
  const filteredPacketRows = packetRows.filter((row) => reviewScopeKeySet.has(row.reviewScopeKey));
  const candidateEntitiesByReviewScopeKey = new Map<string, readonly LookupV2StretchOwnerDispatchReviewTemplateCandidateEntity[]>();
  for (const family of args.packet.families) {
    const candidates = buildCandidateEntityRows({
      entityIds: family.runtimeCollisionEntityIds,
      entityLabels: family.runtimeCollisionEntityLabels,
    });
    for (const reviewScopeKey of family.reviewScopeKeys) {
      candidateEntitiesByReviewScopeKey.set(reviewScopeKey, candidates);
    }
  }

  return {
    packetId: args.packet.packetId,
    packetClass: 'manual_target_collision',
    reviewTarget: args.packet.reviewTarget,
    sourcePacketPath: args.packetInputPath,
    decisionInputPath: args.packet.decisionInputPath,
    reviewedOutputPath: args.packet.reviewedOutputPath,
    registryOutputPath: args.packet.registryOutputPath,
    instructions: [
      'Select one entity per reviewScopeKey or reject when no safe single target exists.',
      'Copy each row into decisionInputPath as final JSONL after replacing template placeholders.',
    ],
    rows: buildReviewTemplateRows({
      packetRows: filteredPacketRows,
      candidateEntitiesByReviewScopeKey,
    }),
  };
}

function buildReviewedCollisionReviewTemplate(args: {
  readonly packet: LookupV2StretchOwnerDispatchPacket & {
    readonly decisionInputPath: string;
    readonly reviewedOutputPath: string;
    readonly registryOutputPath: string;
    readonly reviewTemplatePath: string;
    readonly reviewTarget: 'lookup_reviewed_collision_resolution_v1';
    readonly families: readonly LookupV2ReviewedCollisionFamilyClusterRow[];
  };
  readonly packetInputPath: string;
}): LookupV2StretchOwnerDispatchReviewTemplate {
  const packetRows = parseJsonlRows<LookupV2ManualTargetFamilyReviewPacketRow>(args.packetInputPath);
  const reviewScopeKeySet = new Set(args.packet.families.flatMap((row) => row.reviewScopeKeys));
  const filteredPacketRows = packetRows.filter((row) => reviewScopeKeySet.has(row.reviewScopeKey));
  const candidateEntitiesByReviewScopeKey = new Map<string, readonly LookupV2StretchOwnerDispatchReviewTemplateCandidateEntity[]>();
  for (const family of args.packet.families) {
    const candidates = buildCandidateEntityRows({
      entityIds: family.runtimeCollisionEntityIds,
      entityLabels: family.runtimeCollisionEntityLabels,
      scopeDescriptors: family.runtimeCollisionScopeDescriptors,
    });
    for (const reviewScopeKey of family.reviewScopeKeys) {
      candidateEntitiesByReviewScopeKey.set(reviewScopeKey, candidates);
    }
  }

  return {
    packetId: args.packet.packetId,
    packetClass: 'reviewed_collision_scope',
    reviewTarget: args.packet.reviewTarget,
    sourcePacketPath: args.packetInputPath,
    decisionInputPath: args.packet.decisionInputPath,
    reviewedOutputPath: args.packet.reviewedOutputPath,
    registryOutputPath: args.packet.registryOutputPath,
    instructions: [
      'Resolve each reviewed collision scope onto one active entity or reject when no safe target exists.',
      'Use clarification axes and runtime collision descriptors to keep scope ownership exact-safe.',
      'Copy each row into decisionInputPath as final JSONL after replacing template placeholders.',
    ],
    rows: buildReviewTemplateRows({
      packetRows: filteredPacketRows,
      candidateEntitiesByReviewScopeKey,
    }),
  };
}

export function writeLookupV2StretchOwnerDispatchManifest(args: {
  readonly inputArtifact: string;
  readonly outputDir: string;
  readonly generatedAt: string;
  readonly manualTargetCollisionSourcePath: string;
  readonly manualTargetCollisionPacketPath: string;
  readonly runtimeBackfillByGapReasonDir: string;
  readonly reviewedCollisionByClarificationAxisDir: string;
  readonly reviewedCollisionPacketPath: string;
  readonly manifestPath: string;
  readonly packetsDir: string;
}): LookupV2StretchOwnerDispatchManifest {
  const runtimeBackfillPackets = path.join(args.runtimeBackfillByGapReasonDir, 'gap-reason-index.json');
  const runtimeBackfillIndex = JSON.parse(readFileSync(runtimeBackfillPackets, 'utf8')) as {
    readonly gapReasonSignatureCounts?: Readonly<Record<string, number>>;
  };
  const clarificationIndexPath = path.join(args.reviewedCollisionByClarificationAxisDir, 'clarification-axis-index.json');
  const clarificationIndex = JSON.parse(readFileSync(clarificationIndexPath, 'utf8')) as {
    readonly clarificationAxisCounts?: Readonly<Record<string, number>>;
  };

  const packets: LookupV2StretchOwnerDispatchPacket[] = [];

  for (const dispatchSignature of Object.keys(runtimeBackfillIndex.gapReasonSignatureCounts ?? {}).sort((left, right) => left.localeCompare(right))) {
    const sourceJsonlPath = path.join(
      args.runtimeBackfillByGapReasonDir,
      `${buildGapReasonFileStem(dispatchSignature)}.jsonl`,
    );
    const families = parseJsonlRows<LookupV2ManualTargetOwnerEvidenceFamilyClusterRow>(sourceJsonlPath);
    if (families.length === 0) {
      continue;
    }
    packets.push(buildRuntimeBackfillPacket({
      inputArtifact: args.inputArtifact,
      outputDir: args.outputDir,
      packetsDir: args.packetsDir,
      sourceJsonlPath,
      dispatchSignature,
      families,
    }));
  }

  const manualTargetCollisionFamilies =
    parseJsonlRows<LookupV2ManualTargetOwnerEvidenceFamilyClusterRow>(args.manualTargetCollisionSourcePath);
  if (manualTargetCollisionFamilies.length > 0) {
    packets.push(buildManualTargetCollisionPacket({
      inputArtifact: args.inputArtifact,
      outputDir: args.outputDir,
      packetsDir: args.packetsDir,
      sourceJsonlPath: args.manualTargetCollisionSourcePath,
      packetInputPath: args.manualTargetCollisionPacketPath,
      dispatchSignature: 'collision_candidates',
      families: manualTargetCollisionFamilies,
    }));
  }

  for (const dispatchSignature of Object.keys(clarificationIndex.clarificationAxisCounts ?? {}).sort((left, right) => left.localeCompare(right))) {
    const sourceJsonlPath = path.join(args.reviewedCollisionByClarificationAxisDir, `${dispatchSignature}.jsonl`);
    const families = parseJsonlRows<LookupV2ReviewedCollisionFamilyClusterRow>(sourceJsonlPath);
    if (families.length === 0) {
      continue;
    }
    packets.push(buildReviewedCollisionPacket({
      inputArtifact: args.inputArtifact,
      outputDir: args.outputDir,
      packetsDir: args.packetsDir,
      sourceJsonlPath,
      packetInputPath: args.reviewedCollisionPacketPath,
      dispatchSignature,
      families,
    }));
  }

  const sortedPackets = packets.sort((left, right) =>
    left.packetClass.localeCompare(right.packetClass)
    || left.dispatchSignature.localeCompare(right.dispatchSignature)
    || left.packetId.localeCompare(right.packetId),
  );

  mkdirSync(path.dirname(args.manifestPath), { recursive: true });
  mkdirSync(args.packetsDir, { recursive: true });
  for (const packet of sortedPackets) {
    const reviewTemplate = packet.packetClass === 'manual_target_collision'
      ? buildManualTargetCollisionReviewTemplate({
          packet: packet as LookupV2StretchOwnerDispatchPacket & {
            readonly decisionInputPath: string;
            readonly reviewedOutputPath: string;
            readonly registryOutputPath: string;
            readonly reviewTemplatePath: string;
            readonly reviewTarget: 'lookup_manual_target_resolution_v1';
            readonly families: readonly LookupV2ManualTargetOwnerEvidenceFamilyClusterRow[];
          },
          packetInputPath: args.manualTargetCollisionPacketPath,
        })
      : packet.packetClass === 'reviewed_collision_scope'
        ? buildReviewedCollisionReviewTemplate({
            packet: packet as LookupV2StretchOwnerDispatchPacket & {
              readonly decisionInputPath: string;
              readonly reviewedOutputPath: string;
              readonly registryOutputPath: string;
              readonly reviewTemplatePath: string;
              readonly reviewTarget: 'lookup_reviewed_collision_resolution_v1';
              readonly families: readonly LookupV2ReviewedCollisionFamilyClusterRow[];
            },
            packetInputPath: args.reviewedCollisionPacketPath,
          })
        : undefined;

    writeFileSync(
      path.join(args.packetsDir, `${packet.packetId}.json`),
      JSON.stringify(packet, null, 2) + '\n',
      'utf8',
    );
    if (reviewTemplate !== undefined && packet.reviewTemplatePath !== undefined) {
      writeFileSync(packet.reviewTemplatePath, JSON.stringify(reviewTemplate, null, 2) + '\n', 'utf8');
    }
    writeFileSync(
      packet.handoffPath,
      buildHandoffMarkdown({
        packet,
        reviewTemplate,
      }),
      'utf8',
    );
  }

  const manifest: LookupV2StretchOwnerDispatchManifest = {
    generatedAt: args.generatedAt,
    inputArtifact: args.inputArtifact,
    outputDir: args.outputDir,
    totalPackets: sortedPackets.length,
    packetClassCounts: countByPacketClass(sortedPackets),
    packets: sortedPackets,
  };
  writeFileSync(args.manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      inputArtifact: { type: 'string', default: '/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy.json' },
      outputDir: { type: 'string', default: lookupV2DraftCliPath() },
      generatedAt: { type: 'string', default: new Date().toISOString() },
      manualTargetCollisionSource: { type: 'string', default: lookupV2DraftCliPath('manual-target-owner-evidence/collision-candidate-families.jsonl') },
      manualTargetCollisionPacket: { type: 'string', default: lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl') },
      runtimeBackfillByGapReasonDir: { type: 'string', default: lookupV2DraftCliPath('manual-target-owner-evidence/missing-runtime-owner-families-by-gap-reason') },
      reviewedCollisionByClarificationAxisDir: { type: 'string', default: lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-reviewed-collision-family-clusters-by-clarification-axis') },
      reviewedCollisionPacket: { type: 'string', default: lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-reviewed-collision-family-review-packet.jsonl') },
      manifest: { type: 'string', default: lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-owner-dispatch-manifest.json') },
      packetsDir: { type: 'string', default: lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-owner-dispatch-packets') },
    },
  });

  const manifest = writeLookupV2StretchOwnerDispatchManifest({
    inputArtifact: resolveCliDataPathArg(values.inputArtifact ?? '/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy.json'),
    outputDir: resolveCliDataPathArg(values.outputDir ?? lookupV2DraftCliPath()),
    generatedAt: values.generatedAt ?? new Date().toISOString(),
    manualTargetCollisionSourcePath: resolveCliDataPathArg(
      values.manualTargetCollisionSource ?? lookupV2DraftCliPath('manual-target-owner-evidence/collision-candidate-families.jsonl'),
    ),
    manualTargetCollisionPacketPath: resolveCliDataPathArg(
      values.manualTargetCollisionPacket ?? lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl'),
    ),
    runtimeBackfillByGapReasonDir: resolveCliDataPathArg(
      values.runtimeBackfillByGapReasonDir ?? lookupV2DraftCliPath('manual-target-owner-evidence/missing-runtime-owner-families-by-gap-reason'),
    ),
    reviewedCollisionByClarificationAxisDir: resolveCliDataPathArg(
      values.reviewedCollisionByClarificationAxisDir ?? lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-reviewed-collision-family-clusters-by-clarification-axis'),
    ),
    reviewedCollisionPacketPath: resolveCliDataPathArg(
      values.reviewedCollisionPacket ?? lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-reviewed-collision-family-review-packet.jsonl'),
    ),
    manifestPath: resolveCliDataPathArg(
      values.manifest ?? lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-owner-dispatch-manifest.json'),
    ),
    packetsDir: resolveCliDataPathArg(
      values.packetsDir ?? lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-owner-dispatch-packets'),
    ),
  });

  console.log(`[elv2-owner-dispatch] total_packets=${manifest.totalPackets}`);
  console.log(`[elv2-owner-dispatch] packet_class_counts=${JSON.stringify(manifest.packetClassCounts)}`);
  console.log(`[elv2-owner-dispatch] manifest=${resolveCliDataPathArg(values.manifest ?? lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-owner-dispatch-manifest.json'))}`);
  console.log(`[elv2-owner-dispatch] packets_dir=${resolveCliDataPathArg(values.packetsDir ?? lookupV2DraftCliPath('lookup-v2-korean-realworld-stretch-owner-dispatch-packets'))}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

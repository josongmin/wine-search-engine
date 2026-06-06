import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { LookupV2ManualTargetFamilyReviewPacketRow } from './export-lookup-v2-manual-target-family-review-packet.js';

export interface LookupV2ManualTargetRuntimeOwnerPartitionIndex {
  readonly sourcePacketPath: string;
  readonly generatedAt: string;
  readonly totalRows: number;
  readonly candidateUniqueOwnerRows: number;
  readonly collisionCandidateRows: number;
  readonly missingRuntimeOwnerRows: number;
  readonly outputPaths: {
    readonly candidateUniqueOwner: string;
    readonly collisionCandidates: string;
    readonly missingRuntimeOwner: string;
  };
}

function isLookupV2ManualTargetFamilyReviewPacketRow(value: unknown): value is LookupV2ManualTargetFamilyReviewPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['reviewScopeKey'] === 'string'
    && typeof row['runtimeEvidenceStatus'] === 'string'
    && typeof row['proposalStatus'] === 'string'
  );
}

function parsePacketJsonl(filePath: string): readonly LookupV2ManualTargetFamilyReviewPacketRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isLookupV2ManualTargetFamilyReviewPacketRow);
}

function serializeJsonl(rows: readonly unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

export function writeLookupV2ManualTargetRuntimeOwnerPartitions(args: {
  readonly packetRows: readonly LookupV2ManualTargetFamilyReviewPacketRow[];
  readonly sourcePacketPath: string;
  readonly outputDir: string;
  readonly generatedAt: string;
}): LookupV2ManualTargetRuntimeOwnerPartitionIndex {
  const candidateUniqueOwnerRows = args.packetRows.filter((row) => row.runtimeEvidenceStatus === 'candidate_unique_owner');
  const collisionCandidateRows = args.packetRows.filter((row) => row.runtimeEvidenceStatus === 'collision_candidates');
  const missingRuntimeOwnerRows = args.packetRows.filter((row) => row.runtimeEvidenceStatus === 'missing_runtime_owner');

  mkdirSync(args.outputDir, { recursive: true });
  const outputPaths = {
    candidateUniqueOwner: path.join(args.outputDir, 'candidate-unique-owner.jsonl'),
    collisionCandidates: path.join(args.outputDir, 'collision-candidates.jsonl'),
    missingRuntimeOwner: path.join(args.outputDir, 'missing-runtime-owner.jsonl'),
  };

  writeFileSync(outputPaths.candidateUniqueOwner, serializeJsonl(candidateUniqueOwnerRows), 'utf8');
  writeFileSync(outputPaths.collisionCandidates, serializeJsonl(collisionCandidateRows), 'utf8');
  writeFileSync(outputPaths.missingRuntimeOwner, serializeJsonl(missingRuntimeOwnerRows), 'utf8');

  const index: LookupV2ManualTargetRuntimeOwnerPartitionIndex = {
    sourcePacketPath: args.sourcePacketPath,
    generatedAt: args.generatedAt,
    totalRows: args.packetRows.length,
    candidateUniqueOwnerRows: candidateUniqueOwnerRows.length,
    collisionCandidateRows: collisionCandidateRows.length,
    missingRuntimeOwnerRows: missingRuntimeOwnerRows.length,
    outputPaths,
  };
  writeFileSync(path.join(args.outputDir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
  return index;
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl' },
      outputDir: { type: 'string', default: 'data/lookup-v2/drafts/manual-target-owner-evidence' },
      generatedAt: { type: 'string', default: new Date().toISOString() },
    },
  });

  const inputPath = values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl';
  const outputDir = values.outputDir ?? 'data/lookup-v2/drafts/manual-target-owner-evidence';
  const generatedAt = values.generatedAt ?? new Date().toISOString();
  const packetRows = parsePacketJsonl(inputPath);
  const index = writeLookupV2ManualTargetRuntimeOwnerPartitions({
    packetRows,
    sourcePacketPath: inputPath,
    outputDir,
    generatedAt,
  });

  console.log(`[elv2-manual-target-runtime-owner-partitions] total_rows=${index.totalRows}`);
  console.log(`[elv2-manual-target-runtime-owner-partitions] candidate_unique_owner=${index.candidateUniqueOwnerRows}`);
  console.log(`[elv2-manual-target-runtime-owner-partitions] collision_candidates=${index.collisionCandidateRows}`);
  console.log(`[elv2-manual-target-runtime-owner-partitions] missing_runtime_owner=${index.missingRuntimeOwnerRows}`);
  console.log(`[elv2-manual-target-runtime-owner-partitions] output_dir=${outputDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

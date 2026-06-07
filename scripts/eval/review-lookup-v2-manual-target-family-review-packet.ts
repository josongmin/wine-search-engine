import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { LookupV2ManualTargetFamilyReviewPacketRow } from './export-lookup-v2-manual-target-family-review-packet.js';
import { resolveCliDataPathArg } from './cli-data-path.js';

export interface LookupV2ManualTargetFamilyReviewDecisionRow {
  readonly reviewScopeKey: string;
  readonly benchmarkGoldHint: string;
  readonly decision: 'assign_target' | 'reject';
  readonly entityId?: string | undefined;
  readonly reviewedBy: string;
  readonly decisionReason: string;
  readonly reviewedAt: string;
}

export interface LookupV2ManualTargetFamilyReviewDecisionApplyResult {
  readonly reviewedRows: readonly LookupV2ManualTargetFamilyReviewPacketRow[];
  readonly matchedDecisionRows: number;
  readonly staleDecisionRows: number;
  readonly ambiguousLegacyDecisionRows: number;
}

function isLookupV2ManualTargetFamilyReviewPacketRow(value: unknown): value is LookupV2ManualTargetFamilyReviewPacketRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['reviewScopeKey'] === 'string'
    && typeof row['benchmarkGoldHint'] === 'string'
    && typeof row['normalizedBenchmarkGoldHint'] === 'string'
    && typeof row['proposalStatus'] === 'string'
    && typeof row['reviewTarget'] === 'string'
    && Array.isArray(row['surfaces'])
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

function isDecisionRow(value: unknown): value is LookupV2ManualTargetFamilyReviewDecisionRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row['reviewScopeKey'] === 'string'
    && typeof row['benchmarkGoldHint'] === 'string'
    && (row['decision'] === 'assign_target' || row['decision'] === 'reject')
    && (row['entityId'] === undefined || typeof row['entityId'] === 'string')
    && typeof row['reviewedBy'] === 'string'
    && typeof row['decisionReason'] === 'string'
    && typeof row['reviewedAt'] === 'string'
  );
}

function parseDecisionJsonl(filePath: string): readonly LookupV2ManualTargetFamilyReviewDecisionRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isDecisionRow);
}

function validateDecisionRow(row: LookupV2ManualTargetFamilyReviewDecisionRow): void {
  if (row.reviewedBy.trim().length === 0) {
    throw new Error(`manual-target family decision missing reviewedBy for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
  }
  if (row.decisionReason.trim().length === 0) {
    throw new Error(`manual-target family decision missing decisionReason for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
  }
  if (Number.isNaN(Date.parse(row.reviewedAt))) {
    throw new Error(`manual-target family decision has invalid reviewedAt for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
  }
  if (row.decision === 'assign_target') {
    if (row.entityId === undefined || row.entityId.trim().length === 0) {
      throw new Error(`manual-target family assign_target decision is missing entityId for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
    }
    return;
  }
  if (row.entityId !== undefined && row.entityId.trim().length > 0) {
    throw new Error(`manual-target family reject decision must not carry entityId for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
  }
}

function buildDecisionActionKey(row: LookupV2ManualTargetFamilyReviewDecisionRow): string {
  return row.decision === 'assign_target'
    ? `assign_target::${row.entityId ?? ''}`
    : 'reject';
}

function pickEffectiveDecision(
  semanticScopeKey: string,
  rows: readonly LookupV2ManualTargetFamilyReviewDecisionRow[],
): LookupV2ManualTargetFamilyReviewDecisionRow {
  const exemplar = rows[0];
  if (exemplar === undefined) {
    throw new Error(`manual-target family decision merge received no rows for semanticScopeKey=${JSON.stringify(semanticScopeKey)}`);
  }
  const exemplarActionKey = buildDecisionActionKey(exemplar);
  for (const row of rows) {
    if (buildDecisionActionKey(row) !== exemplarActionKey) {
      throw new Error(`conflicting manual-target family decisions collapse onto semanticScopeKey=${JSON.stringify(semanticScopeKey)}`);
    }
  }
  return [...rows]
    .sort((left, right) => left.reviewedAt.localeCompare(right.reviewedAt))
    .at(-1) ?? exemplar;
}

export function applyLookupV2ManualTargetFamilyReviewDecisions(args: {
  readonly packetRows: readonly LookupV2ManualTargetFamilyReviewPacketRow[];
  readonly decisionRows: readonly LookupV2ManualTargetFamilyReviewDecisionRow[];
}): LookupV2ManualTargetFamilyReviewDecisionApplyResult {
  const packetBySemanticKey = new Map<string, LookupV2ManualTargetFamilyReviewPacketRow>();
  const legacyReviewScopeKeyToSemanticKeys = new Map<string, Set<string>>();
  for (const row of args.packetRows) {
    const semanticKey = row.reviewScopeKey;
    if (packetBySemanticKey.has(semanticKey)) {
      throw new Error(`duplicate manual-target family packet row for reviewScopeKey=${JSON.stringify(row.reviewScopeKey)}`);
    }
    packetBySemanticKey.set(semanticKey, row);
    for (const legacyReviewScopeKey of row.legacyReviewScopeKeys ?? []) {
      const mappedKeys = legacyReviewScopeKeyToSemanticKeys.get(legacyReviewScopeKey) ?? new Set<string>();
      mappedKeys.add(semanticKey);
      legacyReviewScopeKeyToSemanticKeys.set(legacyReviewScopeKey, mappedKeys);
    }
  }

  const decisionRowsBySemanticKey = new Map<string, LookupV2ManualTargetFamilyReviewDecisionRow[]>();
  let matchedDecisionRows = 0;
  let staleDecisionRows = 0;
  let ambiguousLegacyDecisionRows = 0;

  for (const row of args.decisionRows) {
    validateDecisionRow(row);
    const directSemanticRow = packetBySemanticKey.get(row.reviewScopeKey);
    if (directSemanticRow !== undefined) {
      const existing = decisionRowsBySemanticKey.get(directSemanticRow.reviewScopeKey) ?? [];
      existing.push(row);
      decisionRowsBySemanticKey.set(directSemanticRow.reviewScopeKey, existing);
      matchedDecisionRows += 1;
      continue;
    }

    const semanticKeys = [...(legacyReviewScopeKeyToSemanticKeys.get(row.reviewScopeKey) ?? [])];
    if (semanticKeys.length === 0) {
      staleDecisionRows += 1;
      continue;
    }
    if (semanticKeys.length > 1) {
      ambiguousLegacyDecisionRows += 1;
      continue;
    }

    const semanticKey = semanticKeys[0]!;
    const existing = decisionRowsBySemanticKey.get(semanticKey) ?? [];
    existing.push(row);
    decisionRowsBySemanticKey.set(semanticKey, existing);
    matchedDecisionRows += 1;
  }

  const effectiveDecisionBySemanticKey = new Map<string, LookupV2ManualTargetFamilyReviewDecisionRow>();
  for (const [semanticKey, rows] of decisionRowsBySemanticKey.entries()) {
    effectiveDecisionBySemanticKey.set(semanticKey, pickEffectiveDecision(semanticKey, rows));
  }

  const reviewedRows = args.packetRows.map((row) => {
    const decision = effectiveDecisionBySemanticKey.get(row.reviewScopeKey);
    if (decision === undefined) {
      return row;
    }
    if (row.proposalStatus !== 'needs_target_review') {
      throw new Error(`cannot re-review manual-target family row with status=${row.proposalStatus} for hint=${JSON.stringify(row.benchmarkGoldHint)}`);
    }
    return {
      ...row,
      proposalStatus: decision.decision === 'assign_target' ? 'target_assigned' : 'rejected',
      ...(decision.decision === 'assign_target' ? { targetEntityId: decision.entityId } : {}),
      reviewedBy: decision.reviewedBy,
      decisionReason: decision.decisionReason,
      reviewedAt: decision.reviewedAt,
    };
  });

  return {
    reviewedRows,
    matchedDecisionRows,
    staleDecisionRows,
    ambiguousLegacyDecisionRows,
  };
}

function serializeRows(rows: readonly LookupV2ManualTargetFamilyReviewPacketRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl' },
      decisions: { type: 'string' },
      output: { type: 'string', default: '/tmp/lookup-v2-korean-realworld-stretch-manual-target-family-review-reviewed.jsonl' },
    },
  });

  const inputPath = resolveCliDataPathArg(values.input ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl');
  const decisionsPath = values.decisions !== undefined ? resolveCliDataPathArg(values.decisions) : undefined;
  if (decisionsPath === undefined || decisionsPath.length === 0) {
    throw new Error('--decisions is required');
  }
  const outputPath = values.output ?? '/tmp/lookup-v2-korean-realworld-stretch-manual-target-family-review-reviewed.jsonl';
  const packetRows = parsePacketJsonl(inputPath);
  const decisionRows = parseDecisionJsonl(decisionsPath);
  const result = applyLookupV2ManualTargetFamilyReviewDecisions({ packetRows, decisionRows });
  const reviewedRows = result.reviewedRows;

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serializeRows(reviewedRows), 'utf8');

  const assigned = reviewedRows.filter((row) => row.proposalStatus === 'target_assigned').length;
  const rejected = reviewedRows.filter((row) => row.proposalStatus === 'rejected').length;
  const pending = reviewedRows.filter((row) => row.proposalStatus === 'needs_target_review').length;
  console.log(`[elv2-manual-target-family-review] packet_rows=${packetRows.length}`);
  console.log(`[elv2-manual-target-family-review] decision_rows=${decisionRows.length}`);
  console.log(`[elv2-manual-target-family-review] matched_decision_rows=${result.matchedDecisionRows}`);
  console.log(`[elv2-manual-target-family-review] stale_decision_rows=${result.staleDecisionRows}`);
  console.log(`[elv2-manual-target-family-review] ambiguous_legacy_decision_rows=${result.ambiguousLegacyDecisionRows}`);
  console.log(`[elv2-manual-target-family-review] target_assigned=${assigned}`);
  console.log(`[elv2-manual-target-family-review] rejected=${rejected}`);
  console.log(`[elv2-manual-target-family-review] pending=${pending}`);
  console.log(`[elv2-manual-target-family-review] output=${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

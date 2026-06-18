import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  parseTrustedLookupSemanticScopeRuntimeArtifact,
  type LookupSemanticScopeRuntimeArtifact,
  type LookupSemanticScopeRuntimeEntry,
} from '../../src/domain/shared/types/search-snapshot-lookup-semantic-runtime.js';
import {
  DEFAULT_RUNTIME_STATE_PATH,
  loadSearchSnapshotRuntimeState,
} from '../../src/infrastructure/health/search-snapshot-readiness.js';
import { resolveCliDataPathArg } from './cli-data-path.js';
import {
  DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH,
  loadLookupV2SemanticScopeTargetRegistrySync,
  type LookupV2SemanticScopeTargetRegistryRow,
} from './lookup-v2-semantic-scope-target-registry.js';

interface LookupV2ActiveRuntimeSemanticScopeTargetParityMismatch {
  readonly semanticScopeKey: string;
  readonly field:
    | 'entityId'
    | 'scopeAxis'
    | 'familyKey'
    | 'lineKey'
    | 'regionKey'
    | 'appellationKey'
    | 'vintage'
    | 'surfaceFormKind'
    | 'locale';
  readonly registryValue: string | number | null;
  readonly runtimeValue: string | number | null;
}

export interface LookupV2ActiveRuntimeSemanticScopeTargetParitySummary {
  readonly generatedAt: string;
  readonly runtimeStatePath: string;
  readonly runtimeSnapshotId: string;
  readonly runtimeSemanticScopeArtifactPath: string;
  readonly registryPath: string;
  readonly approvedRegistryRows: number;
  readonly runtimeEntries: number;
  readonly missingApprovedScopeKeys: readonly string[];
  readonly mismatchedRows: readonly LookupV2ActiveRuntimeSemanticScopeTargetParityMismatch[];
  readonly parity: boolean;
}

function compareOptionalString(
  semanticScopeKey: string,
  field: LookupV2ActiveRuntimeSemanticScopeTargetParityMismatch['field'],
  registryValue: string | undefined,
  runtimeValue: string | undefined,
): LookupV2ActiveRuntimeSemanticScopeTargetParityMismatch | undefined {
  if ((registryValue ?? null) === (runtimeValue ?? null)) {
    return undefined;
  }
  return {
    semanticScopeKey,
    field,
    registryValue: registryValue ?? null,
    runtimeValue: runtimeValue ?? null,
  };
}

function compareOptionalNumber(
  semanticScopeKey: string,
  field: LookupV2ActiveRuntimeSemanticScopeTargetParityMismatch['field'],
  registryValue: number | undefined,
  runtimeValue: number | undefined,
): LookupV2ActiveRuntimeSemanticScopeTargetParityMismatch | undefined {
  if ((registryValue ?? null) === (runtimeValue ?? null)) {
    return undefined;
  }
  return {
    semanticScopeKey,
    field,
    registryValue: registryValue ?? null,
    runtimeValue: runtimeValue ?? null,
  };
}

function collectEntryMismatches(
  row: LookupV2SemanticScopeTargetRegistryRow & { readonly entityId: string },
  runtimeEntry: LookupSemanticScopeRuntimeEntry,
): readonly LookupV2ActiveRuntimeSemanticScopeTargetParityMismatch[] {
  const mismatches: LookupV2ActiveRuntimeSemanticScopeTargetParityMismatch[] = [];
  if (row.entityId !== runtimeEntry.entityId) {
    mismatches.push({
      semanticScopeKey: row.semanticScopeKey,
      field: 'entityId',
      registryValue: row.entityId,
      runtimeValue: runtimeEntry.entityId,
    });
  }
  if (row.scopeAxis !== runtimeEntry.scopeAxis) {
    mismatches.push({
      semanticScopeKey: row.semanticScopeKey,
      field: 'scopeAxis',
      registryValue: row.scopeAxis,
      runtimeValue: runtimeEntry.scopeAxis,
    });
  }
  if (row.familyKey !== runtimeEntry.familyKey) {
    mismatches.push({
      semanticScopeKey: row.semanticScopeKey,
      field: 'familyKey',
      registryValue: row.familyKey,
      runtimeValue: runtimeEntry.familyKey,
    });
  }
  const optionalStringChecks = [
    compareOptionalString(row.semanticScopeKey, 'lineKey', row.lineKey, runtimeEntry.lineKey),
    compareOptionalString(row.semanticScopeKey, 'regionKey', row.regionKey, runtimeEntry.regionKey),
    compareOptionalString(row.semanticScopeKey, 'appellationKey', row.appellationKey, runtimeEntry.appellationKey),
  ];
  for (const mismatch of optionalStringChecks) {
    if (mismatch !== undefined) {
      mismatches.push(mismatch);
    }
  }
  const vintageMismatch = compareOptionalNumber(
    row.semanticScopeKey,
    'vintage',
    row.vintage,
    runtimeEntry.vintage,
  );
  if (vintageMismatch !== undefined) {
    mismatches.push(vintageMismatch);
  }
  if (row.surfaceFormKind !== runtimeEntry.surfaceFormKind) {
    mismatches.push({
      semanticScopeKey: row.semanticScopeKey,
      field: 'surfaceFormKind',
      registryValue: row.surfaceFormKind,
      runtimeValue: runtimeEntry.surfaceFormKind,
    });
  }
  if (row.locale !== runtimeEntry.locale) {
    mismatches.push({
      semanticScopeKey: row.semanticScopeKey,
      field: 'locale',
      registryValue: row.locale,
      runtimeValue: runtimeEntry.locale,
    });
  }
  return mismatches;
}

export function buildLookupV2ActiveRuntimeSemanticScopeTargetParitySummary(args: {
  readonly runtimeStatePath: string;
  readonly runtimeSnapshotId: string;
  readonly runtimeSemanticScopeArtifactPath: string;
  readonly registryPath: string;
  readonly registryRows: readonly LookupV2SemanticScopeTargetRegistryRow[];
  readonly runtimeArtifact: LookupSemanticScopeRuntimeArtifact;
}): LookupV2ActiveRuntimeSemanticScopeTargetParitySummary {
  const approvedRows = args.registryRows.filter(
    (row): row is LookupV2SemanticScopeTargetRegistryRow & { readonly entityId: string } =>
      row.decisionStatus === 'approved' && row.entityId !== undefined,
  );
  const missingApprovedScopeKeys: string[] = [];
  const mismatchedRows: LookupV2ActiveRuntimeSemanticScopeTargetParityMismatch[] = [];
  for (const row of approvedRows) {
    const runtimeEntry = args.runtimeArtifact.entries[row.semanticScopeKey];
    if (runtimeEntry === undefined) {
      missingApprovedScopeKeys.push(row.semanticScopeKey);
      continue;
    }
    mismatchedRows.push(...collectEntryMismatches(row, runtimeEntry));
  }
  return {
    generatedAt: new Date().toISOString(),
    runtimeStatePath: args.runtimeStatePath,
    runtimeSnapshotId: args.runtimeSnapshotId,
    runtimeSemanticScopeArtifactPath: args.runtimeSemanticScopeArtifactPath,
    registryPath: args.registryPath,
    approvedRegistryRows: approvedRows.length,
    runtimeEntries: Object.keys(args.runtimeArtifact.entries).length,
    missingApprovedScopeKeys,
    mismatchedRows,
    parity: missingApprovedScopeKeys.length === 0 && mismatchedRows.length === 0,
  };
}

export async function verifyLookupV2ActiveRuntimeSemanticScopeTargetParity(args?: {
  readonly runtimeStatePath?: string;
  readonly registryPath?: string;
  readonly outputPath?: string;
}): Promise<LookupV2ActiveRuntimeSemanticScopeTargetParitySummary> {
  const runtimeStatePath = args?.runtimeStatePath ?? DEFAULT_RUNTIME_STATE_PATH;
  const registryPath = args?.registryPath ?? DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH;
  const outputPath = args?.outputPath ?? '/tmp/lookup-v2-active-runtime-semantic-scope-target-parity.json';
  const runtimeState = await loadSearchSnapshotRuntimeState(runtimeStatePath);
  const registryRows = loadLookupV2SemanticScopeTargetRegistrySync(registryPath);
  const runtimeArtifact = parseTrustedLookupSemanticScopeRuntimeArtifact(
    readFileSync(runtimeState.lookupSemanticScopeRuntimePath, 'utf8'),
    runtimeState.lookupSemanticScopeRuntimePath,
  );
  const summary = buildLookupV2ActiveRuntimeSemanticScopeTargetParitySummary({
    runtimeStatePath,
    runtimeSnapshotId: runtimeState.snapshotId,
    runtimeSemanticScopeArtifactPath: runtimeState.lookupSemanticScopeRuntimePath,
    registryPath,
    registryRows,
    runtimeArtifact,
  });
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  if (!summary.parity) {
    throw new Error(
      `active runtime semantic scope target parity failed: missingApprovedScopeKeys=${summary.missingApprovedScopeKeys.length}, mismatchedRows=${summary.mismatchedRows.length}`,
    );
  }
  return summary;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((arg) => arg !== '--');
  const { values } = parseArgs({
    args: argv,
    options: {
      'runtime-state': { type: 'string', default: DEFAULT_RUNTIME_STATE_PATH },
      registry: { type: 'string', default: DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH },
      output: { type: 'string', default: '/tmp/lookup-v2-active-runtime-semantic-scope-target-parity.json' },
    },
  });
  const summary = await verifyLookupV2ActiveRuntimeSemanticScopeTargetParity({
    runtimeStatePath: values['runtime-state'] ?? DEFAULT_RUNTIME_STATE_PATH,
    registryPath: values.registry ?? DEFAULT_LOOKUP_V2_SEMANTIC_SCOPE_TARGET_REGISTRY_PATH,
    outputPath: resolveCliDataPathArg(
      values.output ?? '/tmp/lookup-v2-active-runtime-semantic-scope-target-parity.json',
    ),
  });
  console.log(
    `lookup_v2_active_runtime_semantic_scope_target_parity=passed snapshot=${summary.runtimeSnapshotId} approved=${summary.approvedRegistryRows}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}

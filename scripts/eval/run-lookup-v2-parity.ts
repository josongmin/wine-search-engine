/**
 * Entity Lookup V2 — direct-authority vs full-container parity runner.
 *
 * Executes the shared lookup-direct authority and the full application
 * container's `/v2/entity-lookup` wiring over the labeled corpus, then fails
 * closed when any lookup outcome diverges.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../../src/config/env.js';
import { createLookupDirectContainer } from '../../src/config/container-lookup.js';
import { createContainer } from '../../src/config/container.js';
import { getPgPool } from '../../src/infrastructure/db/pg-pool.js';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../../src/domain/shared/constants/search-snapshot.js';
import { LOOKUP_V2_DEFAULT_MAX_CANDIDATES } from '../../src/interface/http/constants.js';
import {
  DEFAULT_RUNTIME_STATE_PATH,
  loadSearchSnapshotRuntimeState,
} from '../../src/infrastructure/health/search-snapshot-readiness.js';
import {
  EVAL_RUNTIME_BINDING_OPTIONS,
  requireExplicitEvalRuntimeBinding,
  resolveEvalRuntimeBinding,
} from './runtime-binding-args.js';
import {
  buildParityReport,
  type LookupEvalStatus,
  type LookupEvalSideOutcome,
  type ParityRow,
} from './lookup-v2-parity-metrics.js';
import {
  filterLookupV2StretchRows,
  isLookupV2StretchPartition,
  type LookupV2StretchPartition,
} from './lookup-v2-stretch-partitions.js';

interface CorpusRow {
  readonly qid: string;
  readonly query: string;
  readonly expectedStatus: LookupEvalStatus;
  readonly accepted_statuses?: readonly LookupEvalStatus[] | undefined;
  readonly expected_entity_hint?: string;
  readonly class?: string;
}

const CORPUS_STATUSES: ReadonlySet<string> = new Set<LookupEvalStatus>([
  'resolved',
  'ambiguous',
  'failed',
  'redirect_discovery',
]);

function parseCorpus(corpusPath: string): readonly CorpusRow[] {
  const raw = readFileSync(corpusPath, 'utf8');
  const rows: CorpusRow[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    const qid = obj['qid'];
    const query = obj['query'];
    const expected = obj['expected_status'];
    if (typeof qid !== 'string' || typeof query !== 'string' || typeof expected !== 'string') continue;
    if (!CORPUS_STATUSES.has(expected)) continue;
    const acceptedStatuses = Array.isArray(obj['accepted_statuses'])
      ? obj['accepted_statuses']
          .filter((status): status is string => typeof status === 'string')
          .filter((status): status is LookupEvalStatus => CORPUS_STATUSES.has(status))
      : undefined;
    rows.push({
      qid,
      query,
      expectedStatus: expected as LookupEvalStatus,
      ...(acceptedStatuses !== undefined && acceptedStatuses.length > 0 ? { accepted_statuses: acceptedStatuses } : {}),
      ...(typeof obj['expected_entity_hint'] === 'string' ? { expected_entity_hint: obj['expected_entity_hint'] } : {}),
      ...(typeof obj['class'] === 'string' ? { class: obj['class'] } : {}),
    });
  }
  return rows;
}

function toOutcome(result: {
  readonly status: LookupEvalStatus;
  readonly topCandidate: null | {
    readonly entityId: string;
    readonly canonicalLabel: string;
  };
}): LookupEvalSideOutcome {
  if (result.topCandidate === null) {
    return { status: result.status };
  }
  return {
    status: result.status,
    topEntityId: result.topCandidate.entityId,
    topLabel: result.topCandidate.canonicalLabel,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((arg) => arg !== '--');
  const { values } = parseArgs({
    args: argv,
    options: {
      corpus: { type: 'string', default: 'test/fixtures/lookup-v2-hotset.jsonl' },
      output: { type: 'string', default: '/tmp/lookup-v2-parity-report.json' },
      partition: { type: 'string', default: 'all' },
      ...EVAL_RUNTIME_BINDING_OPTIONS,
    },
  });
  const corpusPath = values.corpus ?? 'test/fixtures/lookup-v2-hotset.jsonl';
  const outputPath = values.output ?? '/tmp/lookup-v2-parity-report.json';
  const rawPartition = values.partition ?? 'all';
  if (!isLookupV2StretchPartition(rawPartition)) {
    throw new Error(`[elv2-parity] invalid --partition: ${rawPartition}`);
  }
  const partition: LookupV2StretchPartition = rawPartition;
  const { runtimeStatePath, useActiveRuntime } = resolveEvalRuntimeBinding(values);
  requireExplicitEvalRuntimeBinding({ runtimeStatePath, useActiveRuntime });

  const corpus = filterLookupV2StretchRows(parseCorpus(corpusPath), partition);
  if (corpus.length === 0) {
    throw new Error(`[elv2-parity] empty corpus: ${corpusPath} (partition=${partition})`);
  }

  const config = loadConfig();
  const pool = getPgPool();
  const effectiveRuntimeStatePath = runtimeStatePath ?? DEFAULT_RUNTIME_STATE_PATH;
  const runtimeState = await loadSearchSnapshotRuntimeState(effectiveRuntimeStatePath);
  const runtime = {
    pool,
    searchSnapshotId: runtimeState.snapshotId,
    searchSnapshotManifestPath: runtimeState.manifestPath,
    searchSnapshotFieldAvailability: runtimeState.fieldAvailability,
  } as const;
  const directContainer = await createLookupDirectContainer(config, runtime);
  const fullContainer = await createContainer(config, runtime);

  const rows: ParityRow[] = [];
  for (const row of corpus) {
    const requestId = `elv2-parity-${row.qid}`;
    const command = {
      query: row.query,
      maxCandidates: LOOKUP_V2_DEFAULT_MAX_CANDIDATES,
      mode: 'default' as const,
      requestId,
    };
    const directResult = await directContainer.entityLookupV2UseCase.execute(command, {});
    const fullContainerResult = await fullContainer.entityLookupV2UseCase.execute(command, {});
    rows.push({
      qid: row.qid,
      query: row.query,
      ...(row.class !== undefined ? { queryClass: row.class } : {}),
      expectedStatus: row.expectedStatus,
      ...(row.accepted_statuses !== undefined ? { acceptedStatuses: row.accepted_statuses } : {}),
      ...(row.expected_entity_hint !== undefined ? { expectedLabelHint: row.expected_entity_hint } : {}),
      direct: toOutcome(directResult),
      fullContainer: toOutcome(fullContainerResult),
    });
  }

  const report = buildParityReport(rows);
  let gitSha = 'unknown';
  try {
    gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    // leave unknown
  }
  writeFileSync(
    outputPath,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      gitSha,
      corpus: corpusPath,
      partition,
      runtime: {
        runtime_state_path: effectiveRuntimeStatePath,
        runtime_state_schema: runtimeState.schemaVersion,
        manifest_schema: SEARCH_SNAPSHOT_SCHEMA_VERSION,
        snapshot_id: runtimeState.snapshotId,
        artifact_hashes: runtimeState.hashes,
      },
      rows,
      report,
    }, null, 2),
    'utf8',
  );

  console.log(`[elv2-parity] rows=${report.rowCount}`);
  console.log(
    `[elv2-parity] direct correct=${report.direct.correct}/${report.direct.total} | fullContainer correct=${report.fullContainer.correct}/${report.fullContainer.total}`,
  );
  console.log(`[elv2-parity] divergences=${report.divergences.length}`);
  console.log(`[elv2-parity] gate: ${report.gate.pass ? 'PASS' : 'FAIL'}`);
  for (const reason of report.gate.reasons) {
    console.log(`[elv2-parity]   - ${reason}`);
  }
  console.log(`[elv2-parity] report → ${outputPath}`);

  await pool.end();
  process.exit(report.gate.pass ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error('[elv2-parity] FATAL', error);
  process.exit(2);
});

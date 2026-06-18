import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../../src/config/env.js';
import { createLookupDirectContainer } from '../../src/config/container-lookup.js';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../../src/domain/shared/constants/search-snapshot.js';
import {
  DEFAULT_RUNTIME_STATE_PATH,
  loadSearchSnapshotRuntimeState,
} from '../../src/infrastructure/health/search-snapshot-readiness.js';
import { getPgPool } from '../../src/infrastructure/db/pg-pool.js';
import { LOOKUP_V2_DEFAULT_MAX_CANDIDATES } from '../../src/interface/http/constants.js';

type LookupStatus = 'resolved' | 'ambiguous' | 'failed' | 'redirect_discovery' | `error:${string}`;

interface ReplayInputRow {
  readonly qid: string;
  readonly query: string;
  readonly expected_status?: string | undefined;
  readonly accepted_statuses?: readonly string[] | undefined;
  readonly expected_entity_id?: string | undefined;
}

interface ReplayOutcome {
  readonly status: LookupStatus;
  readonly topEntityId?: string | undefined;
  readonly topLabel?: string | undefined;
}

interface ReplayResultRow {
  readonly qid: string;
  readonly query: string;
  readonly baseline: ReplayOutcome;
  readonly candidate: ReplayOutcome;
  readonly drift: 'stable' | 'soft_abstain_drift' | 'hard_drift';
  readonly drift_kind?: 'entity_changed' | 'resolution_drop' | 'new_resolution' | 'abstain_status_changed' | undefined;
  readonly expected_status?: string | undefined;
  readonly accepted_statuses?: readonly string[] | undefined;
  readonly expected_entity_id?: string | undefined;
  readonly baseline_verdict?: 'correct' | 'wrong' | 'miss' | undefined;
  readonly candidate_verdict?: 'correct' | 'wrong' | 'miss' | undefined;
}

function parseCorpus(path: string): readonly ReplayInputRow[] {
  const raw = readFileSync(path, 'utf8');
  const rows: ReplayInputRow[] = [];
  let lineNumber = 0;
  for (const line of raw.split('\n')) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`Invalid JSON object at ${path}:${String(lineNumber)}`);
    }
    const obj = parsed as Record<string, unknown>;
    const query = obj['query'];
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new Error(`Missing query at ${path}:${String(lineNumber)}`);
    }
    const qid = typeof obj['qid'] === 'string' ? obj['qid'] : `row-${String(rows.length + 1)}`;
    rows.push({
      qid,
      query,
      ...(typeof obj['expected_status'] === 'string'
        ? { expected_status: obj['expected_status'] }
        : {}),
      ...(Array.isArray(obj['accepted_statuses'])
        ? { accepted_statuses: obj['accepted_statuses'].filter((item): item is string => typeof item === 'string') }
        : {}),
      ...(typeof obj['expected_entity_id'] === 'string'
        ? { expected_entity_id: obj['expected_entity_id'] }
        : {}),
    });
  }
  return rows;
}

function normalizeOutcome(result: Awaited<ReturnType<Awaited<ReturnType<typeof createLookupDirectContainer>>['entityLookupV2UseCase']['execute']>>): ReplayOutcome {
  return result.topCandidate !== null
    ? {
        status: result.status,
        topEntityId: String(result.topCandidate.entityId),
        topLabel: result.topCandidate.canonicalLabel,
      }
    : { status: result.status };
}

function isResolved(outcome: ReplayOutcome): boolean {
  return outcome.status === 'resolved' && outcome.topEntityId !== undefined;
}

function classifyDrift(baseline: ReplayOutcome, candidate: ReplayOutcome): Pick<ReplayResultRow, 'drift' | 'drift_kind'> {
  if (baseline.status === candidate.status && baseline.topEntityId === candidate.topEntityId) {
    return { drift: 'stable' };
  }
  if (isResolved(baseline) && isResolved(candidate)) {
    return baseline.topEntityId === candidate.topEntityId
      ? { drift: 'stable' }
      : { drift: 'hard_drift', drift_kind: 'entity_changed' };
  }
  if (isResolved(baseline) && !isResolved(candidate)) {
    return { drift: 'hard_drift', drift_kind: 'resolution_drop' };
  }
  if (!isResolved(baseline) && isResolved(candidate)) {
    return { drift: 'hard_drift', drift_kind: 'new_resolution' };
  }
  return { drift: 'soft_abstain_drift', drift_kind: 'abstain_status_changed' };
}

function scoreVerdict(row: ReplayInputRow, outcome: ReplayOutcome): 'correct' | 'wrong' | 'miss' | undefined {
  if (row.expected_status === undefined) {
    return undefined;
  }
  const acceptedStatuses = row.accepted_statuses ?? [row.expected_status];
  const shouldResolve = row.expected_entity_id !== undefined;
  if (shouldResolve) {
    if (!isResolved(outcome)) {
      return 'miss';
    }
    return outcome.topEntityId === row.expected_entity_id ? 'correct' : 'wrong';
  }
  return acceptedStatuses.includes(outcome.status) ? 'correct' : 'wrong';
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((arg) => arg !== '--');
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: 'string' },
      output: { type: 'string', default: '/tmp/lookup-v2-canary-replay.json' },
      limit: { type: 'string' },
      baselineRuntimeState: { type: 'string' },
      baselineUseActiveRuntime: { type: 'boolean', default: false },
      candidateRuntimeState: { type: 'string' },
      candidateUseActiveRuntime: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const inputPath = values.input;
  if (inputPath === undefined) {
    throw new Error('Missing required --input <traffic.jsonl>');
  }
  if (values.baselineRuntimeState === undefined && !values.baselineUseActiveRuntime) {
    throw new Error('Explicit baseline runtime binding required: pass --baselineRuntimeState <path> or --baselineUseActiveRuntime');
  }
  if (values.candidateRuntimeState === undefined && !values.candidateUseActiveRuntime) {
    throw new Error('Explicit candidate runtime binding required: pass --candidateRuntimeState <path> or --candidateUseActiveRuntime');
  }

  const rows = parseCorpus(inputPath);
  const requestedLimit = values.limit === undefined ? undefined : Number.parseInt(values.limit, 10);
  const corpus = requestedLimit === undefined ? rows : rows.slice(0, Math.max(1, requestedLimit));
  if (corpus.length === 0) {
    throw new Error(`[lookup-canary] empty corpus: ${inputPath}`);
  }

  const baselineRuntimeStatePath = values.baselineRuntimeState ?? DEFAULT_RUNTIME_STATE_PATH;
  const candidateRuntimeStatePath = values.candidateRuntimeState ?? DEFAULT_RUNTIME_STATE_PATH;
  const [baselineRuntime, candidateRuntime] = await Promise.all([
    loadSearchSnapshotRuntimeState(baselineRuntimeStatePath),
    loadSearchSnapshotRuntimeState(candidateRuntimeStatePath),
  ]);

  const config = loadConfig();
  const pool = getPgPool();
  const [baselineContainer, candidateContainer] = await Promise.all([
    createLookupDirectContainer(config, {
      pool,
      searchSnapshotId: baselineRuntime.snapshotId,
      searchSnapshotManifestPath: baselineRuntime.manifestPath,
      searchSnapshotFieldAvailability: baselineRuntime.fieldAvailability,
    }),
    createLookupDirectContainer(config, {
      pool,
      searchSnapshotId: candidateRuntime.snapshotId,
      searchSnapshotManifestPath: candidateRuntime.manifestPath,
      searchSnapshotFieldAvailability: candidateRuntime.fieldAvailability,
    }),
  ]);

  const resultRows: ReplayResultRow[] = [];
  for (const row of corpus) {
    const [baselineResult, candidateResult] = await Promise.all([
      baselineContainer.entityLookupV2UseCase.execute(
        {
          query: row.query,
          maxCandidates: LOOKUP_V2_DEFAULT_MAX_CANDIDATES,
          mode: 'default',
          requestId: `lookup-canary-baseline-${row.qid}`,
        },
        { executionPrincipal: 'benchmark_trusted', requestId: `lookup-canary-baseline-${row.qid}` },
      ).then(normalizeOutcome).catch((error: unknown) => ({ status: `error:${(error as Error).message}` as const })),
      candidateContainer.entityLookupV2UseCase.execute(
        {
          query: row.query,
          maxCandidates: LOOKUP_V2_DEFAULT_MAX_CANDIDATES,
          mode: 'default',
          requestId: `lookup-canary-candidate-${row.qid}`,
        },
        { executionPrincipal: 'benchmark_trusted', requestId: `lookup-canary-candidate-${row.qid}` },
      ).then(normalizeOutcome).catch((error: unknown) => ({ status: `error:${(error as Error).message}` as const })),
    ]);

    resultRows.push({
      qid: row.qid,
      query: row.query,
      baseline: baselineResult,
      candidate: candidateResult,
      ...classifyDrift(baselineResult, candidateResult),
      ...(row.expected_status !== undefined ? { expected_status: row.expected_status } : {}),
      ...(row.accepted_statuses !== undefined ? { accepted_statuses: row.accepted_statuses } : {}),
      ...(row.expected_entity_id !== undefined ? { expected_entity_id: row.expected_entity_id } : {}),
      ...(scoreVerdict(row, baselineResult) !== undefined ? { baseline_verdict: scoreVerdict(row, baselineResult) } : {}),
      ...(scoreVerdict(row, candidateResult) !== undefined ? { candidate_verdict: scoreVerdict(row, candidateResult) } : {}),
    });
  }

  const hardDrifts = resultRows.filter((row) => row.drift === 'hard_drift');
  const softDrifts = resultRows.filter((row) => row.drift === 'soft_abstain_drift');
  const labeledRows = resultRows.filter((row) => row.candidate_verdict !== undefined);
  const candidateWrong = labeledRows.filter((row) => row.candidate_verdict === 'wrong').length;
  const candidateMiss = labeledRows.filter((row) => row.candidate_verdict === 'miss').length;
  const candidateCorrect = labeledRows.filter((row) => row.candidate_verdict === 'correct').length;
  const baselineWrong = labeledRows.filter((row) => row.baseline_verdict === 'wrong').length;
  const baselineMiss = labeledRows.filter((row) => row.baseline_verdict === 'miss').length;
  const baselineCorrect = labeledRows.filter((row) => row.baseline_verdict === 'correct').length;

  const gateReasons: string[] = [];
  if (hardDrifts.length > 0) {
    gateReasons.push(`hard_drift_count=${String(hardDrifts.length)}`);
  }
  if (labeledRows.length > 0 && candidateWrong > baselineWrong) {
    gateReasons.push(`candidate_wrong=${String(candidateWrong)} > baseline_wrong=${String(baselineWrong)}`);
  }
  if (labeledRows.length > 0 && candidateMiss > baselineMiss) {
    gateReasons.push(`candidate_miss=${String(candidateMiss)} > baseline_miss=${String(baselineMiss)}`);
  }

  let gitSha = 'unknown';
  try {
    gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    // keep unknown
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    gitSha,
    input: inputPath,
    baseline: {
      runtime_state_path: baselineRuntimeStatePath,
      runtime_state_schema: baselineRuntime.schemaVersion,
      snapshot_id: baselineRuntime.snapshotId,
      manifest_schema: SEARCH_SNAPSHOT_SCHEMA_VERSION,
      artifact_hashes: baselineRuntime.hashes,
      container_profile: 'lookup_direct_container',
    },
    candidate: {
      runtime_state_path: candidateRuntimeStatePath,
      runtime_state_schema: candidateRuntime.schemaVersion,
      snapshot_id: candidateRuntime.snapshotId,
      manifest_schema: SEARCH_SNAPSHOT_SCHEMA_VERSION,
      artifact_hashes: candidateRuntime.hashes,
      container_profile: 'lookup_direct_container',
    },
    report: {
      rowCount: resultRows.length,
      hardDriftCount: hardDrifts.length,
      softAbstainDriftCount: softDrifts.length,
      stableCount: resultRows.length - hardDrifts.length - softDrifts.length,
      labeledCount: labeledRows.length,
      ...(labeledRows.length > 0
        ? {
            baselineLabeled: {
              correct: baselineCorrect,
              wrong: baselineWrong,
              miss: baselineMiss,
            },
            candidateLabeled: {
              correct: candidateCorrect,
              wrong: candidateWrong,
              miss: candidateMiss,
            },
          }
        : {}),
      gate: {
        pass: gateReasons.length === 0,
        reasons: gateReasons,
      },
    },
    rows: resultRows,
  };

  writeFileSync(values.output ?? '/tmp/lookup-v2-canary-replay.json', `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  console.log(`[lookup-canary] rows=${resultRows.length} hard_drift=${hardDrifts.length} soft_abstain_drift=${softDrifts.length}`);
  if (labeledRows.length > 0) {
    console.log(`[lookup-canary] baseline correct=${baselineCorrect} wrong=${baselineWrong} miss=${baselineMiss}`);
    console.log(`[lookup-canary] candidate correct=${candidateCorrect} wrong=${candidateWrong} miss=${candidateMiss}`);
  }
  console.log(`[lookup-canary] gate: ${gateReasons.length === 0 ? 'PASS' : 'FAIL'}`);
  for (const reason of gateReasons) {
    console.log(`[lookup-canary]   - ${reason}`);
  }
  console.log(`[lookup-canary] report → ${values.output ?? '/tmp/lookup-v2-canary-replay.json'}`);

  await pool.end();
  process.exit(gateReasons.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error('[lookup-canary] FATAL', error);
  process.exit(2);
});

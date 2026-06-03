import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../../src/config/env.js';
import { createContainer } from '../../src/config/container.js';
import { createStageTimer } from '../../src/domain/shared/stage-timer.js';
import { SearchSnapshotAliasMatcher } from '../../src/infrastructure/adapter/search-snapshot-alias-matcher.js';
import {
  DEFAULT_RUNTIME_STATE_PATH,
  loadSearchSnapshotRuntimeState,
} from '../../src/infrastructure/health/search-snapshot-readiness.js';
import { getPgPool } from '../../src/infrastructure/db/pg-pool.js';
import { LOOKUP_V2_DEFAULT_MAX_CANDIDATES } from '../../src/interface/http/constants.js';

interface HotsetRow {
  readonly qid: string;
  readonly query: string;
  readonly class?: string | undefined;
}

interface QueryLatencyRow {
  readonly qid: string;
  readonly query: string;
  readonly queryClass: string;
  readonly status: string;
  readonly total_ms: number;
  readonly per_stage_ms: {
    readonly security_gate: number;
    readonly planner_total: number;
    readonly exact: number;
    readonly compact: number;
    readonly broad_recall: number;
    readonly retrieval_total: number;
    readonly retrieval_union: number;
    readonly retrieval_family_graph: number;
    readonly retrieval_hydration: number;
    readonly candidate_generation: number;
    readonly blocker: number;
    readonly resolver: number;
    readonly clarification: number;
    readonly ambiguity_lookup: number;
  };
  readonly unattributed_ms: number;
  readonly raw_stage_timings: Readonly<Record<string, number>>;
}

function parseHotset(corpusPath: string): readonly HotsetRow[] {
  const raw = readFileSync(corpusPath, 'utf8');
  const rows: HotsetRow[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj['qid'] !== 'string' || typeof obj['query'] !== 'string') continue;
    rows.push({
      qid: obj['qid'],
      query: obj['query'],
      ...(typeof obj['class'] === 'string' ? { class: obj['class'] } : {}),
    });
  }
  return rows;
}

function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(sortedAsc.length * p) - 1));
  return sortedAsc[rank] ?? null;
}

function roundMs(value: number): number {
  return Number(value.toFixed(3));
}

function sumStageFamily(snapshot: Readonly<Record<string, number>>, family: string): number {
  let total = 0;
  for (const [stage, ms] of Object.entries(snapshot)) {
    if (stage === family || stage.startsWith(`${family}#`) || stage.startsWith(`${family}.`)) {
      total += ms;
    }
  }
  return roundMs(total);
}

function readStage(snapshot: Readonly<Record<string, number>>, stage: string): number {
  return roundMs(snapshot[stage] ?? 0);
}

function aggregateLookupStages(snapshot: Readonly<Record<string, number>>): QueryLatencyRow['per_stage_ms'] {
  return {
    security_gate: readStage(snapshot, 'security_gate'),
    planner_total: readStage(snapshot, 'planner.total'),
    exact: sumStageFamily(snapshot, 'exact'),
    compact: sumStageFamily(snapshot, 'compact'),
    broad_recall: sumStageFamily(snapshot, 'broad_recall'),
    retrieval_total: readStage(snapshot, 'retrieval.total'),
    retrieval_union: readStage(snapshot, 'retrieval.union'),
    retrieval_family_graph: readStage(snapshot, 'retrieval.family_graph'),
    retrieval_hydration: readStage(snapshot, 'retrieval.hydration'),
    candidate_generation: readStage(snapshot, 'candidate_generation'),
    blocker: sumStageFamily(snapshot, 'blocker'),
    resolver: sumStageFamily(snapshot, 'resolver'),
    clarification: sumStageFamily(snapshot, 'clarification'),
    ambiguity_lookup: readStage(snapshot, 'ambiguity_lookup'),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((arg) => arg !== '--');
  const { values } = parseArgs({
    args: argv,
    options: {
      corpus: { type: 'string', default: 'test/fixtures/lookup-v2-korean-famous-expanded.jsonl' },
      output: { type: 'string', default: '/tmp/lookup-v2-latency-korean-famous.json' },
      limit: { type: 'string' },
      runtimeState: { type: 'string', default: DEFAULT_RUNTIME_STATE_PATH },
      bootstrapThresholdMs: { type: 'string', default: '3000' },
      firstQueryThresholdMs: { type: 'string', default: '5000' },
      warmP95ThresholdMs: { type: 'string', default: '2000' },
    },
    strict: true,
    allowPositionals: false,
  });

  const corpusPath = values.corpus ?? 'test/fixtures/lookup-v2-korean-famous-expanded.jsonl';
  const outputPath = values.output ?? '/tmp/lookup-v2-latency-korean-famous.json';
  const runtimeStatePath = values.runtimeState ?? DEFAULT_RUNTIME_STATE_PATH;
  const requestedLimit = values.limit === undefined ? undefined : Number.parseInt(values.limit, 10);
  const bootstrapThresholdMs = Number.parseFloat(values.bootstrapThresholdMs ?? '3000');
  const firstQueryThresholdMs = Number.parseFloat(values.firstQueryThresholdMs ?? '5000');
  const warmP95ThresholdMs = Number.parseFloat(values.warmP95ThresholdMs ?? '2000');

  const hotset = parseHotset(corpusPath);
  if (hotset.length === 0) {
    throw new Error(`[elv2-latency] empty corpus: ${corpusPath}`);
  }
  const rows = requestedLimit === undefined ? hotset : hotset.slice(0, Math.max(1, requestedLimit));

  const runtimeState = await loadSearchSnapshotRuntimeState(runtimeStatePath);
  const probeMatcher = await SearchSnapshotAliasMatcher.loadFromRuntimeState(runtimeStatePath);
  if (probeMatcher === undefined) {
    throw new Error(`[elv2-latency] failed to load alias runtime matcher from ${runtimeStatePath}`);
  }

  const probeQuery = rows[0]?.query ?? '';
  const probeTimer = createStageTimer();
  const buildStateBefore = probeMatcher.getBuildStateSnapshot();
  const probeStartedAt = performance.now();
  await probeMatcher.findMatches(probeQuery, { scope: 'span', stageTimer: probeTimer });
  const probeMs = roundMs(performance.now() - probeStartedAt);
  const buildStateAfter = probeMatcher.getBuildStateSnapshot();

  const config = loadConfig();
  const pool = getPgPool();
  const bootstrapStartedAt = performance.now();
  const container = await createContainer(config, pool);
  const bootstrapMs = roundMs(performance.now() - bootstrapStartedAt);

  const queryRows: QueryLatencyRow[] = [];
  for (const row of rows) {
    const stageTimer = createStageTimer();
    const startedAt = performance.now();
    let status = 'failed';
    try {
      const result = await container.entityLookupV2UseCase.execute(
        {
          query: row.query,
          maxCandidates: LOOKUP_V2_DEFAULT_MAX_CANDIDATES,
          mode: 'default',
          requestId: `elv2-latency-${row.qid}`,
        },
        {
          executionPrincipal: 'benchmark_trusted',
          stageTimer,
          requestId: `elv2-latency-${row.qid}`,
        },
      );
      status = result.status;
    } catch (error) {
      status = `error:${(error as Error).message}`;
    }
    const totalMs = roundMs(performance.now() - startedAt);
    const rawStageTimings = stageTimer.snapshot();
    const perStage = aggregateLookupStages(rawStageTimings);
    const attributedMs = roundMs(
      perStage.security_gate
      + perStage.planner_total
      + (perStage.retrieval_total > 0
        ? perStage.retrieval_total
        : perStage.exact + perStage.compact + perStage.broad_recall)
      + perStage.candidate_generation
      + perStage.blocker
      + perStage.resolver
      + perStage.clarification
      + perStage.ambiguity_lookup,
    );
    queryRows.push({
      qid: row.qid,
      query: row.query,
      queryClass: row.class ?? 'unclassified',
      status,
      total_ms: totalMs,
      per_stage_ms: perStage,
      unattributed_ms: roundMs(Math.max(0, totalMs - attributedMs)),
      raw_stage_timings: rawStageTimings,
    });
  }

  const firstQueryMs = queryRows[0]?.total_ms ?? 0;
  const warmLatencies = queryRows.slice(1).map((row) => row.total_ms).sort((left, right) => left - right);
  const warmP50Ms = percentile(warmLatencies, 0.5);
  const warmP95Ms = percentile(warmLatencies, 0.95);

  const violations: string[] = [];
  if (!probeMatcher.isFullyHydratedRuntimeArtifact()) {
    violations.push('alias_runtime_artifact_not_fully_hydrated');
  }
  if (JSON.stringify(buildStateBefore) !== JSON.stringify(buildStateAfter)) {
    violations.push('alias_runtime_lazy_build_triggered_during_probe');
  }
  if (bootstrapMs > bootstrapThresholdMs) {
    violations.push(
      `bootstrap_ms=${bootstrapMs.toFixed(3)} exceeds threshold ${bootstrapThresholdMs.toFixed(3)}`,
    );
  }
  if (firstQueryMs > firstQueryThresholdMs) {
    violations.push(
      `first_query_ms=${firstQueryMs.toFixed(3)} exceeds threshold ${firstQueryThresholdMs.toFixed(3)}`,
    );
  }
  if (warmP95Ms !== null && warmP95Ms > warmP95ThresholdMs) {
    violations.push(
      `warm_p95_ms=${warmP95Ms.toFixed(3)} exceeds threshold ${warmP95ThresholdMs.toFixed(3)}`,
    );
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
    corpus: corpusPath,
    runtimeStatePath,
    snapshotId: runtimeState.snapshotId,
    thresholds: {
      bootstrap_ms: bootstrapThresholdMs,
      first_query_ms: firstQueryThresholdMs,
      warm_p95_ms: warmP95ThresholdMs,
    },
    matcher_probe: {
      query: probeQuery,
      total_ms: probeMs,
      raw_stage_timings: probeTimer.snapshot(),
      build_state_before: buildStateBefore,
      build_state_after: buildStateAfter,
      fully_hydrated_runtime_artifact: probeMatcher.isFullyHydratedRuntimeArtifact(),
    },
    metrics: {
      bootstrap_ms: bootstrapMs,
      first_query_ms: firstQueryMs,
      warm_p50_ms: warmP50Ms,
      warm_p95_ms: warmP95Ms,
      query_count: queryRows.length,
    },
    queries: queryRows,
    violations,
  };

  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  console.log(`[elv2-latency] snapshot=${runtimeState.snapshotId}`);
  console.log(`[elv2-latency] bootstrap_ms=${bootstrapMs.toFixed(3)} first_query_ms=${firstQueryMs.toFixed(3)} warm_p50_ms=${warmP50Ms?.toFixed(3) ?? 'n/a'} warm_p95_ms=${warmP95Ms?.toFixed(3) ?? 'n/a'}`);
  console.log(`[elv2-latency] probe=${probeQuery} probe_ms=${probeMs.toFixed(3)} hydrated=${probeMatcher.isFullyHydratedRuntimeArtifact() ? 'yes' : 'no'}`);
  if (violations.length === 0) {
    console.log('[elv2-latency] gate: PASS');
  } else {
    console.log('[elv2-latency] gate: FAIL');
    for (const violation of violations) {
      console.log(`[elv2-latency]   - ${violation}`);
    }
  }
  console.log(`[elv2-latency] report → ${outputPath}`);

  await pool.end();
  process.exit(violations.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error('[elv2-latency] FATAL', error);
  process.exit(2);
});

/**
 * Entity Lookup V2 — live V1↔V2 shadow-compare runner (T-ELV2-08).
 *
 * Executes BOTH the explicit legacy-core `lookup_wine` path and the
 * `/v2/entity-lookup` path (`entityLookupV2UseCase`) over the labeled hotset
 * corpus, normalizes each into a {@link ShadowSideOutcome}, scores the run with
 * the pure {@link buildShadowReport} gate, writes a JSON report, and EXITS
 * NON-ZERO when the cutover gate fails.
 *
 * This is the rail the cutover checklist requires before V1 authority can be
 * removed (RFC DoD §7 — "shadow compare 없이 cutover 금지"). It is infra-gated:
 * it constructs the real container, so it needs the runtime stack (PG / Vespa /
 * embedding) available — run it in a stack-up environment / CI lane, not unit.
 *
 *   pnpm run eval:lookup-v2:shadow [-- --corpus <path> --output <path>]
 *
 * Post-cutover note: this lane opts into `legacy_core` explicitly. It is not a
 * public `/v1/lookup/wine` route-parity proof after compatibility-backed
 * cutover.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../../src/config/env.js';
import { createLookupDirectContainer } from '../../src/config/container-lookup.js';
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
  buildShadowReport,
  type ShadowRow,
  type ShadowSideOutcome,
  type ShadowStatus,
} from './lookup-v2-shadow-metrics.js';
import {
  filterLookupV2StretchRows,
  isLookupV2StretchPartition,
  type LookupV2StretchPartition,
} from './lookup-v2-stretch-partitions.js';

interface HotsetRow {
  readonly qid: string;
  readonly query: string;
  readonly expectedStatus: ShadowStatus;
  readonly accepted_statuses?: readonly ShadowStatus[] | undefined;
  readonly expected_entity_hint?: string;
  readonly class?: string;
}

const HOTSET_STATUSES: ReadonlySet<string> = new Set<ShadowStatus>([
  'resolved',
  'ambiguous',
  'failed',
  'redirect_discovery',
]);

function parseHotset(corpusPath: string): readonly HotsetRow[] {
  const raw = readFileSync(corpusPath, 'utf8');
  const rows: HotsetRow[] = [];
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
    if (!HOTSET_STATUSES.has(expected)) continue;
    const acceptedStatuses = Array.isArray(obj['accepted_statuses'])
      ? obj['accepted_statuses']
          .filter((status): status is string => typeof status === 'string')
          .filter((status): status is ShadowStatus => HOTSET_STATUSES.has(status))
      : undefined;
    rows.push({
      qid,
      query,
      expectedStatus: expected as ShadowStatus,
      ...(acceptedStatuses !== undefined && acceptedStatuses.length > 0 ? { accepted_statuses: acceptedStatuses } : {}),
      ...(typeof obj['expected_entity_hint'] === 'string' ? { expected_entity_hint: obj['expected_entity_hint'] } : {}),
      ...(typeof obj['class'] === 'string' ? { class: obj['class'] } : {}),
    });
  }
  return rows;
}

/** Map a V1 lookup response onto the shared 4-state shadow outcome. */
async function main(): Promise<void> {
  // `pnpm run X -- --output Y` forwards a literal `--` terminator; drop it so
  // the forwarded options still parse (parseArgs treats `--` as end-of-options).
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const { values } = parseArgs({
    args: argv,
    options: {
      corpus: { type: 'string', default: 'test/fixtures/lookup-v2-hotset.jsonl' },
      output: { type: 'string', default: '/tmp/lookup-v2-shadow-report.json' },
      partition: { type: 'string', default: 'all' },
      ...EVAL_RUNTIME_BINDING_OPTIONS,
    },
  });
  const corpusPath = values.corpus ?? 'test/fixtures/lookup-v2-hotset.jsonl';
  const outputPath = values.output ?? '/tmp/lookup-v2-shadow-report.json';
  const rawPartition = values.partition ?? 'all';
  if (!isLookupV2StretchPartition(rawPartition)) {
    throw new Error(`[elv2-shadow] invalid --partition: ${rawPartition}`);
  }
  const partition: LookupV2StretchPartition = rawPartition;
  const { runtimeStatePath, useActiveRuntime } = resolveEvalRuntimeBinding(values);
  requireExplicitEvalRuntimeBinding({ runtimeStatePath, useActiveRuntime });

  const hotset = filterLookupV2StretchRows(parseHotset(corpusPath), partition);
  if (hotset.length === 0) {
    throw new Error(`[elv2-shadow] empty hotset corpus: ${corpusPath} (partition=${partition})`);
  }

  const config = loadConfig();
  // Inject the live RDS pool so the lookup-direct container keeps the same
  // PG-backed blocker/calibration semantics as production authority while
  // avoiding generic search/bootstrap tax.
  const pool = getPgPool();
  const effectiveRuntimeStatePath = runtimeStatePath ?? DEFAULT_RUNTIME_STATE_PATH;
  const runtimeState = await loadSearchSnapshotRuntimeState(effectiveRuntimeStatePath);
  const container = await createLookupDirectContainer(config, {
    pool,
    searchSnapshotId: runtimeState.snapshotId,
    searchSnapshotManifestPath: runtimeState.manifestPath,
    searchSnapshotFieldAvailability: runtimeState.fieldAvailability,
  });

  const rows: ShadowRow[] = [];
  for (const row of hotset) {
    const requestId = `elv2-shadow-${row.qid}`;

    // V2-only cutover: the legacy `/v1` lookup seam was REMOVED. The V1 column is
    // retained as a removed-marker for report-shape stability only; it is no
    // longer executed (EntityLookupV2 is the sole lookup authority).
    const v1: ShadowSideOutcome = { status: 'failed' };

    // V2 — dedicated entity-lookup path.
    let v2: ShadowSideOutcome = { status: 'failed' };
    try {
      const v2Result = await container.entityLookupV2UseCase.execute(
        { query: row.query, maxCandidates: LOOKUP_V2_DEFAULT_MAX_CANDIDATES, mode: 'default', requestId },
        {},
      );
      v2 = v2Result.topCandidate !== null
        ? { status: v2Result.status, topEntityId: v2Result.topCandidate.entityId, topLabel: v2Result.topCandidate.canonicalLabel }
        : { status: v2Result.status };
    } catch (err) {
      console.error(`[elv2-shadow] V2 failed for ${row.qid}:`, (err as Error).message);
    }

    rows.push({
      qid: row.qid,
      query: row.query,
      ...(row.class !== undefined ? { queryClass: row.class } : {}),
      expectedStatus: row.expectedStatus,
      ...(row.accepted_statuses !== undefined ? { acceptedStatuses: row.accepted_statuses } : {}),
      ...(row.expected_entity_hint !== undefined ? { expectedLabelHint: row.expected_entity_hint } : {}),
      v1,
      v2,
    });
  }

  const report = buildShadowReport(rows);
  // Tamper-evident, self-describing artifact: a committed PASS claim must carry
  // a real timestamp + git SHA so it can be audited / reproduced (self-review C2).
  let gitSha = 'unknown';
  try {
    gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    // not in a git checkout — leave 'unknown'
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

  console.log(`[elv2-shadow] rows=${report.rowCount}`);
  console.log(`[elv2-shadow] V1 correct=${report.v1.correct} wrong+=${report.v1.wrongPositive} | V2 correct=${report.v2.correct} wrong+=${report.v2.wrongPositive}`);
  console.log(`[elv2-shadow] improvements=${report.improvements} regressions=${report.regressions} concept_redirect_acc=${report.v2ConceptRedirectAccuracy.toFixed(3)}`);
  console.log(`[elv2-shadow] cutover gate: ${report.gate.pass ? 'PASS' : 'FAIL'}`);
  for (const reason of report.gate.reasons) {
    console.log(`[elv2-shadow]   - ${reason}`);
  }
  console.log(`[elv2-shadow] report → ${outputPath}`);

  await pool.end();
  process.exit(report.gate.pass ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('[elv2-shadow] FATAL', err);
  process.exit(2);
});

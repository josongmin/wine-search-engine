/**
 * Entity Lookup V2 — live hot-entity coverage runner (T-ELV2-03, DoD §2).
 *
 * Executes `/v2/entity-lookup` over the labeled hotset corpus, classifies the
 * observed vs gold statuses with the pure {@link buildCoverageReport}, and turns
 * every hot-entity COVERAGE HOLE into a {@link buildCurationTasks} curation task
 * (surface → suggested alias type) for the operator queue. This is the rail that
 * makes the `dom perignon` / `돔페리뇽` holes ACTIONABLE (RFC DoD §2).
 *
 * This wires the coverage classification + curation-task cores into a runnable
 * production entrypoint (they were otherwise reachable only from unit tests —
 * CLAUDE.md rule 33). It is infra-gated: it builds the real container, so it
 * needs the runtime stack (PG / Vespa / embedding). Run it in a stack-up
 * environment / CI lane, not unit.
 *
 *   pnpm run eval:lookup-v2:coverage [-- --corpus <path> --output <path>]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../../src/config/env.js';
import { createContainer } from '../../src/config/container.js';
import { LOOKUP_V2_DEFAULT_MAX_CANDIDATES } from '../../src/interface/http/constants.js';
import {
  buildCoverageReport,
  formatCoverageReport,
  type CoverageInputRow,
  type CoverageStatus,
} from '../../src/domain/resolver/v2/coverage-report.js';
import { buildCurationTasks } from '../../src/domain/alias/curation/coverage-curation-task.js';

const COVERAGE_STATUSES: ReadonlySet<string> = new Set<CoverageStatus>([
  'resolved',
  'ambiguous',
  'failed',
  'redirect_discovery',
]);

interface HotsetRow {
  readonly qid: string;
  readonly query: string;
  readonly expectedStatus: CoverageStatus;
  readonly class: string;
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
    const qid = obj['qid'];
    const query = obj['query'];
    const expected = obj['expected_status'];
    if (typeof qid !== 'string' || typeof query !== 'string' || typeof expected !== 'string') continue;
    if (!COVERAGE_STATUSES.has(expected)) continue;
    rows.push({
      qid,
      query,
      expectedStatus: expected as CoverageStatus,
      class: typeof obj['class'] === 'string' ? obj['class'] : 'unclassified',
    });
  }
  return rows;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const { values } = parseArgs({
    args: argv,
    options: {
      corpus: { type: 'string', default: 'test/fixtures/lookup-v2-hotset.jsonl' },
      output: { type: 'string', default: '/tmp/lookup-v2-coverage-report.json' },
    },
  });
  const corpusPath = values.corpus ?? 'test/fixtures/lookup-v2-hotset.jsonl';
  const outputPath = values.output ?? '/tmp/lookup-v2-coverage-report.json';

  const hotset = parseHotset(corpusPath);
  if (hotset.length === 0) {
    throw new Error(`[elv2-coverage] empty hotset corpus: ${corpusPath}`);
  }

  const config = loadConfig();
  const container = await createContainer(config);

  const inputRows: CoverageInputRow[] = [];
  for (const row of hotset) {
    let observedStatus: CoverageStatus = 'failed';
    try {
      const result = await container.entityLookupV2UseCase.execute(
        { query: row.query, maxCandidates: LOOKUP_V2_DEFAULT_MAX_CANDIDATES, mode: 'default', requestId: `elv2-coverage-${row.qid}` },
        {},
      );
      observedStatus = result.status;
    } catch (err) {
      console.error(`[elv2-coverage] V2 failed for ${row.qid}:`, (err as Error).message);
    }
    inputRows.push({
      qid: row.qid,
      query: row.query,
      expectedStatus: row.expectedStatus,
      class: row.class,
      observedStatus,
    });
  }

  const report = buildCoverageReport(inputRows);
  // Turn every coverage hole into a curation task for the T-07 write plane queue.
  const curationTasks = buildCurationTasks(
    report.holes.map((hole) => ({
      surfaceForm: hole.query,
      holeClass: hole.class,
      observedStatus: hole.observedStatus,
    })),
  );

  writeFileSync(
    outputPath,
    JSON.stringify({ generatedAtNote: 'stamp externally', report, curationTasks }, null, 2),
    'utf8',
  );

  console.log(formatCoverageReport(report));
  console.log(`[elv2-coverage] curation tasks queued: ${curationTasks.length}`);
  for (const task of curationTasks) {
    console.log(`[elv2-coverage]   - [${task.holeClass}] "${task.surfaceForm}" → suggest ${task.suggestedAliasType} (${task.status})`);
  }
  console.log(`[elv2-coverage] report → ${outputPath}`);

  // Coverage is a curation signal, not a hard gate — always exit 0 (the operator
  // acts on the queued tasks). A degenerate (0-covered) run is visible in the report.
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('[elv2-coverage] FATAL', err);
  process.exit(2);
});

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
import { createContainer } from '../../src/config/container.js';
import { getPgPool } from '../../src/infrastructure/db/pg-pool.js';
import type { SearchRequest } from '../../src/application/search/search-request.dto.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';
import { LOOKUP_V2_DEFAULT_MAX_CANDIDATES } from '../../src/interface/http/constants.js';
import {
  buildShadowReport,
  type ShadowRow,
  type ShadowSideOutcome,
  type ShadowStatus,
} from './lookup-v2-shadow-metrics.js';

interface HotsetRow {
  readonly qid: string;
  readonly query: string;
  readonly expected_status: ShadowStatus;
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
    rows.push({
      qid,
      query,
      expected_status: expected as ShadowStatus,
      ...(typeof obj['expected_entity_hint'] === 'string' ? { expected_entity_hint: obj['expected_entity_hint'] } : {}),
      ...(typeof obj['class'] === 'string' ? { class: obj['class'] } : {}),
    });
  }
  return rows;
}

/** Map a V1 lookup response onto the shared 4-state shadow outcome. */
function v1Outcome(response: SearchResponseV1): ShadowSideOutcome {
  const status = response.engineDecision.decisionStatus;
  const top = response.results[0]?.entity;
  if (status === 'resolved' && top !== undefined) {
    return { status: 'resolved', topEntityId: String(top.entityId), topLabel: top.canonicalLabel };
  }
  // V1 has no redirect_discovery; ambiguous/failed pass through.
  return { status: status === 'ambiguous' ? 'ambiguous' : 'failed' };
}

async function main(): Promise<void> {
  // `pnpm run X -- --output Y` forwards a literal `--` terminator; drop it so
  // the forwarded options still parse (parseArgs treats `--` as end-of-options).
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const { values } = parseArgs({
    args: argv,
    options: {
      corpus: { type: 'string', default: 'test/fixtures/lookup-v2-hotset.jsonl' },
      output: { type: 'string', default: '/tmp/lookup-v2-shadow-report.json' },
    },
  });
  const corpusPath = values.corpus ?? 'test/fixtures/lookup-v2-hotset.jsonl';
  const outputPath = values.output ?? '/tmp/lookup-v2-shadow-report.json';

  const hotset = parseHotset(corpusPath);
  if (hotset.length === 0) {
    throw new Error(`[elv2-shadow] empty hotset corpus: ${corpusPath}`);
  }

  const config = loadConfig();
  // Inject the live RDS pool so the container's PG-backed blocker, calibration
  // store, and alias substrate are active. createContainer(config) without a
  // pool silently degrades (blocker=0 / calibration untrusted) — that is what
  // understated the 2026-06-02 shadow run.
  const container = await createContainer(config, getPgPool());

  const rows: ShadowRow[] = [];
  for (const row of hotset) {
    const requestId = `elv2-shadow-${row.qid}`;

    // V1 — legacy lookup path.
    let v1: ShadowSideOutcome = { status: 'failed' };
    try {
      const v1Request: SearchRequest = { query: row.query, primitiveRoute: 'lookup_wine' };
      const v1Response = await container.searchUseCase.execute(v1Request, requestId, {
        lookupAuthorityMode: 'legacy_core',
      });
      if (v1Response.queryType === 'search') {
        v1 = v1Outcome(v1Response);
      }
    } catch (err) {
      console.error(`[elv2-shadow] V1 failed for ${row.qid}:`, (err as Error).message);
    }

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
      expectedStatus: row.expected_status,
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
    JSON.stringify({ generatedAt: new Date().toISOString(), gitSha, corpus: corpusPath, rows, report }, null, 2),
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

  process.exit(report.gate.pass ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('[elv2-shadow] FATAL', err);
  process.exit(2);
});

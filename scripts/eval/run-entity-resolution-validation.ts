/**
 * Expanded entity-resolution validation: explicit legacy-core `lookup_wine`
 * vs dedicated V2 (`/v2/entity-lookup`) over the PG `eval_cases` ground truth,
 * scored by EXACT `expected_entity_id` match — far more rigorous than the
 * 15-query hotset.
 *
 * Scope (entity-semantic classes only — others lack a target entity and
 * conflate with concept-redirect, so they are excluded from the resolution
 * metric):
 *   should-resolve  : exact_entity, noisy_recall   (expected_entity_id present)
 *   should-NOT-resolve: ambiguous_short_form, no_match
 *
 * Per side, per case:
 *   should-resolve     → CORRECT if resolved AND entityId == expected_entity_id
 *                        WRONG   if resolved to a different entity
 *                        MISS    if not resolved
 *   should-not-resolve → CORRECT if not resolved (ambiguous/failed/redirect)
 *                        WRONG   if resolved (a wrong-positive)
 *
 * Usage:
 *   pnpm run eval:lookup-v2:authority -- \
 *     [--limit-per-class N] [--output <file.json>]
 *
 * Post-cutover note: direct SearchUseCase callers default to the
 * compatibility-backed current authority path. This script opts into
 * `legacy_core` explicitly so the comparison remains honest.
 */
import 'dotenv/config';
import process from 'node:process';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

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
  evaluatePerClassGate,
  type ClassTally,
  type PerClassEntry,
} from './lookup-v2-shadow-metrics.js';

const SHOULD_RESOLVE_CLASSES = ['exact_entity', 'noisy_recall'] as const;
const SHOULD_NOT_RESOLVE_CLASSES = ['ambiguous_short_form', 'no_match'] as const;
const ENTITY_CLASSES = [...SHOULD_RESOLVE_CLASSES, ...SHOULD_NOT_RESOLVE_CLASSES];

interface CaseRow {
  readonly query: string;
  readonly queryClass: string;
  readonly expectedStatus: string;
  readonly expectedEntityId: string | null;
}

interface SideOutcome {
  status: string;
  entityId?: string;
}

type Verdict = 'correct' | 'wrong' | 'miss';

function scoreVerdict(shouldResolve: boolean, expectedEntityId: string | null, o: SideOutcome): Verdict {
  if (shouldResolve) {
    if (o.status !== 'resolved') return 'miss';
    return o.entityId !== undefined && o.entityId === expectedEntityId ? 'correct' : 'wrong';
  }
  // should NOT resolve
  return o.status === 'resolved' ? 'wrong' : 'correct';
}

/**
 * SHA-256 content fingerprint over the SELECTED eval rows. eval_cases is NOT
 * versioned in the DB, so a row added/edited/deleted between two runs silently
 * invalidates a V1-vs-V2 comparison. The fingerprint pins a gate verdict to a
 * specific snapshot: each row is `query|query_class|expected_entity_id`
 * (empty string for a null id), the lines are SORTED so row ORDER does not
 * affect the hash, then joined with `\n` and hashed. Same rows ⇒ same hash;
 * any changed expected_entity_id ⇒ different hash.
 */
export function fingerprintEvalRows(
  rows: ReadonlyArray<{ query: string; queryClass: string; expectedEntityId: string | null }>,
): string {
  const lines = rows
    .map((r) => `${r.query}|${r.queryClass}|${r.expectedEntityId ?? ''}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

/**
 * Map the per-class verdict tallies into the shared {@link PerClassEntry} shape
 * so the SAME pure per-class gate that guards the hotset run guards the full
 * eval_cases distribution. `shouldResolve` follows the class's resolve
 * semantics (exact_entity / noisy_recall resolve; ambiguous_short_form /
 * no_match must abstain).
 */
export function toPerClassEntries(
  byClass: Record<string, { v1: ClassTally; v2: ClassTally }>,
  shouldResolveClasses: readonly string[],
): PerClassEntry[] {
  return Object.keys(byClass)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((queryClass) => {
      const slot = byClass[queryClass]!;
      return {
        queryClass,
        shouldResolve: shouldResolveClasses.includes(queryClass),
        v1: slot.v1,
        v2: slot.v2,
      };
    });
}

function parseArgs(argv: readonly string[]): {
  limitPerClass: number;
  output: string;
  runtimeStatePath?: string | undefined;
  useActiveRuntime: boolean;
} {
  let limitPerClass = 1000;
  let output = '/tmp/entity-resolution-validation.json';
  let runtimeStatePath: string | undefined;
  let useActiveRuntime = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit-per-class') {
      const n = Number.parseInt(argv[i + 1] ?? '', 10);
      if (Number.isFinite(n) && n > 0) limitPerClass = n;
      i += 1;
    } else if (argv[i] === '--output') {
      output = argv[i + 1] ?? output;
      i += 1;
    } else if (argv[i] === '--runtime-state') {
      runtimeStatePath = argv[i + 1] ?? runtimeStatePath;
      i += 1;
    } else if (argv[i] === '--use-active-runtime') {
      useActiveRuntime = true;
    }
  }
  return { limitPerClass, output, runtimeStatePath, useActiveRuntime };
}

async function main(): Promise<void> {
  const { limitPerClass, output, runtimeStatePath, useActiveRuntime } = parseArgs(process.argv.slice(2));
  if (runtimeStatePath === undefined && !useActiveRuntime) {
    throw new Error('Explicit runtime binding required: pass --runtime-state <path> or --use-active-runtime');
  }
  const effectiveRuntimeStatePath = runtimeStatePath ?? DEFAULT_RUNTIME_STATE_PATH;
  const config = loadConfig();
  const pool = getPgPool();
  const runtimeState = await loadSearchSnapshotRuntimeState(effectiveRuntimeStatePath);
  const container = await createLookupDirectContainer(config, {
    pool,
    searchSnapshotId: runtimeState.snapshotId,
    searchSnapshotManifestPath: runtimeState.manifestPath,
    searchSnapshotFieldAvailability: runtimeState.fieldAvailability,
  });

  const { rows: caseRows } = await pool.query<CaseRow>(
    `SELECT query, query_class AS "queryClass", expected_status AS "expectedStatus",
            expected_entity_id AS "expectedEntityId"
       FROM eval_cases
      WHERE query_class = ANY($1::text[])
      ORDER BY query_class, created_at ASC`,
    [ENTITY_CLASSES],
  );

  // Cap per class for quick runs.
  const perClassCount = new Map<string, number>();
  const cases = caseRows.filter((c) => {
    const n = (perClassCount.get(c.queryClass) ?? 0) + 1;
    perClassCount.set(c.queryClass, n);
    return n <= limitPerClass;
  });

  process.stderr.write(`[er-validation] scoring ${String(cases.length)} entity-semantic cases\n`);

  interface Tally { correct: number; wrong: number; miss: number; total: number }
  const mk = (): Tally => ({ correct: 0, wrong: 0, miss: 0, total: 0 });
  const byClass: Record<string, { v1: Tally; v2: Tally }> = {};
  const detail: unknown[] = [];

  let i = 0;
  for (const c of cases) {
    i += 1;
    const requestId = `er-val-${String(i)}`;
    const shouldResolve = (SHOULD_RESOLVE_CLASSES as readonly string[]).includes(c.queryClass);

    // V2-only cutover: the legacy `/v1` lookup seam (SearchUseCase
    // primitiveRoute='lookup_wine' + lookupAuthorityMode='legacy_core') was
    // REMOVED. EntityLookupV2 is the sole lookup authority, so this validation
    // is now V2-absolute. The V1 column is retained as a removed-marker only so
    // the report/gate shape stays stable; it is not executed.
    const v1: SideOutcome = { status: 'failed' };

    let v2: SideOutcome = { status: 'failed' };
    try {
      const res = await container.entityLookupV2UseCase.execute(
        { query: c.query, maxCandidates: LOOKUP_V2_DEFAULT_MAX_CANDIDATES, mode: 'default', requestId },
        {},
      );
      v2 = res.topCandidate !== null
        ? { status: res.status, entityId: String(res.topCandidate.entityId) }
        : { status: res.status };
    } catch {
      v2 = { status: 'error' };
    }

    const v1Verdict = scoreVerdict(shouldResolve, c.expectedEntityId, v1);
    const v2Verdict = scoreVerdict(shouldResolve, c.expectedEntityId, v2);

    byClass[c.queryClass] ??= { v1: mk(), v2: mk() };
    const slot = byClass[c.queryClass]!;
    slot.v1[v1Verdict] += 1; slot.v1.total += 1;
    slot.v2[v2Verdict] += 1; slot.v2.total += 1;

    detail.push({ query: c.query, queryClass: c.queryClass, expectedStatus: c.expectedStatus,
      expectedEntityId: c.expectedEntityId, v1, v1Verdict, v2, v2Verdict });

    if (i % 20 === 0) process.stderr.write(`[er-validation] ${String(i)}/${String(cases.length)}\n`);
  }

  // Aggregate.
  const overall = { v1: mk(), v2: mk() };
  for (const k of Object.keys(byClass)) {
    for (const side of ['v1', 'v2'] as const) {
      const t = byClass[k]![side];
      overall[side].correct += t.correct; overall[side].wrong += t.wrong;
      overall[side].miss += t.miss; overall[side].total += t.total;
    }
  }

  const pct = (n: number, d: number): string => (d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`);
  process.stderr.write('\n=== Entity-resolution validation (exact expected_entity_id match) ===\n');
  for (const k of ENTITY_CLASSES) {
    const b = byClass[k];
    if (b === undefined) continue;
    process.stderr.write(
      `${k} (n=${String(b.v1.total)}):\n` +
      `  V1: correct=${String(b.v1.correct)} (${pct(b.v1.correct, b.v1.total)}) wrong=${String(b.v1.wrong)} miss=${String(b.v1.miss)}\n` +
      `  V2: correct=${String(b.v2.correct)} (${pct(b.v2.correct, b.v2.total)}) wrong=${String(b.v2.wrong)} miss=${String(b.v2.miss)}\n`,
    );
  }
  process.stderr.write(
    `OVERALL (n=${String(overall.v1.total)}):\n` +
    `  V1: correct=${String(overall.v1.correct)} (${pct(overall.v1.correct, overall.v1.total)}) wrong=${String(overall.v1.wrong)} miss=${String(overall.v1.miss)}\n` +
    `  V2: correct=${String(overall.v2.correct)} (${pct(overall.v2.correct, overall.v2.total)}) wrong=${String(overall.v2.wrong)} miss=${String(overall.v2.miss)}\n`,
  );

  // Gate-eligibility verdict: the FULL distribution is the authority, not the
  // 15-hotset. Per-class no-regression gate (incl. 0-wrong-positive on the
  // abstain classes) decides cutover eligibility.
  const perClass = toPerClassEntries(byClass, SHOULD_RESOLVE_CLASSES);
  const gate = evaluatePerClassGate(perClass);
  // Pin the verdict to the exact eval_cases snapshot it was computed over.
  const evalCasesFingerprint = fingerprintEvalRows(
    cases.map((c) => ({ query: c.query, queryClass: c.queryClass, expectedEntityId: c.expectedEntityId })),
  );

  process.stderr.write(
    `\n=== Cutover gate (full-distribution authority) ===\n` +
    `  verdict: ${gate.pass ? 'PASS (cutover-eligible)' : 'FAIL'}\n` +
    (gate.reasons.length > 0 ? `  reasons:\n${gate.reasons.map((r) => `    - ${r}`).join('\n')}\n` : '') +
    `  eval_cases fingerprint (sha256): ${evalCasesFingerprint}\n`,
  );

  writeFileSync(
    output,
    `${JSON.stringify({
      runtime: {
        runtime_state_path: effectiveRuntimeStatePath,
        runtime_state_schema: runtimeState.schemaVersion,
        manifest_schema: SEARCH_SNAPSHOT_SCHEMA_VERSION,
        snapshot_id: runtimeState.snapshotId,
        artifact_hashes: runtimeState.hashes,
      },
      byClass,
      overall,
      perClass,
      gate,
      evalCasesFingerprint,
      detail,
    }, null, 2)}\n`,
    'utf8',
  );
  process.stderr.write(`[er-validation] report → ${output}\n`);
  await pool.end();
}

// Only run the live DB-backed validation when invoked as the entrypoint. Pure
// helpers above (gate + fingerprint) are imported by unit tests, which must NOT
// trigger a PG connection.
const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`[er-validation] failed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
}

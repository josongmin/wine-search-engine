import { URL } from 'node:url';
import { loadConfig } from '../../src/config/env.js';
import { createPgPool, shouldUsePgPool } from '../../src/infrastructure/db/pg-pool.js';
import { loadSearchSnapshotRuntimeState } from '../../src/infrastructure/health/search-snapshot-readiness.js';
import { verifyRuntimeGoldCatalogCoverage } from '../etl/verify-runtime-gold-catalog-coverage.js';
import { resolveDefaultFixtureRepoRoot } from '../etl/snapshot-entity-identity.js';

export type BenchmarkExecutionLane = 'public' | 'trusted_benchmark';

interface ReadyResponse {
  readonly ready: boolean;
  readonly checks?: Readonly<Record<string, { readonly status: 'up' | 'down' | 'skipped'; readonly required: boolean }>>;
}

export interface LiveBenchmarkRuntimeMetadata {
  readonly readinessPassed: boolean;
  readonly searchSnapshotId?: string | undefined;
  readonly runtimeActivationStatus?: 'activated' | 'shadow_only' | undefined;
  readonly activeLtrModels?: number | undefined;
}

export interface LiveBenchmarkReadinessOptions {
  readonly requiredOptionalChecks?: readonly string[] | undefined;
}

export function resolveBenchmarkSearchEndpoint(
  apiUrl: string,
  executionLane: BenchmarkExecutionLane,
): string {
  return `${apiUrl}${executionLane === 'trusted_benchmark' ? '/internal/benchmark/search' : '/v1/search'}`;
}

export function buildBenchmarkRequestHeaders(
  executionLane: BenchmarkExecutionLane,
  debugKey?: string,
): Record<string, string> {
  if (executionLane === 'trusted_benchmark') {
    if (debugKey === undefined || debugKey.length === 0) {
      throw new Error(
        'trusted_benchmark lane requires --debug-key (or BENCHMARK_DEBUG_KEY / HTTP_DEBUG_SECRET env).',
      );
    }
    return {
      'content-type': 'application/json',
      'x-debug-key': debugKey,
    };
  }

  return { 'content-type': 'application/json' };
}

function formatReadyChecks(checks: ReadyResponse['checks']): string {
  if (checks === undefined) {
    return 'no readiness detail returned';
  }
  return Object.entries(checks)
    .map(([name, check]) => `${name}=${check.status}${check.required ? '' : '(optional)'}`)
    .join(', ');
}

function formatRequiredOptionalReadinessFailures(
  checks: ReadyResponse['checks'],
  requiredOptionalChecks: readonly string[],
): string {
  return requiredOptionalChecks
    .flatMap((name) => {
      const check = checks?.[name];
      if (check?.status === 'up') {
        return [];
      }
      return `${name}=${check?.status ?? 'missing'}`;
    })
    .join(', ');
}

export async function assertLiveBenchmarkReadiness(
  apiUrl: string,
  options: LiveBenchmarkReadinessOptions = {},
): Promise<void> {
  const response = await fetch(`${apiUrl}/ready`);
  if (!response.ok) {
    throw new Error(`Live benchmark preflight failed: GET /ready returned HTTP ${response.status}`);
  }

  const body = (await response.json()) as ReadyResponse;
  if (body.ready !== true) {
    throw new Error(
      `Live benchmark preflight failed: runtime is not ready (${formatReadyChecks(body.checks)})`,
    );
  }

  const requiredOptionalFailures = formatRequiredOptionalReadinessFailures(
    body.checks,
    options.requiredOptionalChecks ?? [],
  );
  if (requiredOptionalFailures.length > 0) {
    throw new Error(
      `Live benchmark preflight failed: required optional readiness checks are not up (${requiredOptionalFailures}).`,
    );
  }
}

export async function collectLiveBenchmarkRuntimeMetadata(
  apiUrl: string,
  options: LiveBenchmarkReadinessOptions = {},
): Promise<LiveBenchmarkRuntimeMetadata> {
  const response = await fetch(`${apiUrl}/ready`);
  if (!response.ok) {
    return { readinessPassed: false };
  }

  const body = (await response.json()) as ReadyResponse;
  const requiredOptionalFailures = formatRequiredOptionalReadinessFailures(
    body.checks,
    options.requiredOptionalChecks ?? [],
  );
  const readinessPassed = body.ready === true && requiredOptionalFailures.length === 0;
  if (!isLocalApiUrl(apiUrl)) {
    return { readinessPassed };
  }

  try {
    const runtimeState = await loadSearchSnapshotRuntimeState();
    return {
      readinessPassed,
      searchSnapshotId: runtimeState.snapshotId,
      runtimeActivationStatus: runtimeState.ltrReleaseProvenance?.activationStatus,
      activeLtrModels: runtimeState.counts.activeLtrModels,
    };
  } catch {
    return { readinessPassed };
  }
}

/**
 * ADR-007: verify the active snapshot's `entities` plane AND the
 * `canonical_entities` graph plane both contain every fixture canonical id
 * the bench requires. Both planes must agree — `entities` alone can drift
 * across snapshots (stale rows), and `canonical_entities` alone does not
 * imply the active snapshot indexed them. Errors are scoped to the active
 * snapshot id so a wrong-snapshot run is diagnosed immediately.
 *
 * Falls back to the legacy explicit-id list path only when no fixture repo
 * is resolvable; that path still scopes to the active snapshot id.
 */
export async function assertRuntimeEntityCompatibility(
  requiredEntityIds: readonly string[],
): Promise<void> {
  const deduped = [...new Set(requiredEntityIds)].sort((left, right) => left.localeCompare(right));
  if (deduped.length === 0) {
    return;
  }

  const config = loadConfig();
  if (!shouldUsePgPool(config.pg)) {
    throw new Error(
      'Live benchmark preflight failed: Postgres config unavailable, cannot verify runtime entity compatibility.',
    );
  }

  const fixtureRoot = resolveDefaultFixtureRepoRoot();
  let activeSnapshotId: string | undefined;
  try {
    const runtimeState = await loadSearchSnapshotRuntimeState();
    activeSnapshotId = runtimeState.snapshotId;
  } catch {
    activeSnapshotId = undefined;
  }

  const pool = createPgPool(config.pg);
  try {
    if (fixtureRoot != null && activeSnapshotId != null) {
      // SSoT path: same gate the publisher runs at promote-time, scoped to
      // the currently active snapshot id. Diagnoses snapshot mismatch and
      // graph-plane drift in one error message.
      try {
        await verifyRuntimeGoldCatalogCoverage({
          pool,
          snapshotId: activeSnapshotId,
          fixtureRepoRoot: fixtureRoot,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Live benchmark preflight failed (snapshot=${activeSnapshotId}): ${detail}`,
        );
      }
      return;
    }

    // Legacy fallback: caller-supplied id list, but still scope to active
    // snapshot id when we have one so a stale-row false-positive cannot
    // mask the failure.
    const snapshotClause = activeSnapshotId != null ? ' AND search_snapshot_id = $2' : '';
    const params: readonly unknown[] = activeSnapshotId != null
      ? [deduped, activeSnapshotId]
      : [deduped];
    const result = await pool.query<{ entity_id: string }>(
      `SELECT entity_id
         FROM entities
        WHERE entity_id = ANY($1::text[])${snapshotClause}`,
      params,
    );
    const present = new Set(result.rows.map((row) => row.entity_id));
    const missing = deduped.filter((entityId) => !present.has(entityId));
    if (missing.length > 0) {
      const scope = activeSnapshotId != null ? ` (snapshot=${activeSnapshotId})` : '';
      throw new Error(
        `Live benchmark preflight failed${scope}: runtime entities missing ${missing.length} fixture canonical IDs (${missing.slice(0, 20).join(', ')})`,
      );
    }
  } finally {
    await pool.end();
  }
}

export async function assertTrustedBenchmarkLaneAccessible(
  apiUrl: string,
  debugKey: string,
): Promise<void> {
  const response = await fetch(`${apiUrl}/internal/benchmark/search`, {
    method: 'POST',
    headers: buildBenchmarkRequestHeaders('trusted_benchmark', debugKey),
    body: JSON.stringify({ query: 'Opus One 2018' }),
  });

  if (response.status === 403) {
    throw new Error('trusted_benchmark lane rejected the provided debug key.');
  }
  if (!response.ok) {
    throw new Error(
      `trusted_benchmark lane probe failed with HTTP ${response.status}`,
    );
  }
}

export async function runLiveBenchmarkPreflight(args: {
  readonly apiUrl: string;
  readonly executionLane: BenchmarkExecutionLane;
  readonly debugKey?: string;
  readonly requiredEntityIds?: readonly string[] | undefined;
  readonly readiness?: LiveBenchmarkReadinessOptions | undefined;
}): Promise<void> {
  await assertLiveBenchmarkReadiness(args.apiUrl, args.readiness);
  if (args.requiredEntityIds !== undefined && args.requiredEntityIds.length > 0) {
    await assertRuntimeEntityCompatibility(args.requiredEntityIds);
  }
  if (args.executionLane === 'trusted_benchmark') {
    await assertTrustedBenchmarkLaneAccessible(args.apiUrl, args.debugKey ?? '');
  }
}

export function isLocalApiUrl(apiUrl: string): boolean {
  const parsed = new URL(apiUrl);
  return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
}

import { URL } from 'node:url';
import { loadConfig } from '../../src/config/env.js';
import { createPgPool, shouldUsePgPool } from '../../src/infrastructure/db/pg-pool.js';

export type BenchmarkExecutionLane = 'public' | 'trusted_benchmark';

interface ReadyResponse {
  readonly ready: boolean;
  readonly checks?: Readonly<Record<string, { readonly status: 'up' | 'down' | 'skipped'; readonly required: boolean }>>;
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

export async function assertLiveBenchmarkReadiness(apiUrl: string): Promise<void> {
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
}

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

  const pool = createPgPool(config.pg);
  try {
    const result = await pool.query<{ entity_id: string }>(
      `SELECT entity_id
       FROM entities
       WHERE entity_id = ANY($1::text[])`,
      [deduped],
    );
    const present = new Set(result.rows.map((row) => row.entity_id));
    const missing = deduped.filter((entityId) => !present.has(entityId));
    if (missing.length > 0) {
      throw new Error(
        `Live benchmark preflight failed: runtime entities missing ${missing.length} fixture canonical IDs (${missing.slice(0, 20).join(', ')})`,
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
}): Promise<void> {
  await assertLiveBenchmarkReadiness(args.apiUrl);
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

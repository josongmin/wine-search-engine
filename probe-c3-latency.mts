/**
 * C3 latency probe: per-phase timing breakdown for the hybrid search path.
 *
 * Runs a small set of representative queries through `searchUseCase.execute`,
 * captures the request-scoped stageTimer snapshot, and prints (a) wall-clock
 * total and (b) the contribution of each pipeline stage so we can pinpoint
 * the dominant cost driver before applying any optimization.
 *
 * Usage:  npx tsx probe-c3-latency.mts [iterations]
 */

import { createContainer } from './src/config/container.js';
import { loadConfig } from './src/config/env.js';
import { createManagedRuntimeHandles } from './src/config/runtime-handles.js';
import { createPgPool, shouldUsePgPool } from './src/infrastructure/db/pg-pool.js';
import { connectRedisClient } from './src/infrastructure/db/redis-client.js';
import { createStageTimer } from './src/observability/stage-timer.js';

const QUERIES: ReadonlyArray<{ readonly q: string; readonly note: string }> = [
  { q: 'Cabernet Sauvignon', note: 'English grape — popular' },
  { q: 'Pinot Noir from Burgundy', note: 'grape + region' },
  { q: '카베르네 소비뇽', note: 'Korean grape' },
  { q: 'Barolo', note: 'Italian region' },
  { q: 'Champagne', note: 'sparkling region' },
  { q: 'Chardonnay', note: 'white grape' },
  { q: 'Bordeaux 2015', note: 'region + vintage' },
  { q: '리델 와인 추천', note: 'Korean wine recommendation' },
  { q: 'Riesling sweet', note: 'grape + style' },
  { q: '레드 와인', note: 'Korean wine type' },
  { q: 'Sauvignon Blanc', note: 'white grape' },
  { q: 'Italian red wine', note: 'origin + type' },
  { q: 'Tuscany red', note: 'region + type' },
  { q: 'Australian Shiraz', note: 'origin + grape' },
  { q: 'dry white wine', note: 'style descriptor' },
];

const STAGES_OF_INTEREST = [
  'search.total',
  'search.pre_route',
  'pre_route.security_gate',
  'pre_route.planner',
  'planner.anchor_extraction',
  'planner.fuzzy_anchor_lookup',
  'planner.query_class',
  'planner.constraint_parsing',
  'planner.ambiguity_intent_compilation',
  'planner.expansion_build',
  'planner.compute_uncertainty',
  'pre_route.decomposition.detect',
  'pre_route.decomposition.execute',
  'search.route_execution',
  'search.post_route',
  'hybrid.retrieval',
  'hybrid.ranking',
  'retrieval.parallel_fanout',
  'retrieval.sparse_bm25',
  'retrieval.learned_sparse',
  'retrieval.dense_semantic',
  'retrieval.anchor_similarity',
  'ranking.primary_scoring',
  'ranking.cross_encoder',
  'ranking.cross_encoder.remote',
  'ranking.cross_encoder.postprocess',
  'ranking.evidence_mapping',
  'ranking.ltr',
] as const;

function pct(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? Number.NaN;
}

function fmt(ms: number): string {
  return Number.isFinite(ms) ? `${ms.toFixed(0)}ms` : '   n/a';
}

async function main(): Promise<void> {
  const iterations = Number(process.argv[2] ?? '1');
  const config = loadConfig();

  let pool: ReturnType<typeof createPgPool> | undefined;
  if (shouldUsePgPool(config.pg)) {
    pool = createPgPool(config.pg);
  }
  let redisClient: Awaited<ReturnType<typeof connectRedisClient>> | null = null;
  try {
    redisClient = await connectRedisClient(config.redis);
  } catch (err) {
    console.error(`  [INIT] Redis unavailable (${err instanceof Error ? err.message : String(err)}) — proceeding without`);
  }
  const managed = createManagedRuntimeHandles({
    ...(pool ? { pool } : {}),
    ...(redisClient ? { redisClient } : {}),
  });
  const container = await createContainer(config, managed);

  const allTotals: number[] = [];
  const stageSeries = new Map<string, number[]>();
  const perQuery: Array<{ query: string; total: number; snapshot: Record<string, number> }> = [];

  console.log(`\n=== C3 latency probe — ${QUERIES.length} queries × ${iterations} iter ===\n`);

  for (let iter = 0; iter < iterations; iter += 1) {
    for (const { q, note } of QUERIES) {
      const stageTimer = createStageTimer();
      const wallStart = performance.now();
      try {
        await container.searchUseCase.execute(
          { query: q, retrieval_mode: 'hybrid', limit: 10 },
          `probe-c3-${iter}-${Date.now()}`,
          { stageTimer },
        );
      } catch (err) {
        console.error(`[ERR] "${q}": ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const wallTotal = performance.now() - wallStart;
      allTotals.push(wallTotal);
      const snap = stageTimer.snapshot();
      for (const stage of STAGES_OF_INTEREST) {
        const v = snap[stage];
        if (v !== undefined) {
          let series = stageSeries.get(stage);
          if (series === undefined) {
            series = [];
            stageSeries.set(stage, series);
          }
          series.push(v);
        }
      }
      perQuery.push({ query: `${q} (${note})`, total: wallTotal, snapshot: snap });
    }
  }

  // Sort per-query records by wall-time desc for the worst-case readout.
  perQuery.sort((a, b) => b.total - a.total);

  console.log('--- WORST-CASE TOP 5 (by wall-clock) ---');
  for (const row of perQuery.slice(0, 5)) {
    console.log(`\n  "${row.query}"  total=${fmt(row.total)}`);
    for (const stage of STAGES_OF_INTEREST) {
      const ms = row.snapshot[stage];
      if (ms !== undefined) {
        console.log(`    ${stage.padEnd(40)} ${fmt(ms)}`);
      }
    }
  }

  console.log('\n--- AGGREGATE p50 / p95 PER STAGE ---');
  console.log(`${'stage'.padEnd(42)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'n'.padStart(4)}`);
  for (const stage of STAGES_OF_INTEREST) {
    const series = stageSeries.get(stage);
    if (series === undefined || series.length === 0) continue;
    console.log(
      `${stage.padEnd(42)} ${fmt(pct(series, 50)).padStart(8)} ${fmt(pct(series, 95)).padStart(8)} ${String(series.length).padStart(4)}`,
    );
  }

  console.log('\n--- WALL TOTAL ---');
  console.log(`  p50=${fmt(pct(allTotals, 50))}  p95=${fmt(pct(allTotals, 95))}  n=${allTotals.length}`);

  // Best-effort shutdown so the script exits promptly.
  if (redisClient) {
    try { await redisClient.quit(); } catch { /* ignore */ }
  }
  if (pool) {
    try { await pool.end(); } catch { /* ignore */ }
  }
  process.exit(0);
}

void main().catch((err) => {
  console.error('probe-c3-latency failed:', err);
  process.exit(1);
});

import { writeFileSync } from 'node:fs';
import { loadConfig } from '../../src/config/env.js';
import { createStageTimer } from '../../src/domain/shared/stage-timer.js';

async function main() {
  try {
    const config = loadConfig();
    const { createContainer } = await import('../../src/config/container.js');
    const container = await createContainer(config);
    const executionPrincipal = process.env.TIMER_PROBE_EXECUTION_PRINCIPAL === 'public'
      ? 'public'
      : 'benchmark_trusted';

    // Run 3 queries: cold, warm, warm — measure pre_route specifically
    const queries = ['prosecco', '피노 그리지오 추천', 'Opus One 2018'];
    const results: Record<string, unknown>[] = [];

    for (const query of queries) {
      const timer = createStageTimer();
      const result = await container.searchUseCase.execute(
        { query },
        `probe-${query}`,
        {
          stageTimer: timer,
          executionPrincipal,
        },
      );
      const snap = timer.snapshot();
      results.push({
        executionPrincipal,
        query,
        resultType: result.queryType,
        resultCount: result.queryType === 'search' ? result.results.length : 0,
        stages: snap,
        preRouteMs: snap['search.pre_route'] ?? null,
        routeExecMs: snap['search.route_execution'] ?? null,
        retrievalMs: snap['hybrid.retrieval'] ?? null,
        rankingMs: snap['hybrid.ranking'] ?? null,
        denseMs: snap['retrieval.dense_semantic'] ?? null,
        sparseMs: snap['retrieval.sparse_bm25'] ?? null,
        totalMs: snap['search.total'] ?? null,
      });
    }

    writeFileSync('/tmp/timer-test.json', JSON.stringify(results, null, 2));
  } catch (e) {
    writeFileSync('/tmp/timer-test.json', 'ERROR: ' + String(e) + '\n' + ((e as Error).stack ?? ''));
  }
  process.exit(0);
}
main();

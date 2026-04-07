import { describe, expect, it, vi } from 'vitest';
import { BatchSearchUseCase } from '../batch-search.usecase.js';
import type { SearchExecutorPort } from '../port/search-executor.port.js';
import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';

function makeSuccessResponse(): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: {
      decisionStatus: 'resolved',
      nextAction: 'return_result',
      route: 'hybrid',
      decisionConfidence: 0.9,
      confidenceSemantics: 'calibrated_decision_confidence',
      decisionTraceRef: 'trace-1',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1.0.0',
        threshold_profile_id: 'default',
        planner_version: '1.0.0',
        feature_flags: {},
      },
    },
    results: [],
    meta: {
      requestId: 'req-1',
      queryTimeMs: 10,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
    },
  };
}

describe('BatchSearchUseCase — fail_fast mode', () => {
  it('reports failed: 1, not_executed: N-1 when first item fails', async () => {
    const executor: SearchExecutorPort = {
      execute: vi.fn()
        .mockRejectedValueOnce(new Error('something went wrong'))
        .mockResolvedValue(makeSuccessResponse()),
    };

    const useCase = new BatchSearchUseCase(executor);
    const result = await useCase.execute(
      [
        { id: 'a', query: 'Opus One 2018' },
        { id: 'b', query: 'Petrus 2000' },
        { id: 'c', query: 'Screaming Eagle 2019' },
      ],
      { fail_fast: true },
    );

    expect(result.failed).toBe(1);
    expect(result.not_executed).toBe(2);
    expect(result.succeeded).toBe(0);
    expect(result.batch_status).toBe('failed');
    expect(result.has_failures).toBe(true);
    expect(result.total).toBe(3);

    // The first item actually ran and failed
    expect(result.results[0]).toMatchObject({ id: 'a', status: 'failed' });

    // The remaining items were never started
    expect(result.results[1]).toMatchObject({ id: 'b', status: 'not_executed' });
    expect(result.results[2]).toMatchObject({ id: 'c', status: 'not_executed' });

    // The executor should only have been called once (fail-fast stopped early)
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('reports failed: 1, not_executed: 0 when only last item fails', async () => {
    const executor: SearchExecutorPort = {
      execute: vi.fn()
        .mockResolvedValueOnce(makeSuccessResponse())
        .mockResolvedValueOnce(makeSuccessResponse())
        .mockRejectedValueOnce(new Error('last item error')),
    };

    const useCase = new BatchSearchUseCase(executor);
    const result = await useCase.execute(
      [
        { id: 'a', query: 'Opus One 2018' },
        { id: 'b', query: 'Petrus 2000' },
        { id: 'c', query: 'Screaming Eagle 2019' },
      ],
      { fail_fast: true },
    );

    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.not_executed).toBe(0);
    expect(result.batch_status).toBe('partial_failure');
    expect(result.total).toBe(3);
  });
});

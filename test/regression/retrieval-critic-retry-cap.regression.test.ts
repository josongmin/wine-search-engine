/**
 * ADR-015 Axis 2 invariants: type-level retry cap + executor loop
 * termination semantics.
 *
 * Locks:
 *   - `CRITIC_RETRY_MAX === 3` at module-load time. Bumping the value
 *     requires editing this regression test, which forces an explicit
 *     ADR-015 amendment review.
 *   - The executor loop terminates after at most `CRITIC_RETRY_MAX`
 *     retrieval iterations under any worst-case decision sequence.
 *   - `RETRIEVAL_CRITIC_RETRIES_EXHAUSTED_COUNT` increments exactly
 *     once on exhaustion.
 *   - `RETRIEVAL_EXECUTOR_CRITIC=false` → byte-identical pre-PR6
 *     one-shot path; the loop is never entered.
 *
 * Append-only test: never delete this file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CRITIC_RETRY_MAX } from '../../src/domain/retrieval/service/retrieval-critic.js';
import {
  executeGraphAware,
  type CriticSignalProbe,
  type GraphExecutorDeps,
  type GraphExecutorOptions,
} from '../../src/application/search/search-usecase-graph-executor.js';
import { BundleSelectorImpl } from '../../src/domain/retrieval/service/bundle-selector.js';
import { globalRetrievalCriticCounter } from '../../src/observability/retrieval-critic-counters.js';
import type { ConstraintGraph } from '../../src/domain/query/model/constraint-graph.js';
import type { CandidatePoolPort } from '../../src/application/search/port/search-pipeline-deps.port.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';
import type { HybridRetrievalInput } from '../../src/domain/retrieval/model/retrieval-input.js';
import type { QueryRewriter, RewriteResult } from '../../src/domain/retrieval/service/query-rewriter.js';

describe('CRITIC_RETRY_MAX type-level lock', () => {
  it('CRITIC_RETRY_MAX === 3', () => {
    expect(CRITIC_RETRY_MAX).toBe(3);
  });
});

function mkCandidate(id: string): HybridCandidate {
  return { entityId: id as never, retrievalTraces: [] } as unknown as HybridCandidate;
}

const STUB_INPUT = {
  queryPlan: {
    normalizedQuery: 'q',
    rawQuery: 'q',
    constraints: { hard: [], soft: [], inferred: [] },
  } as never,
  route: 'hybrid',
  lexicalQueries: ['q'],
  semanticQueries: ['q'],
  hardConstraints: [],
  softConstraints: [],
} as unknown as HybridRetrievalInput;

function trivialGraph(): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1',
    origin: 'deterministic_from_atoms',
    rootNodeId: 'root',
    nodes: [{ kind: 'group_and', nodeId: 'root', children: [] }],
    edges: [],
    globalBudgets: {},
  };
}

const POOL_OUT = [mkCandidate('c-1'), mkCandidate('c-2')];

const stubPool: CandidatePoolPort = {
  execute: async () => POOL_OUT,
  generate: async () => POOL_OUT,
};

const noOpOpts: GraphExecutorOptions = {
  scoreFor: () => 0,
  priceFor: () => 0,
};

/** A rewriter that always succeeds — forces the loop to hit the cap. */
function alwaysReformulateRewriter(): QueryRewriter {
  return {
    apply: async (input): Promise<RewriteResult> => ({
      input,
      trace: {
        rewriteType: 'reformulate',
        subqueryId: 'root',
        promptVersion: 'critic_reformulate_v1',
        reformulatedQuery: 'rewritten',
      },
    }),
  };
}

/** Probe that always reports zero coverage so the critic always wants to retry. */
const zeroCoverageProbe: CriticSignalProbe = {
  coverageSignalsFor: () => ({
    satisfiedAttributes: new Set<string>(),
  }),
  degradationCodesFor: () => ['no_matches'],
};

describe('executor critic retry loop termination', () => {
  beforeEach(() => {
    globalRetrievalCriticCounter.reset();
    process.env['RETRIEVAL_EXECUTOR_CRITIC'] = 'true';
  });
  afterEach(() => {
    delete process.env['RETRIEVAL_EXECUTOR_CRITIC'];
    globalRetrievalCriticCounter.reset();
  });

  it('hard-caps at CRITIC_RETRY_MAX iterations even when critic always wants to retry', async () => {
    let executeCalls = 0;
    const countingPool: CandidatePoolPort = {
      execute: async () => {
        executeCalls += 1;
        return POOL_OUT;
      },
      generate: async () => POOL_OUT,
    };
    const deps: GraphExecutorDeps = {
      candidatePool: countingPool,
      bundleSelector: new BundleSelectorImpl(),
      queryRewriter: alwaysReformulateRewriter(),
    };
    // Use a graph whose computeGraphCoverage produces non-trivial output
    // so the critic's no_signal_to_act_on branch does not fire.
    const graph = {
      ...trivialGraph(),
      nodes: [
        { kind: 'group_and', nodeId: 'root', children: ['slot_a'] },
        {
          kind: 'slot',
          nodeId: 'slot_a',
          atomRef: '0',
          attribute: 'color',
          operator: '=',
          value: 'red',
          sourceTier: 'hard',
          sourceKind: 'explicit_utterance',
          confidence: 1,
        },
      ],
    } as unknown as ConstraintGraph;
    const result = await executeGraphAware(
      STUB_INPUT,
      graph,
      deps,
      noOpOpts,
      zeroCoverageProbe,
    );
    // Initial retrieval + CRITIC_RETRY_MAX retries = CRITIC_RETRY_MAX + 1 calls.
    expect(executeCalls).toBe(CRITIC_RETRY_MAX + 1);
    expect(result.criticRetriesExhausted).toBe(true);
    expect(result.criticDegradationReasons).toContain('critic_retries_exhausted');
  });

  it('exhaustion increments RETRIEVAL_CRITIC_RETRIES_EXHAUSTED_COUNT exactly once', async () => {
    const deps: GraphExecutorDeps = {
      candidatePool: stubPool,
      bundleSelector: new BundleSelectorImpl(),
      queryRewriter: alwaysReformulateRewriter(),
    };
    const graph = {
      ...trivialGraph(),
      nodes: [
        { kind: 'group_and', nodeId: 'root', children: ['slot_a'] },
        {
          kind: 'slot',
          nodeId: 'slot_a',
          atomRef: '0',
          attribute: 'color',
          operator: '=',
          value: 'red',
          sourceTier: 'hard',
          sourceKind: 'explicit_utterance',
          confidence: 1,
        },
      ],
    } as unknown as ConstraintGraph;
    await executeGraphAware(STUB_INPUT, graph, deps, noOpOpts, zeroCoverageProbe);
    expect(
      globalRetrievalCriticCounter.snapshot().RETRIEVAL_CRITIC_RETRIES_EXHAUSTED_COUNT,
    ).toBe(1);
  });

  it('flag off → byte-identical to one-shot path; counter does not increment', async () => {
    process.env['RETRIEVAL_EXECUTOR_CRITIC'] = 'false';
    let executeCalls = 0;
    const countingPool: CandidatePoolPort = {
      execute: async () => {
        executeCalls += 1;
        return POOL_OUT;
      },
      generate: async () => POOL_OUT,
    };
    const deps: GraphExecutorDeps = {
      candidatePool: countingPool,
      bundleSelector: new BundleSelectorImpl(),
      queryRewriter: alwaysReformulateRewriter(),
    };
    const result = await executeGraphAware(
      STUB_INPUT,
      trivialGraph(),
      deps,
      noOpOpts,
      zeroCoverageProbe,
    );
    expect(executeCalls).toBe(1);
    expect(result.criticRewrites).toBeUndefined();
    expect(result.criticRetriesExhausted).toBeUndefined();
    expect(
      globalRetrievalCriticCounter.snapshot().RETRIEVAL_CRITIC_RETRIES_EXHAUSTED_COUNT,
    ).toBe(0);
  });

  it('rewriter declining (null) breaks the loop without firing extra retrievals', async () => {
    let executeCalls = 0;
    const countingPool: CandidatePoolPort = {
      execute: async () => {
        executeCalls += 1;
        return POOL_OUT;
      },
      generate: async () => POOL_OUT,
    };
    const decliningRewriter: QueryRewriter = {
      apply: async () => null,
    };
    const deps: GraphExecutorDeps = {
      candidatePool: countingPool,
      bundleSelector: new BundleSelectorImpl(),
      queryRewriter: decliningRewriter,
    };
    const graph = {
      ...trivialGraph(),
      nodes: [
        { kind: 'group_and', nodeId: 'root', children: ['slot_a'] },
        {
          kind: 'slot',
          nodeId: 'slot_a',
          atomRef: '0',
          attribute: 'color',
          operator: '=',
          value: 'red',
          sourceTier: 'hard',
          sourceKind: 'explicit_utterance',
          confidence: 1,
        },
      ],
    } as unknown as ConstraintGraph;
    const result = await executeGraphAware(
      STUB_INPUT,
      graph,
      deps,
      noOpOpts,
      zeroCoverageProbe,
    );
    // One initial retrieval; rewriter declines on the first decision so
    // no further retrievals occur. Loop is marked exhausted.
    expect(executeCalls).toBe(1);
    expect(result.criticRetriesExhausted).toBe(true);
  });

  it('stops critic retries when request latency budget is exhausted without counting cap exhaustion', async () => {
    const nowMs = Date.now();
    let executeCalls = 0;
    const countingPool: CandidatePoolPort = {
      execute: async () => {
        executeCalls += 1;
        return POOL_OUT;
      },
      generate: async () => POOL_OUT,
    };
    const deps: GraphExecutorDeps = {
      candidatePool: countingPool,
      bundleSelector: new BundleSelectorImpl(),
      queryRewriter: alwaysReformulateRewriter(),
    };
    const graph = {
      ...trivialGraph(),
      nodes: [
        { kind: 'group_and', nodeId: 'root', children: ['slot_a'] },
        {
          kind: 'slot',
          nodeId: 'slot_a',
          atomRef: '0',
          attribute: 'color',
          operator: '=',
          value: 'red',
          sourceTier: 'hard',
          sourceKind: 'explicit_utterance',
          confidence: 1,
        },
      ],
    } as unknown as ConstraintGraph;

    const result = await executeGraphAware(
      {
        ...STUB_INPUT,
        queryPlan: {
          ...STUB_INPUT.queryPlan,
          queryBudget: {
            maxLatencyMs: 100,
            maxCandidates: 20,
            rerankLimit: 10,
          },
        } as never,
        requestContext: {
          requestStartTimeMs: nowMs - 150,
        },
      },
      graph,
      deps,
      noOpOpts,
      zeroCoverageProbe,
    );

    expect(executeCalls).toBe(1);
    expect(result.criticRetriesExhausted).toBeUndefined();
    expect(result.criticDegradationReasons).toContain('critic_retry_budget_exhausted');
    expect(
      globalRetrievalCriticCounter.snapshot().RETRIEVAL_CRITIC_RETRIES_EXHAUSTED_COUNT,
    ).toBe(0);
  });
});

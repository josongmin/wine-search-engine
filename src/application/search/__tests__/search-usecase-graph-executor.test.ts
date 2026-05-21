import { describe, expect, it, vi } from 'vitest';
import { executeGraphAware } from '../search-usecase-graph-executor.js';
import type { HybridRetrievalInput } from '../../../domain/retrieval/model/retrieval-input.js';
import type { ConstraintGraph } from '../../../domain/query/model/constraint-graph.js';
import type { QueryPlanV1 } from '../../../domain/query/model/query-plan.js';
import { buildRetrievalExecutionResult } from '../../../domain/retrieval/model/retrieval-execution-result.js';
import { createEntityId } from '../../../domain/shared/types/index.js';
import type { HybridCandidate } from '../../../domain/retrieval/model/hybrid-candidate.js';

/**
 * Look up the first candidate for a subquery from the mock's candidate map.
 *
 * The bundle-selector mock receives `ReadonlyMap<string, readonly HybridCandidate[]>`
 * — both the lookup and the index can fail. Throwing here surfaces a fixture
 * misconfiguration immediately instead of letting `undefined!` propagate into
 * a downstream assertion as a vague `TypeError` (avoids
 * `no-non-null-asserted-optional-chain` while keeping intent explicit).
 */
function requireFirstCandidate(
  candidatesBySubquery: ReadonlyMap<string, readonly HybridCandidate[]>,
  subqueryId: string,
): HybridCandidate {
  const pool = candidatesBySubquery.get(subqueryId);
  if (pool === undefined || pool.length === 0) {
    throw new Error(`test fixture missing candidates for subquery "${subqueryId}"`);
  }
  const [head] = pool;
  if (head === undefined) {
    throw new Error(`test fixture has empty candidate slot for subquery "${subqueryId}"`);
  }
  return head;
}

function minimalPlan(): QueryPlanV1 {
  return {
    rawQuery: 'bordeaux',
    normalizedQuery: 'bordeaux',
    intent: 'semantic_discovery',
    route: 'hybrid',
    retrievalMode: 'attribute_search',
    queryClass: 'known_item',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {} as QueryPlanV1['policy'],
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: 'test',
    policyRuleVersion: 'test',
    thresholdProfileId: 'test',
  } as QueryPlanV1;
}

function minimalInput(): HybridRetrievalInput {
  const queryPlan = minimalPlan();
  return {
    queryPlan,
    route: 'hybrid',
    lexicalQueries: ['bordeaux'],
    semanticQueries: ['bordeaux'],
    hardConstraints: [],
    softConstraints: [],
  };
}

function minimalBundleGraph(): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1.1',
    origin: 'hybrid',
    rootNodeId: 'root',
    nodes: [
      { kind: 'group_and', nodeId: 'root', children: ['sq_required', 'sq_optional'] },
      { kind: 'subquery', nodeId: 'sq_required', purpose: 'required_pairing', targetCardinality: 1 },
      { kind: 'subquery', nodeId: 'sq_optional', purpose: 'optional_pairing', targetCardinality: 1 },
    ],
    edges: [],
    globalBudgets: {},
  };
}

function bundleGraphWithOptionalSubquery(): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1.1',
    origin: 'hybrid',
    rootNodeId: 'root',
    nodes: [
      { kind: 'group_and', nodeId: 'root', children: ['sq_required', 'sq_optional'] },
      { kind: 'subquery', nodeId: 'sq_required', purpose: 'required_pairing', targetCardinality: 1, obligation: 'required' },
      { kind: 'subquery', nodeId: 'sq_optional', purpose: 'optional_pairing', targetCardinality: 1, obligation: 'optional' },
    ],
    edges: [],
    globalBudgets: {},
  };
}

describe('executeGraphAware', () => {
  it('consumes typed retrieval execution results without candidate-pool getter telemetry', async () => {
    const result = await executeGraphAware(
      minimalInput(),
      undefined,
      {
        candidatePool: {
          execute: vi.fn().mockResolvedValue({
            candidates: [{
              entityId: createEntityId('wine-1'),
              canonicalLabel: 'Wine One',
              matchedConstraints: [],
              retrievalTrace: {
                retrievalProfile: 'default',
                lexicalQueriesUsed: ['bordeaux'],
                semanticQueriesUsed: ['bordeaux'],
                filtersApplied: [],
                candidateSources: ['sparse'],
              },
            }],
            telemetry: {
              degradationCodes: ['sparse_pool'],
              degradationSignals: [{
                component: 'dense_semantic',
                severity: 'warning',
                reason: 'timeout',
                fallbackApplied: 'sparse_only',
              }],
              fusionTrace: {
                queryClass: 'known_item',
                fusionClass: 'known_item',
                rrfK: 60,
                channelWeights: { sparse: 1, dense: 1, anchor: 0, learnedSparse: 0 },
                candidateCount: {
                  beforeFusion: { sparse: 1, dense: 0, anchor: 0 },
                  afterFusion: 1,
                  afterHardFilter: 1,
                  afterAssembly: 1,
                },
              },
              dropLog: [{
                entityId: 'dropped-1',
                dropStage: 'hard_filter',
                dropReason: 'price filter',
                lastKnownScore: 0.17,
                channels: [],
              }],
            },
          }),
        } as never,
        bundleSelector: { chooseAssignment: vi.fn() } as never,
      },
      {} as never,
    );

    expect(result.mode).toBe('passthrough');
    expect(result.candidates).toHaveLength(1);
    expect(result.retrievalTelemetry).toEqual({
      degradationCodes: ['sparse_pool'],
      degradationSignals: [{
        component: 'dense_semantic',
        severity: 'warning',
        reason: 'timeout',
        fallbackApplied: 'sparse_only',
      }],
      fusionTrace: {
        queryClass: 'known_item',
        fusionClass: 'known_item',
        rrfK: 60,
        channelWeights: { sparse: 1, dense: 1, anchor: 0, learnedSparse: 0 },
        candidateCount: {
          beforeFusion: { sparse: 1, dense: 0, anchor: 0 },
          afterFusion: 1,
          afterHardFilter: 1,
          afterAssembly: 1,
        },
      },
      dropLog: [{
        entityId: 'dropped-1',
        dropStage: 'hard_filter',
        dropReason: 'price filter',
        lastKnownScore: 0.17,
        channels: [],
      }],
    });
  });

  it('preserves root telemetry from array-like retrieval execution results', async () => {
    const result = await executeGraphAware(
      minimalInput(),
      undefined,
      {
        candidatePool: {
          execute: vi.fn().mockResolvedValue(
            buildRetrievalExecutionResult({
              candidates: [{
                entityId: createEntityId('wine-2'),
                canonicalLabel: 'Wine Two',
                matchedConstraints: [],
                retrievalTrace: {
                  retrievalProfile: 'default',
                  lexicalQueriesUsed: ['bordeaux'],
                  semanticQueriesUsed: ['bordeaux'],
                  filtersApplied: [],
                  candidateSources: ['dense'],
                },
              }],
              lanes: {
                sparse: { status: 'empty', hits: [], degraded: false },
                dense: { status: 'ok', hits: [], degraded: false },
              },
              degradation: {
                codes: ['sparse_pool'],
                signals: [{
                  component: 'dense_semantic',
                  severity: 'warning',
                  reason: 'timeout',
                  fallbackApplied: 'sparse_only',
                }],
              },
              fusionTrace: {
                queryClass: 'known_item',
                fusionClass: 'known_item',
                rrfK: 60,
                channelWeights: { sparse: 1, dense: 1, anchor: 0, learnedSparse: 0 },
                candidateCount: {
                  beforeFusion: { sparse: 0, dense: 1, anchor: 0 },
                  afterFusion: 1,
                  afterHardFilter: 1,
                  afterAssembly: 1,
                },
              },
              dropLog: [{
                entityId: 'dropped-2',
                dropStage: 'hard_filter',
                dropReason: 'availability filter',
                lastKnownScore: 0.09,
                channels: [],
              }],
              telemetry: {
                queryClass: 'known_item',
                route: 'hybrid',
                runtimeRetrievalMode: 'attribute_search',
                retrievalProfile: 'default',
                vespaRankProfile: 'default',
                activeChannels: ['dense_semantic'],
                filtersApplied: [],
                skippedPhases: [],
              },
            }),
          ),
        } as never,
        bundleSelector: { chooseAssignment: vi.fn() } as never,
      },
      {} as never,
    );

    expect(result.mode).toBe('passthrough');
    expect(result.candidates).toHaveLength(1);
    expect(result.retrievalTelemetry).toEqual({
      degradationCodes: ['sparse_pool'],
      degradationSignals: [{
        component: 'dense_semantic',
        severity: 'warning',
        reason: 'timeout',
        fallbackApplied: 'sparse_only',
      }],
      fusionTrace: {
        queryClass: 'known_item',
        fusionClass: 'known_item',
        rrfK: 60,
        channelWeights: { sparse: 1, dense: 1, anchor: 0, learnedSparse: 0 },
        candidateCount: {
          beforeFusion: { sparse: 0, dense: 1, anchor: 0 },
          afterFusion: 1,
          afterHardFilter: 1,
          afterAssembly: 1,
        },
      },
      dropLog: [{
        entityId: 'dropped-2',
        dropStage: 'hard_filter',
        dropReason: 'availability filter',
        lastKnownScore: 0.09,
        channels: [],
      }],
    });
  });

  it('returns fail_closed instead of throwing when a required subquery retriever rejects, surfacing the reason', async () => {
    const chooseAssignment = vi.fn();
    const requiredFailure = new Error('required subquery infra failed');

    const result = await executeGraphAware(
      minimalInput(),
      minimalBundleGraph(),
      {
        candidatePool: {
          execute: vi.fn(),
        } as never,
        bundleSelector: {
          chooseAssignment,
        } as never,
        subqueryRetriever: {
          stateIsolation: 'isolated',
          retrieve: vi.fn(async (_input, subquery) => {
            if (subquery.nodeId === 'sq_required') {
              throw requiredFailure;
            }
            return buildRetrievalExecutionResult({
              candidates: [{
                entityId: createEntityId('wine-optional'),
                canonicalLabel: 'Optional Wine',
                matchedConstraints: [],
                retrievalTrace: {
                  retrievalProfile: 'default',
                  lexicalQueriesUsed: ['bordeaux'],
                  semanticQueriesUsed: ['bordeaux'],
                  filtersApplied: [],
                  candidateSources: ['dense'],
                },
              }],
              lanes: {
                dense: { status: 'ok', hits: [], degraded: false },
              },
              degradation: {
                codes: [],
                signals: [],
              },
              telemetry: {
                queryClass: 'known_item',
                route: 'hybrid',
                runtimeRetrievalMode: 'attribute_search',
                retrievalProfile: 'default',
                vespaRankProfile: 'default',
                activeChannels: ['dense_semantic'],
                filtersApplied: [],
                skippedPhases: [],
              },
            });
          }),
        },
      },
      {} as never,
    );

    expect(chooseAssignment).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mode: 'fail_closed',
      candidates: [],
      executionDegradationReasons: [
        'retrieval_branch_fail_closed:graph_subquery:sq_required',
      ],
    });
  });

  it('keeps surviving required subqueries when an optional subquery retriever rejects', async () => {
    const chooseAssignment = vi.fn((
      _graph: ConstraintGraph,
      candidatesBySubquery: ReadonlyMap<string, readonly HybridCandidate[]>,
    ) => ({
      assignments: [{
        subqueryId: 'sq_required',
        candidate: requireFirstCandidate(candidatesBySubquery, 'sq_required'),
      }],
      bundleScore: 1,
      budgetUsage: [],
      degradationReasons: [],
      tieBreakReason: 'unique' as const,
    }));

    const result = await executeGraphAware(
      minimalInput(),
      bundleGraphWithOptionalSubquery(),
      {
        candidatePool: {
          execute: vi.fn(),
        } as never,
        bundleSelector: {
          chooseAssignment,
        } as never,
        subqueryRetriever: {
          stateIsolation: 'isolated',
          retrieve: vi.fn(async (_input, subquery) => {
            if (subquery.nodeId === 'sq_optional') {
              throw new Error('optional infra failed');
            }
            return {
              candidates: [{
                entityId: createEntityId('wine-required'),
                canonicalLabel: 'Required Wine',
                matchedConstraints: [],
                retrievalTrace: {
                  retrievalProfile: 'default',
                  lexicalQueriesUsed: ['bordeaux'],
                  semanticQueriesUsed: ['bordeaux'],
                  filtersApplied: [],
                  candidateSources: ['dense'],
                },
              }],
              telemetry: {
                degradationCodes: [],
                degradationSignals: [],
              },
            };
          }),
        },
      },
      {} as never,
    );

    expect(result.mode).toBe('bundle');
    expect(result.candidates.map((candidate) => String(candidate.entityId))).toEqual(['wine-required']);
    expect(result.executionDegradationReasons).toEqual([
      'retrieval_branch_degraded:graph_subquery:sq_optional',
    ]);
    expect(chooseAssignment).toHaveBeenCalledTimes(1);
  });

  it('prunes optional subqueries with empty candidate pools before bundle selection', async () => {
    const chooseAssignment = vi.fn((
      _graph: ConstraintGraph,
      candidatesBySubquery: ReadonlyMap<string, readonly HybridCandidate[]>,
    ) => ({
      assignments: [{
        subqueryId: 'sq_required',
        candidate: requireFirstCandidate(candidatesBySubquery, 'sq_required'),
      }],
      bundleScore: 1,
      budgetUsage: [],
      degradationReasons: [],
      tieBreakReason: 'unique' as const,
    }));

    const result = await executeGraphAware(
      minimalInput(),
      bundleGraphWithOptionalSubquery(),
      {
        candidatePool: {
          execute: vi.fn(),
        } as never,
        bundleSelector: {
          chooseAssignment,
        } as never,
        subqueryRetriever: {
          stateIsolation: 'isolated',
          retrieve: vi.fn(async (_input, subquery) => {
            if (subquery.nodeId === 'sq_optional') {
              return {
                candidates: [],
                telemetry: {
                  degradationCodes: [],
                  degradationSignals: [],
                },
              };
            }
            return {
              candidates: [{
                entityId: createEntityId('wine-required'),
                canonicalLabel: 'Required Wine',
                matchedConstraints: [],
                retrievalTrace: {
                  retrievalProfile: 'default',
                  lexicalQueriesUsed: ['bordeaux'],
                  semanticQueriesUsed: ['bordeaux'],
                  filtersApplied: [],
                  candidateSources: ['dense'],
                },
              }],
              telemetry: {
                degradationCodes: [],
                degradationSignals: [],
              },
            };
          }),
        },
      },
      {} as never,
    );

    expect(result.mode).toBe('bundle');
    expect(result.candidates.map((candidate) => String(candidate.entityId))).toEqual(['wine-required']);
    expect(result.executionDegradationReasons).toEqual([
      'retrieval_branch_degraded:graph_subquery:sq_optional',
    ]);
    expect(chooseAssignment).toHaveBeenCalledTimes(1);
  });
});

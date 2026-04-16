import { describe, expect, it, vi } from 'vitest';
import {
  buildHybridRetrievalInputForPlan,
  retrieveHybridCandidatesForPlan,
} from '../../../../src/application/search/search-usecase-hybrid-candidates.js';
import type { CompiledWineQuery } from '../../../../src/domain/query/model/compiled-wine-query.js';
import type { ConstraintGraph } from '../../../../src/domain/query/model/constraint-graph.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { HybridCandidate } from '../../../../src/domain/retrieval/model/hybrid-candidate.js';
import type { EntityResolveResult } from '../../../../src/domain/resolver/model/resolve-result.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

function minimalPlan(overrides: Partial<QueryPlanV1> = {}): QueryPlanV1 {
  return {
    rawQuery: 'bordeaux producer',
    normalizedQuery: 'bordeaux producer',
    intent: 'semantic_discovery',
    route: 'hybrid',
    retrievalMode: 'attribute_search',
    queryClass: 'known_item',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {} as QueryPlanV1['policy'],
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default-v1',
    ...overrides,
  } as QueryPlanV1;
}

function buildCompiled(
  plan: QueryPlanV1,
  overrides: Partial<CompiledWineQuery['execution']> = {},
): CompiledWineQuery {
  return {
    query: {
      rawQuery: plan.rawQuery,
      normalizedQuery: plan.normalizedQuery,
      intent: plan.intent,
      queryClass: plan.queryClass,
      anchors: plan.anchors,
      constraints: plan.constraints,
      expansions: plan.expansions,
      uncertainty: plan.uncertainty,
      plannerVersion: plan.plannerVersion,
      policyRuleVersion: plan.policyRuleVersion,
      thresholdProfileId: plan.thresholdProfileId,
      retrievalPlan: {
        hardFilterTokens: [],
        softBoosts: [],
        inferredBoosts: [],
        sensoryPriors: [],
        planVersion: 'retrieval-plan-v1.0',
      },
    },
    execution: {
      effectiveRoute: 'hybrid',
      effectiveRetrievalMode: 'attribute_search',
      routeSource: 'planner',
      budget: {
        maxCandidates: 25,
        enablePrecisionRerank: true,
      },
      provenancePolicy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: false,
        requireAnchorEvidence: false,
      },
      ...overrides,
    },
  };
}

function makeCandidate(overrides: Partial<HybridCandidate> = {}): HybridCandidate {
  return {
    entityId: createEntityId('wine-1'),
    canonicalLabel: 'Wine One',
    matchedConstraints: [],
    retrievalTrace: {
      retrievalProfile: 'default',
      lexicalQueriesUsed: ['wine'],
      semanticQueriesUsed: ['wine'],
      filtersApplied: [],
      candidateSources: ['sparse'],
    },
    ...overrides,
  };
}

function failedResolveResult(): EntityResolveResult {
  return {
    status: 'failed',
    candidates: [],
    decisionTrace: {
      queryClass: 'known_item',
      top1CalibratedScore: 0,
      top2CalibratedScore: 0,
      calibratedGap: 0,
      decisionConfidenceC: 0,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
      outcomeReasonCodes: [],
    },
    conformalSetSize: 0,
  };
}

function scopedHybridGraph(): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1.1',
    origin: 'hybrid',
    rootNodeId: 'root',
    nodes: [
      { kind: 'group_and', nodeId: 'root', children: ['slot_region', 'scope_red', 'scope_white'] },
      { kind: 'group_and', nodeId: 'scope_red', children: ['sq_red', 'slot_red'] },
      { kind: 'group_and', nodeId: 'scope_white', children: ['sq_white', 'slot_white'] },
      { kind: 'subquery', nodeId: 'sq_red', purpose: 'red_course', targetCardinality: 1 },
      { kind: 'subquery', nodeId: 'sq_white', purpose: 'white_course', targetCardinality: 1 },
      {
        kind: 'slot',
        nodeId: 'slot_region',
        atomRef: '2',
        attribute: 'region',
        operator: '=',
        value: 'Bordeaux',
        sourceTier: 'hard',
        sourceKind: 'explicit_utterance',
        confidence: 1,
      },
      {
        kind: 'slot',
        nodeId: 'slot_red',
        atomRef: '0',
        attribute: 'wine_type',
        operator: '=',
        value: 'red',
        sourceTier: 'hard',
        sourceKind: 'explicit_utterance',
        confidence: 1,
      },
      {
        kind: 'slot',
        nodeId: 'slot_white',
        atomRef: '1',
        attribute: 'wine_type',
        operator: '=',
        value: 'white',
        sourceTier: 'hard',
        sourceKind: 'explicit_utterance',
        confidence: 1,
      },
    ],
    edges: [],
    globalBudgets: {},
    promptVersion: 'ctg_topology_v1',
  };
}

function xorScopedHybridGraph(): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1.1',
    origin: 'hybrid',
    rootNodeId: 'root',
    nodes: [
      { kind: 'group_and', nodeId: 'root', children: ['slot_region', 'scope_pair', 'scope_white'] },
      { kind: 'group_and', nodeId: 'scope_pair', children: ['sq_pair', 'type_choice'] },
      { kind: 'group_xor', nodeId: 'type_choice', children: ['slot_red', 'slot_rose'] },
      { kind: 'group_and', nodeId: 'scope_white', children: ['sq_white', 'slot_white'] },
      { kind: 'subquery', nodeId: 'sq_pair', purpose: 'pair_course', targetCardinality: 1 },
      { kind: 'subquery', nodeId: 'sq_white', purpose: 'white_course', targetCardinality: 1 },
      {
        kind: 'slot',
        nodeId: 'slot_region',
        atomRef: '0',
        attribute: 'region',
        operator: '=',
        value: 'Bordeaux',
        sourceTier: 'hard',
        sourceKind: 'explicit_utterance',
        confidence: 1,
      },
      {
        kind: 'slot',
        nodeId: 'slot_red',
        atomRef: '1',
        attribute: 'wine_type',
        operator: '=',
        value: 'red',
        sourceTier: 'hard',
        sourceKind: 'explicit_utterance',
        confidence: 1,
      },
      {
        kind: 'slot',
        nodeId: 'slot_rose',
        atomRef: '2',
        attribute: 'wine_type',
        operator: '=',
        value: 'rose',
        sourceTier: 'hard',
        sourceKind: 'explicit_utterance',
        confidence: 1,
      },
      {
        kind: 'slot',
        nodeId: 'slot_white',
        atomRef: '3',
        attribute: 'wine_type',
        operator: '=',
        value: 'white',
        sourceTier: 'hard',
        sourceKind: 'explicit_utterance',
        confidence: 1,
      },
    ],
    edges: [],
    globalBudgets: {},
  };
}

function pureDisjunctiveHybridGraph(): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1.1',
    origin: 'hybrid',
    rootNodeId: 'root',
    nodes: [
      { kind: 'group_and', nodeId: 'root', children: ['scope_pair', 'scope_white'] },
      { kind: 'group_and', nodeId: 'scope_pair', children: ['sq_pair', 'type_choice'] },
      { kind: 'group_xor', nodeId: 'type_choice', children: ['slot_red', 'slot_rose'] },
      { kind: 'group_and', nodeId: 'scope_white', children: ['sq_white', 'slot_white'] },
      { kind: 'subquery', nodeId: 'sq_pair', purpose: 'pair_course', targetCardinality: 1 },
      { kind: 'subquery', nodeId: 'sq_white', purpose: 'white_course', targetCardinality: 1 },
      {
        kind: 'slot',
        nodeId: 'slot_red',
        atomRef: '1',
        attribute: 'wine_type',
        operator: '=',
        value: 'red',
        sourceTier: 'hard',
        sourceKind: 'explicit_utterance',
        confidence: 1,
      },
      {
        kind: 'slot',
        nodeId: 'slot_rose',
        atomRef: '2',
        attribute: 'wine_type',
        operator: '=',
        value: 'rose',
        sourceTier: 'hard',
        sourceKind: 'explicit_utterance',
        confidence: 1,
      },
      {
        kind: 'slot',
        nodeId: 'slot_white',
        atomRef: '3',
        attribute: 'wine_type',
        operator: '=',
        value: 'white',
        sourceTier: 'hard',
        sourceKind: 'explicit_utterance',
        confidence: 1,
      },
    ],
    edges: [],
    globalBudgets: {},
  };
}

function sharedBudgetHybridGraph(): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1.1',
    origin: 'hybrid',
    rootNodeId: 'root',
    nodes: [
      { kind: 'group_and', nodeId: 'root', children: ['sq_app', 'sq_main'] },
      { kind: 'subquery', nodeId: 'sq_app', purpose: 'appetiser', targetCardinality: 1 },
      { kind: 'subquery', nodeId: 'sq_main', purpose: 'main', targetCardinality: 1 },
    ],
    edges: [
      {
        kind: 'shares_budget',
        from: 'sq_app',
        to: 'sq_main',
        resource: 'price_total',
      },
    ],
    globalBudgets: {
      priceTotal: { currency: 'KRW', max: 160_000 },
    },
  };
}

describe('retrieveHybridCandidatesForPlan', () => {
  it('propagates style and flavor soft constraints into semantic query expansions', () => {
    const plan = minimalPlan({
      constraints: {
        hard: [],
        soft: [
          {
            attribute: 'style',
            operator: 'in',
            value: ['chillable'],
            source_phrase: '시원하게',
            confidence: 0.85,
          },
          {
            attribute: 'flavor_profile',
            operator: 'in',
            value: ['fruity'],
            source_phrase: '과일향 풍부한',
            confidence: 0.82,
          },
        ],
        inferred: [],
      },
    });

    const input = buildHybridRetrievalInputForPlan(plan);
    expect(input.semanticQueries).toEqual(
      expect.arrayContaining(['chillable', 'fruity']),
    );
  });

  it('expands approachable/crowd-pleasing style semantics into retrieval archetype terms', () => {
    const plan = minimalPlan({
      constraints: {
        hard: [],
        soft: [
          {
            attribute: 'style',
            operator: 'in',
            value: ['approachable'],
            source_phrase: '입문자',
            confidence: 0.85,
          },
          {
            attribute: 'style',
            operator: 'in',
            value: ['crowd_pleasing'],
            source_phrase: '실패 없는',
            confidence: 0.82,
          },
        ],
        inferred: [],
      },
    });

    const input = buildHybridRetrievalInputForPlan(plan);
    expect(input.semanticQueries).toEqual(
      expect.arrayContaining(['approachable', 'crowd pleasing', 'easy drinking', 'merlot', 'red blend']),
    );
  });

  it('keeps typed diversity style expansion branch-local for white and sparkling probes', () => {
    const plan = minimalPlan({
      constraints: {
        hard: [{
          attribute: 'wine_type',
          operator: '=',
          value: 'white',
          source_phrase: 'white',
          confidence: 1,
        }],
        soft: [
          {
            attribute: 'style',
            operator: 'in',
            value: ['approachable'],
            source_phrase: '입문자',
            confidence: 0.85,
          },
          {
            attribute: 'style',
            operator: 'in',
            value: ['crowd_pleasing'],
            source_phrase: '실패 없는',
            confidence: 0.82,
          },
        ],
        inferred: [],
      },
    });

    const input = buildHybridRetrievalInputForPlan(plan);
    expect(input.semanticQueries).toEqual(
      expect.arrayContaining([
        'approachable',
        'crowd pleasing',
        'easy drinking',
        'pinot grigio',
        'riesling',
        'sauvignon blanc',
        'chardonnay',
      ]),
    );
    expect(input.semanticQueries).not.toEqual(
      expect.arrayContaining(['merlot', 'red blend']),
    );
  });

  it('treats presentation-forward style as a retrieval no-op because there is no backing data profile', () => {
    const plan = minimalPlan({
      constraints: {
        hard: [],
        soft: [
          {
            attribute: 'style',
            operator: 'in',
            value: ['presentation_forward'],
            source_phrase: '예쁜 라벨',
            confidence: 0.8,
          },
        ],
        inferred: [],
      },
    });

    const input = buildHybridRetrievalInputForPlan(plan);
    expect(input.semanticQueries).not.toEqual(
      expect.arrayContaining(['presentation_forward']),
    );
  });

  it('projects retrieval provenance coverage and shortfall on the generic candidate-pool path', async () => {
    const plan = minimalPlan({
      constraints: {
        hard: [{
          attribute: 'region',
          operator: '=',
          value: 'Bordeaux',
          source_phrase: 'Bordeaux',
          confidence: 0.95,
        }],
        soft: [],
        inferred: [],
      },
    });
    const compiled = buildCompiled(plan, {
      effectiveRetrievalMode: 'attribute_search',
      provenancePolicy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: true,
        requireAnchorEvidence: false,
      },
    });
    const candidatePool = {
      execute: vi.fn().mockResolvedValue([
        makeCandidate({
          matchedConstraints: [],
        }),
      ]),
    };

    const result = await retrieveHybridCandidatesForPlan(
      plan,
      {
        candidatePool: candidatePool as never,
      },
      async () => failedResolveResult(),
      compiled,
    );

    expect(result.effectiveRetrievalMode).toBe('attribute_search');
    expect(result.retrievalKind).toBe('generic_hybrid');
    expect(result.sparseExecuted).toBe(true);
    expect(result.usedCompiledExecution).toBe(true);
    expect(result.retrievalProvenanceCoverage).toEqual({
      candidateCount: 1,
      identityEvidenceSatisfied: true,
      constraintEvidenceSatisfied: false,
      anchorEvidenceSatisfied: true,
      matchedConstraintAttributes: [],
      unmetConstraintAttributes: ['region'],
      anchorSignalTypes: [],
    });
    expect(result.routeDegradation?.degradationReasons).toContain(
      'retrieval_provenance_shortfall:constraint_evidence',
    );
  });

  it('marks specialized browse retrieval as non-sparse while preserving provenance coverage', async () => {
    const plan = minimalPlan({
      retrievalMode: 'producer_browse',
      anchors: [{
        surfaceForm: 'Opus One',
        normalizedForm: 'opus one',
        candidateEntityIds: [createEntityId('wine-anchor')],
        confidence: 0.99,
      }],
    });
    const compiled = buildCompiled(plan, {
      effectiveRetrievalMode: 'producer_browse',
      provenancePolicy: {
        requireIdentitySeal: true,
        requireConstraintEvidence: false,
        requireAnchorEvidence: false,
      },
    });
    const browseRetriever = {
      browseProducer: vi.fn().mockResolvedValue([
        makeCandidate({
          retrievalProvenance: {
            channels: ['sparse'],
            protectedInclusionReason: 'exact_alias_match',
          },
        }),
      ]),
    };

    const result = await retrieveHybridCandidatesForPlan(
      plan,
      {
        candidatePool: { generate: vi.fn() } as never,
        browseRetriever: browseRetriever as never,
      },
      async () => failedResolveResult(),
      compiled,
    );

    expect(browseRetriever.browseProducer).toHaveBeenCalledWith(
      'Opus One',
      plan.constraints,
      20,
      // ADR-014 Phase 1b.3b: compiled.constraintGraph threaded through.
      undefined,
    );
    expect(result.effectiveRetrievalMode).toBe('producer_browse');
    expect(result.retrievalKind).toBe('specialized_hybrid');
    expect(result.sparseExecuted).toBe(false);
    expect(result.usedCompiledExecution).toBe(true);
    expect(result.specializedRouteObservability).toEqual({
      specializedRouteRequested: 'producer_browse',
      specializedRouteExecuted: 'producer_browse',
      fallbackApplied: false,
    });
    expect(result.retrievalProvenanceCoverage).toEqual({
      candidateCount: 1,
      identityEvidenceSatisfied: true,
      constraintEvidenceSatisfied: true,
      anchorEvidenceSatisfied: true,
      matchedConstraintAttributes: [],
      unmetConstraintAttributes: [],
      anchorSignalTypes: [],
    });
    expect(result.routeDegradation).toBeUndefined();
  });

  it('fans generic hybrid retrieval out through a production subquery retriever when the graph carries explicit subquery-scoped slots', async () => {
    const previousCriticFlag = process.env['RETRIEVAL_EXECUTOR_CRITIC'];
    process.env['RETRIEVAL_EXECUTOR_CRITIC'] = 'false';
    try {
      const plan = minimalPlan({
        constraints: {
          hard: [
            {
              attribute: 'region',
              operator: '=',
              value: 'Bordeaux',
              source_phrase: 'bordeaux',
              confidence: 1,
            },
            {
              attribute: 'wine_type',
              operator: '=',
              value: 'red',
              source_phrase: 'red',
              confidence: 1,
            },
            {
              attribute: 'wine_type',
              operator: '=',
              value: 'white',
              source_phrase: 'white',
              confidence: 1,
            },
          ],
          soft: [],
          inferred: [],
        },
      });
      const compiled = {
        ...buildCompiled(plan, {
          effectiveRetrievalMode: 'attribute_search',
        }),
        constraintGraph: scopedHybridGraph(),
      } satisfies CompiledWineQuery;

      const seenHardValues: string[][] = [];
      const candidatePool = {
        execute: vi.fn(async (input) => {
          const values = input.hardConstraints
            .map((constraint) => `${constraint.attribute}:${String(constraint.value)}`)
            .sort();
          seenHardValues.push(values);
          const suffix = values.find((value) => value.startsWith('wine_type:'))?.replace('wine_type:', '') ?? 'root';
          return [
            makeCandidate({
              entityId: createEntityId(`wine-${suffix}`),
              matchedConstraints: values.length > 0 ? ['wine_type', 'region'] : [],
              matchedAtomRefs:
                suffix === 'red'
                  ? ['slot_red', 'slot_region']
                  : suffix === 'white'
                  ? ['slot_white', 'slot_region']
                  : [],
            }),
          ];
        }),
        getLastDegradationCodes: vi.fn(() => []),
      };

      const result = await retrieveHybridCandidatesForPlan(
        plan,
        {
          candidatePool: candidatePool as never,
        },
        async () => failedResolveResult(),
        compiled,
      );

      expect(candidatePool.execute).toHaveBeenCalledTimes(2);
      expect(seenHardValues).toEqual([
        ['region:Bordeaux', 'wine_type:red'],
        ['region:Bordeaux', 'wine_type:white'],
      ]);
      expect(result.retrievalKind).toBe('generic_hybrid');
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.map((candidate) => String(candidate.entityId)).sort()).toEqual([
        'wine-red',
        'wine-white',
      ]);
    } finally {
      if (previousCriticFlag === undefined) {
        delete process.env['RETRIEVAL_EXECUTOR_CRITIC'];
      } else {
        process.env['RETRIEVAL_EXECUTOR_CRITIC'] = previousCriticFlag;
      }
    }
  });

  it('preserves scoped XOR topology while only materialising conjunctively-required hard filters', async () => {
    const previousCriticFlag = process.env['RETRIEVAL_EXECUTOR_CRITIC'];
    process.env['RETRIEVAL_EXECUTOR_CRITIC'] = 'false';
    try {
      const plan = minimalPlan();
      const compiled = {
        ...buildCompiled(plan),
        constraintGraph: xorScopedHybridGraph(),
      } satisfies CompiledWineQuery;

      const seenInputs: Array<{
        hardValues: string[];
        graph: ConstraintGraph | undefined;
      }> = [];
      const candidatePool = {
        execute: vi.fn(async (input) => {
          seenInputs.push({
            hardValues: input.hardConstraints
              .map((constraint) => `${constraint.attribute}:${String(constraint.value)}`)
              .sort(),
            graph: input.constraintGraph,
          });
          return [
            makeCandidate({
              entityId: createEntityId(`wine-${seenInputs.length}`),
              matchedConstraints: ['region'],
              matchedAtomRefs: ['slot_region'],
            }),
          ];
        }),
        getLastDegradationCodes: vi.fn(() => []),
      };

      await retrieveHybridCandidatesForPlan(
        plan,
        { candidatePool: candidatePool as never },
        async () => failedResolveResult(),
        compiled,
      );

      expect(candidatePool.execute).toHaveBeenCalledTimes(2);
      expect(seenInputs[0]?.hardValues).toEqual(['region:Bordeaux']);
      expect(seenInputs[1]?.hardValues).toEqual(['region:Bordeaux', 'wine_type:white']);

      const firstGraph = seenInputs[0]?.graph;
      expect(firstGraph?.rootNodeId).toBe('root');
      const xorNode = firstGraph?.nodes.find((node) => node.nodeId === 'type_choice');
      expect(xorNode).toEqual({
        kind: 'group_xor',
        nodeId: 'type_choice',
        children: ['slot_red', 'slot_rose'],
      });
      expect(firstGraph?.nodes.some((node) => node.nodeId === 'slot_white')).toBe(false);
    } finally {
      if (previousCriticFlag === undefined) {
        delete process.env['RETRIEVAL_EXECUTOR_CRITIC'];
      } else {
        process.env['RETRIEVAL_EXECUTOR_CRITIC'] = previousCriticFlag;
      }
    }
  });

  it('keeps pure disjunctive subqueries on the scoped graph path instead of falling back to base retrieval', async () => {
    const previousCriticFlag = process.env['RETRIEVAL_EXECUTOR_CRITIC'];
    process.env['RETRIEVAL_EXECUTOR_CRITIC'] = 'false';
    try {
      const plan = minimalPlan({
        constraints: {
          hard: [
            {
              attribute: 'wine_type',
              operator: '=',
              value: 'red',
              source_phrase: 'red',
              confidence: 1,
            },
            {
              attribute: 'wine_type',
              operator: '=',
              value: 'rose',
              source_phrase: 'rose',
              confidence: 1,
            },
            {
              attribute: 'wine_type',
              operator: '=',
              value: 'white',
              source_phrase: 'white',
              confidence: 1,
            },
          ],
          soft: [],
          inferred: [],
        },
      });
      const compiled = {
        ...buildCompiled(plan),
        constraintGraph: pureDisjunctiveHybridGraph(),
      } satisfies CompiledWineQuery;

      const seenInputs: Array<{
        hardValues: string[];
        graph: ConstraintGraph | undefined;
        lexicalQueries: readonly string[];
      }> = [];
      const candidatePool = {
        execute: vi.fn(async (input) => {
          seenInputs.push({
            hardValues: input.hardConstraints
              .map((constraint) => `${constraint.attribute}:${String(constraint.value)}`)
              .sort(),
            graph: input.constraintGraph,
            lexicalQueries: input.lexicalQueries,
          });
          return [makeCandidate({ entityId: createEntityId(`wine-${seenInputs.length}`) })];
        }),
        getLastDegradationCodes: vi.fn(() => []),
      };

      await retrieveHybridCandidatesForPlan(
        plan,
        { candidatePool: candidatePool as never },
        async () => failedResolveResult(),
        compiled,
      );

      expect(candidatePool.execute).toHaveBeenCalledTimes(2);
      expect(seenInputs[0]?.hardValues).toEqual([]);
      expect(seenInputs[0]?.graph?.nodes.some((node) => node.nodeId === 'type_choice')).toBe(true);
      expect(seenInputs[0]?.graph?.nodes.some((node) => node.nodeId === 'slot_white')).toBe(false);
      expect(seenInputs[0]?.lexicalQueries).toContain('red');
      expect(seenInputs[0]?.lexicalQueries).toContain('rose');
      expect(seenInputs[1]?.hardValues).toEqual(['wine_type:white']);
    } finally {
      if (previousCriticFlag === undefined) {
        delete process.env['RETRIEVAL_EXECUTOR_CRITIC'];
      } else {
        process.env['RETRIEVAL_EXECUTOR_CRITIC'] = previousCriticFlag;
      }
    }
  });

  it('uses the default bundle pricer to choose the cheapest feasible shared-budget bundle', async () => {
    const previousBundleFlag = process.env['BUNDLE_SELECTOR_ENABLED'];
    const previousCriticFlag = process.env['RETRIEVAL_EXECUTOR_CRITIC'];
    process.env['BUNDLE_SELECTOR_ENABLED'] = 'true';
    process.env['RETRIEVAL_EXECUTOR_CRITIC'] = 'false';
    try {
      const plan = minimalPlan();
      const compiled = {
        ...buildCompiled(plan),
        constraintGraph: sharedBudgetHybridGraph(),
      } satisfies CompiledWineQuery;

      let callCount = 0;
      const candidatePool = {
        execute: vi.fn(async () => {
          callCount += 1;
          if (callCount === 1) {
            return [
              makeCandidate({
                entityId: createEntityId('app-expensive'),
                priceUsd: 100,
                fusionRrfTotal: 0.95,
              }),
              makeCandidate({
                entityId: createEntityId('app-cheap'),
                priceUsd: 50,
                fusionRrfTotal: 0.6,
              }),
            ];
          }
          return [
            makeCandidate({
              entityId: createEntityId('main-expensive'),
              priceUsd: 100,
              fusionRrfTotal: 0.96,
            }),
            makeCandidate({
              entityId: createEntityId('main-cheap'),
              priceUsd: 50,
              fusionRrfTotal: 0.59,
            }),
          ];
        }),
        getLastDegradationCodes: vi.fn(() => []),
      };

      const result = await retrieveHybridCandidatesForPlan(
        plan,
        { candidatePool: candidatePool as never },
        async () => failedResolveResult(),
        compiled,
      );

      expect(result.retrievalKind).toBe('generic_hybrid');
      expect(result.candidates.map((candidate) => String(candidate.entityId)).sort()).toEqual([
        'app-cheap',
        'main-cheap',
      ]);
      expect(result.routeDegradation?.degradationReasons ?? []).not.toContain(
        'bundle_selector_fail_closed:budget_infeasible',
      );
    } finally {
      if (previousBundleFlag === undefined) {
        delete process.env['BUNDLE_SELECTOR_ENABLED'];
      } else {
        process.env['BUNDLE_SELECTOR_ENABLED'] = previousBundleFlag;
      }
      if (previousCriticFlag === undefined) {
        delete process.env['RETRIEVAL_EXECUTOR_CRITIC'];
      } else {
        process.env['RETRIEVAL_EXECUTOR_CRITIC'] = previousCriticFlag;
      }
    }
  });
});

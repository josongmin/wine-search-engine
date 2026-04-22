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

  it('adds semantic-safe noisy entity views to semanticEmbeddingQueries while keeping semanticQueries narrow', () => {
    const plan = minimalPlan({
      rawQuery: '샤또마고1996',
      normalizedQuery: '샤토 마고 1996',
      normalizedQueryViews: {
        raw: '샤또마고1996',
        strict: '샤토 마고 1996',
        accentless: '샤토 마고 1996',
        collapsedWhitespace: '샤토 마고 1996',
        punctuationStripped: '샤토 마고 1996',
        compact: '샤토마고1996',
        vintageCanonicalized: '샤토 마고 1996',
        vintageStripped: '샤토 마고',
        transliterated: 'chateau margaux',
        reordered: ['마고 샤토'],
        semanticVariants: [
          '샤또마고1996',
          '샤토 마고 1996',
          '샤토 마고',
          'chateau margaux',
          '마고 샤토',
        ],
        lookupVariants: [
          '샤토 마고 1996',
          '샤토마고1996',
          'chateau margaux',
          'chtmrg1996',
          '마고 샤토',
        ],
      },
    });

    const input = buildHybridRetrievalInputForPlan(plan);

    expect(input.semanticEmbeddingQueries).toEqual(
      expect.arrayContaining([
        '샤또마고1996',
        '샤토 마고 1996',
        '샤토 마고',
        'chateau margaux',
        '마고 샤토',
      ]),
    );
    expect(input.semanticEmbeddingQueries).not.toEqual(
      expect.arrayContaining([
        '샤토마고1996',
        'chtmrg1996',
      ]),
    );
    expect(input.semanticQueries).toEqual(
      expect.arrayContaining([
        '샤또마고1996',
        'chateau margaux',
      ]),
    );
    expect(input.semanticQueries).not.toEqual(
      expect.arrayContaining([
        '샤토 마고',
        '마고 샤토',
      ]),
    );
  });

  it('derives semanticEmbeddingQueries from embedding-friendly normalized views when semanticVariants are absent', () => {
    const plan = minimalPlan({
      rawQuery: '샤또마고1996',
      normalizedQuery: '샤토 마고 1996',
      normalizedQueryViews: {
        raw: '샤또마고1996',
        strict: '샤토 마고 1996',
        accentless: '샤토 마고 1996',
        collapsedWhitespace: '샤토 마고 1996',
        punctuationStripped: '샤토 마고 1996',
        compact: '샤토마고1996',
        vintageCanonicalized: '샤토 마고 1996',
        vintageStripped: '샤토 마고',
        transliterated: 'chateau margaux',
        reordered: ['마고 샤토'],
        semanticVariants: [],
        lookupVariants: [
          '샤토 마고 1996',
          '샤토마고1996',
          'chateau margaux',
          'chtmrg1996',
          '마고 샤토',
        ],
      },
    });

    const input = buildHybridRetrievalInputForPlan(plan);

    expect(input.semanticEmbeddingQueries).toEqual(
      expect.arrayContaining([
        '샤또마고1996',
        '샤토 마고 1996',
        '샤토 마고',
        'chateau margaux',
        '마고 샤토',
      ]),
    );
    expect(input.semanticEmbeddingQueries).not.toEqual(
      expect.arrayContaining([
        '샤토마고1996',
        'chtmrg1996',
      ]),
    );
    expect(input.semanticQueries).toEqual(
      expect.arrayContaining([
        '샤또마고1996',
        'chateau margaux',
      ]),
    );
    expect(input.semanticQueries).not.toEqual(
      expect.arrayContaining([
        '샤토 마고',
        '마고 샤토',
      ]),
    );
  });

  it('forwards semantic noisy-query views into candidatePool semanticEmbeddingQueries', async () => {
    const plan = minimalPlan({
      rawQuery: '샤또마고1996',
      normalizedQuery: '샤토 마고 1996',
      normalizedQueryViews: {
        raw: '샤또마고1996',
        strict: '샤토 마고 1996',
        accentless: '샤토 마고 1996',
        collapsedWhitespace: '샤토 마고 1996',
        punctuationStripped: '샤토 마고 1996',
        compact: '샤토마고1996',
        vintageCanonicalized: '샤토 마고 1996',
        vintageStripped: '샤토 마고',
        transliterated: 'chateau margaux',
        reordered: ['마고 샤토'],
        semanticVariants: [],
        lookupVariants: [
          '샤토 마고 1996',
          '샤토마고1996',
          'chateau margaux',
          'chtmrg1996',
          '마고 샤토',
        ],
      },
    });
    const compiled = buildCompiled(plan, {
      effectiveRetrievalMode: 'attribute_search',
    });
    const candidatePool = {
      execute: vi.fn(async () => []),
      getLastDegradationCodes: vi.fn(() => []),
      getLastDegradationSignals: vi.fn(() => []),
    };

    await retrieveHybridCandidatesForPlan(
      plan,
      { candidatePool: candidatePool as never },
      async () => failedResolveResult(),
      compiled,
    );

    expect(candidatePool.execute).toHaveBeenCalledOnce();
    expect(candidatePool.execute.mock.calls[0]?.[0].semanticEmbeddingQueries).toEqual(
      expect.arrayContaining([
        '샤또마고1996',
        '샤토 마고',
        'chateau margaux',
        '마고 샤토',
      ]),
    );
    expect(candidatePool.execute.mock.calls[0]?.[0].semanticEmbeddingQueries).not.toEqual(
      expect.arrayContaining([
        '샤토마고1996',
        'chtmrg1996',
      ]),
    );
    expect(candidatePool.execute.mock.calls[0]?.[0].semanticQueries).toEqual(
      expect.arrayContaining([
        '샤또마고1996',
        'chateau margaux',
      ]),
    );
    expect(candidatePool.execute.mock.calls[0]?.[0].semanticQueries).not.toEqual(
      expect.arrayContaining([
        '샤토 마고',
        '마고 샤토',
      ]),
    );
  });

  it('uses ambiguous short-form family hints for retrieval fanout without promoting direct grape constraints', () => {
    const plan = minimalPlan({
      rawQuery: '피노 추천',
      normalizedQuery: '피노 추천',
      queryClass: 'ambiguous_short_form',
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: {
        lexical: ['피노 추천'],
        semantic: ['피노 추천'],
        ambiguousEntityHints: [{
          surface: '피노',
          entityType: 'grape_primary',
          retrievalConstraint: {
            attribute: 'grape_family',
            operator: '=',
            value: 'Pinot',
          },
          lexicalExpansions: ['pinot'],
          semanticExpansions: ['pinot noir', 'pinot gris', 'pinot blanc'],
          clarifyOptions: ['Pinot Noir', 'Pinot Gris', 'Pinot Blanc'],
          explorationBranches: [
            {
              label: 'Pinot Noir',
              softConstraint: {
                attribute: 'grape_primary',
                operator: '=',
                value: 'Pinot Noir',
              },
              matchValues: ['Pinot Noir'],
              lexicalExpansions: ['pinot noir'],
              semanticExpansions: ['pinot noir'],
            },
            {
              label: 'Pinot Gris',
              softConstraint: {
                attribute: 'grape_primary',
                operator: '=',
                value: 'Pinot Gris',
              },
              matchValues: ['Pinot Gris', 'Pinot Grigio'],
              lexicalExpansions: ['pinot gris', 'pinot grigio'],
              semanticExpansions: ['pinot gris', 'pinot grigio'],
            },
            {
              label: 'Pinot Blanc',
              softConstraint: {
                attribute: 'grape_primary',
                operator: '=',
                value: 'Pinot Blanc',
              },
              matchValues: ['Pinot Blanc'],
              lexicalExpansions: ['pinot blanc'],
              semanticExpansions: ['pinot blanc'],
            },
          ],
        }],
      },
    });

    const input = buildHybridRetrievalInputForPlan(plan);
    expect(input.hardConstraints).toHaveLength(0);
    expect(input.softConstraints).toEqual([
      expect.objectContaining({
        attribute: 'grape_family',
        operator: '=',
        value: 'Pinot',
        source_phrase: 'ambiguous_entity_hint(피노)',
      }),
    ]);
    expect(input.lexicalQueries).toEqual(expect.arrayContaining(['피노 추천', 'pinot']));
    expect(input.semanticQueries).toEqual(
      expect.arrayContaining(['피노 추천', 'pinot noir', 'pinot gris', 'pinot blanc']),
    );
    expect(input.entityHypothesisTerms).toBeUndefined();
  });

  it('keeps Pinot family ambiguity hints branch-separated in retrieval fanout without promoting direct grape_primary constraints', () => {
    const plan = minimalPlan({
      rawQuery: '피노 추천',
      normalizedQuery: '피노 추천',
      queryClass: 'ambiguous_short_form',
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: {
        lexical: ['피노 추천'],
        semantic: ['피노 추천'],
        ambiguousEntityHints: [{
          surface: '피노',
          entityType: 'grape_primary',
          retrievalConstraint: {
            attribute: 'grape_family',
            operator: '=',
            value: 'Pinot',
          },
          lexicalExpansions: ['pinot'],
          semanticExpansions: ['pinot noir', 'pinot gris', 'pinot blanc'],
          clarifyOptions: ['Pinot Noir', 'Pinot Gris', 'Pinot Blanc'],
          explorationBranches: [
            {
              label: 'Pinot Noir',
              softConstraint: {
                attribute: 'grape_primary',
                operator: '=',
                value: 'Pinot Noir',
              },
              matchValues: ['Pinot Noir'],
              lexicalExpansions: ['pinot noir'],
              semanticExpansions: ['pinot noir'],
            },
            {
              label: 'Pinot Gris',
              softConstraint: {
                attribute: 'grape_primary',
                operator: '=',
                value: 'Pinot Gris',
              },
              matchValues: ['Pinot Gris', 'Pinot Grigio'],
              lexicalExpansions: ['pinot gris', 'pinot grigio'],
              semanticExpansions: ['pinot gris', 'pinot grigio'],
            },
            {
              label: 'Pinot Blanc',
              softConstraint: {
                attribute: 'grape_primary',
                operator: '=',
                value: 'Pinot Blanc',
              },
              matchValues: ['Pinot Blanc'],
              lexicalExpansions: ['pinot blanc'],
              semanticExpansions: ['pinot blanc'],
            },
          ],
        }],
      },
    });

    const input = buildHybridRetrievalInputForPlan(plan);

    expect(input.softConstraints).toEqual([
      expect.objectContaining({
        attribute: 'grape_family',
        operator: '=',
        value: 'Pinot',
        source_phrase: 'ambiguous_entity_hint(피노)',
      }),
    ]);
    expect(input.softConstraints.some((constraint) => constraint.attribute === 'grape_primary')).toBe(false);
    expect(input.lexicalQueries).toEqual(expect.arrayContaining(['피노 추천', 'pinot']));
    expect(input.semanticQueries).toEqual(
      expect.arrayContaining(['피노 추천', 'pinot noir', 'pinot gris', 'pinot blanc']),
    );
    expect(plan.expansions.ambiguousEntityHints?.[0]?.explorationBranches.map((branch) => branch.softConstraint.value)).toEqual([
      'Pinot Noir',
      'Pinot Gris',
      'Pinot Blanc',
    ]);
  });

  it('executes Pinot family ambiguity branches in parallel and merges them branch-balanced', async () => {
    const previousCriticFlag = process.env['RETRIEVAL_EXECUTOR_CRITIC'];
    process.env['RETRIEVAL_EXECUTOR_CRITIC'] = 'false';
    try {
      const plan = minimalPlan({
        rawQuery: '피노 추천',
        normalizedQuery: '피노 추천',
        queryClass: 'semantic_preference',
        constraints: { hard: [], soft: [], inferred: [] },
        expansions: {
          lexical: ['피노 추천'],
          semantic: ['피노 추천'],
          ambiguousEntityHints: [{
            surface: '피노',
            entityType: 'grape_primary',
            retrievalConstraint: {
              attribute: 'grape_family',
              operator: '=',
              value: 'Pinot',
            },
            lexicalExpansions: ['pinot'],
            semanticExpansions: ['pinot noir', 'pinot gris', 'pinot blanc'],
            clarifyOptions: ['Pinot Noir', 'Pinot Gris', 'Pinot Blanc'],
            explorationBranches: [
              {
                label: 'Pinot Noir',
                softConstraint: {
                  attribute: 'grape_primary',
                  operator: '=',
                  value: 'Pinot Noir',
                },
                matchValues: ['Pinot Noir'],
                lexicalExpansions: ['pinot noir'],
                semanticExpansions: ['pinot noir'],
              },
              {
                label: 'Pinot Gris',
                softConstraint: {
                  attribute: 'grape_primary',
                  operator: '=',
                  value: 'Pinot Gris',
                },
                matchValues: ['Pinot Gris', 'Pinot Grigio'],
                lexicalExpansions: ['pinot gris', 'pinot grigio'],
                semanticExpansions: ['pinot gris', 'pinot grigio'],
              },
              {
                label: 'Pinot Blanc',
                softConstraint: {
                  attribute: 'grape_primary',
                  operator: '=',
                  value: 'Pinot Blanc',
                },
                matchValues: ['Pinot Blanc'],
                lexicalExpansions: ['pinot blanc'],
                semanticExpansions: ['pinot blanc'],
              },
            ],
          }],
        },
      });
      const compiled = buildCompiled(plan, {
        effectiveRetrievalMode: 'attribute_search',
      });

      const candidatePool = {
        execute: vi.fn(async (input) => {
          const grapePrimary = input.softConstraints.find(
            (constraint) => constraint.attribute === 'grape_primary',
          )?.value;
          if (grapePrimary === 'Pinot Noir') {
            return [
              makeCandidate({
                entityId: createEntityId('pinot-noir-1'),
                canonicalLabel: 'Pinot Noir Lead',
                grapePrimary: 'Pinot Noir',
                fusionRrfTotal: 0.99,
              }),
              makeCandidate({
                entityId: createEntityId('pinot-noir-2'),
                canonicalLabel: 'Pinot Noir Second',
                grapePrimary: 'Pinot Noir',
                fusionRrfTotal: 0.89,
              }),
            ];
          }
          if (grapePrimary === 'Pinot Gris') {
            return [
              makeCandidate({
                entityId: createEntityId('pinot-gris-1'),
                canonicalLabel: 'Pinot Gris Lead',
                grapePrimary: 'Pinot Gris',
                fusionRrfTotal: 0.8,
              }),
            ];
          }
          if (grapePrimary === 'Pinot Blanc') {
            return [
              makeCandidate({
                entityId: createEntityId('pinot-blanc-1'),
                canonicalLabel: 'Pinot Blanc Lead',
                grapePrimary: 'Pinot Blanc',
                fusionRrfTotal: 0.7,
              }),
            ];
          }
          return [];
        }),
        getLastDegradationCodes: vi.fn(() => []),
        getLastDegradationSignals: vi.fn(() => []),
      };

      const result = await retrieveHybridCandidatesForPlan(
        plan,
        { candidatePool: candidatePool as never },
        async () => failedResolveResult(),
        compiled,
      );

      expect(candidatePool.execute).toHaveBeenCalledTimes(3);
      expect(result.candidates.map((candidate) => candidate.canonicalLabel)).toEqual([
        'Pinot Noir Lead',
        'Pinot Gris Lead',
        'Pinot Blanc Lead',
        'Pinot Noir Second',
      ]);
    } finally {
      if (previousCriticFlag === undefined) {
        delete process.env['RETRIEVAL_EXECUTOR_CRITIC'];
      } else {
        process.env['RETRIEVAL_EXECUTOR_CRITIC'] = previousCriticFlag;
      }
    }
  });

  it('runs only the compiler-selected ambiguity branch when the compiler emits a single branch', async () => {
    const previousCriticFlag = process.env['RETRIEVAL_EXECUTOR_CRITIC'];
    process.env['RETRIEVAL_EXECUTOR_CRITIC'] = 'false';
    try {
      const plan = minimalPlan({
        rawQuery: '피노 추천',
        normalizedQuery: '피노 추천',
        queryClass: 'ambiguous_short_form',
        constraints: { hard: [], soft: [], inferred: [] },
        expansions: {
          lexical: ['피노 추천'],
          semantic: ['피노 추천'],
          ambiguousEntityHints: [{
            surface: '피노',
            entityType: 'grape_primary',
            retrievalConstraint: {
              attribute: 'grape_family',
              operator: '=',
              value: 'Pinot',
            },
            lexicalExpansions: ['pinot'],
            semanticExpansions: ['pinot noir'],
            clarifyOptions: ['Pinot Noir'],
            explorationBranches: [
              {
                label: 'Pinot Noir',
                softConstraint: {
                  attribute: 'grape_primary',
                  operator: '=',
                  value: 'Pinot Noir',
                },
                matchValues: ['Pinot Noir'],
                lexicalExpansions: ['pinot noir'],
                semanticExpansions: ['pinot noir'],
              },
            ],
          }],
        },
      });
      const compiled = buildCompiled(plan, {
        effectiveRetrievalMode: 'attribute_search',
      });

      const candidatePool = {
        execute: vi.fn(async () => [
          makeCandidate({
            entityId: createEntityId('pinot-noir-1'),
            canonicalLabel: 'Pinot Noir Lead',
            grapePrimary: 'Pinot Noir',
            fusionRrfTotal: 0.99,
          }),
        ]),
        getLastDegradationCodes: vi.fn(() => []),
        getLastDegradationSignals: vi.fn(() => []),
      };

      const result = await retrieveHybridCandidatesForPlan(
        plan,
        { candidatePool: candidatePool as never },
        async () => failedResolveResult(),
        compiled,
      );

      expect(candidatePool.execute).toHaveBeenCalledTimes(1);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.canonicalLabel).toBe('Pinot Noir Lead');
    } finally {
      if (previousCriticFlag === undefined) {
        delete process.env['RETRIEVAL_EXECUTOR_CRITIC'];
      } else {
        process.env['RETRIEVAL_EXECUTOR_CRITIC'] = previousCriticFlag;
      }
    }
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
      expect.arrayContaining(['approachable', 'crowd pleasing', 'easy drinking']),
    );
    expect(input.semanticQueries).not.toEqual(
      expect.arrayContaining(['merlot', 'red blend']),
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

  it('runs typed recommendation discovery for generic gift/non-expert queries without explicit wine type', async () => {
    const previousCriticFlag = process.env['RETRIEVAL_EXECUTOR_CRITIC'];
    process.env['RETRIEVAL_EXECUTOR_CRITIC'] = 'false';
    try {
      const plan = minimalPlan({
        rawQuery: '와인 잘 모르는 사람한테 선물할 거, 실패 없는 걸로',
        normalizedQuery: '와인 잘 모르는 사람한테 선물할 거, 실패 없는 걸로',
        constraints: {
          hard: [],
          soft: [
            {
              attribute: 'occasion',
              operator: 'in',
              value: ['gift'],
              source_phrase: '선물',
              confidence: 0.95,
            },
            {
              attribute: 'style',
              operator: 'in',
              value: ['approachable', 'crowd_pleasing'],
              source_phrase: '실패 없는',
              confidence: 0.9,
            },
          ],
          inferred: [],
        },
      });
      const compiled = buildCompiled(plan, {
        effectiveRetrievalMode: 'attribute_search',
      });

      const seenInputs: Array<{
        hardValues: string[];
        semanticQueries: readonly string[];
      }> = [];
      const candidatePool = {
        execute: vi.fn(async (input) => {
          seenInputs.push({
            hardValues: input.hardConstraints
              .map((constraint) => `${constraint.attribute}:${String(constraint.value)}`)
              .sort(),
            semanticQueries: input.semanticQueries,
          });
          const wineType = input.hardConstraints.find((constraint) => constraint.attribute === 'wine_type')?.value;
          return [
            makeCandidate({
              entityId: createEntityId(`wine-${String(wineType)}`),
              wineType: typeof wineType === 'string' ? wineType : undefined,
            }),
          ];
        }),
        getLastDegradationCodes: vi.fn(() => []),
        getLastDegradationSignals: vi.fn(() => []),
      };

      const result = await retrieveHybridCandidatesForPlan(
        plan,
        { candidatePool: candidatePool as never },
        async () => failedResolveResult(),
        compiled,
      );

      expect(candidatePool.execute).toHaveBeenCalledTimes(3);
      expect(seenInputs.map((input) => input.hardValues)).toEqual([
        ['wine_type:white'],
        ['wine_type:sparkling'],
        ['wine_type:red'],
      ]);
      expect(seenInputs[0]?.semanticQueries).toEqual(
        expect.arrayContaining(['pinot grigio', 'riesling', 'moscato']),
      );
      expect(seenInputs[0]?.semanticQueries).not.toEqual(
        expect.arrayContaining(['merlot', 'red blend']),
      );
      expect(seenInputs[1]?.semanticQueries).toEqual(
        expect.arrayContaining(['prosecco', 'cava', 'cremant', 'champagne']),
      );
      expect(seenInputs[1]?.semanticQueries).not.toEqual(
        expect.arrayContaining(['merlot', 'red blend']),
      );
      expect(seenInputs[2]?.semanticQueries).toEqual(
        expect.arrayContaining(['merlot', 'red blend', 'pinot noir']),
      );
      expect(result.retrievalKind).toBe('generic_hybrid');
      expect(result.candidates.map((candidate) => String(candidate.entityId)).sort()).toEqual([
        'wine-red',
        'wine-sparkling',
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

  it('keeps typed recommendation branches branch-balanced so one wine type cannot monopolize the merge', async () => {
    const previousCriticFlag = process.env['RETRIEVAL_EXECUTOR_CRITIC'];
    process.env['RETRIEVAL_EXECUTOR_CRITIC'] = 'false';
    try {
      const plan = minimalPlan({
        rawQuery: '와인 잘 모르는 사람한테 선물할 거, 실패 없는 걸로',
        normalizedQuery: '와인 잘 모르는 사람한테 선물할 거, 실패 없는 걸로',
        constraints: {
          hard: [],
          soft: [
            {
              attribute: 'occasion',
              operator: 'in',
              value: ['gift'],
              source_phrase: '선물',
              confidence: 0.95,
            },
            {
              attribute: 'style',
              operator: 'in',
              value: ['approachable', 'crowd_pleasing'],
              source_phrase: '실패 없는',
              confidence: 0.9,
            },
          ],
          inferred: [],
        },
      });
      const compiled = buildCompiled(plan, {
        effectiveRetrievalMode: 'attribute_search',
      });

      const candidatePool = {
        execute: vi.fn(async (input) => {
          const wineType = input.hardConstraints.find((constraint) => constraint.attribute === 'wine_type')?.value;
          const scoreKey = typeof wineType === 'string' ? wineType : 'unknown';
          const score =
            scoreKey === 'white'
              ? 0.86
              : scoreKey === 'sparkling'
                ? 0.95
                : scoreKey === 'red'
                  ? 0.91
                  : 0.8;
          return [
            makeCandidate({
              entityId: createEntityId(`wine-${scoreKey}`),
              canonicalLabel: `branch-${scoreKey}`,
              wineType: typeof wineType === 'string' ? wineType : undefined,
              fusionRrfTotal: score,
            }),
          ];
        }),
        getLastDegradationCodes: vi.fn(() => []),
        getLastDegradationSignals: vi.fn(() => []),
      };

      const result = await retrieveHybridCandidatesForPlan(
        plan,
        { candidatePool: candidatePool as never },
        async () => failedResolveResult(),
        compiled,
      );

      expect(candidatePool.execute).toHaveBeenCalledTimes(3);
      expect(result.candidates.map((candidate) => String(candidate.entityId))).toEqual([
        'wine-white',
        'wine-sparkling',
        'wine-red',
      ]);
      expect(result.candidates.map((candidate) => candidate.canonicalLabel)).toEqual([
        'branch-white',
        'branch-sparkling',
        'branch-red',
      ]);
    } finally {
      if (previousCriticFlag === undefined) {
        delete process.env['RETRIEVAL_EXECUTOR_CRITIC'];
      } else {
        process.env['RETRIEVAL_EXECUTOR_CRITIC'] = previousCriticFlag;
      }
    }
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
          return {
            candidates: [
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
            ],
            telemetry: {
              degradationCodes: [],
              degradationSignals: suffix === 'red'
                ? [{
                    component: 'dense_semantic',
                    severity: 'warning' as const,
                    reason: 'timeout',
                    fallbackApplied: 'sparse_only',
                  }]
                : [],
              dropLog: [{
                entityId: `dropped-${suffix}`,
                dropStage: 'hard_filter' as const,
                dropReason: `${suffix}-filter`,
                lastKnownScore: 0.05,
                channels: [],
              }],
            },
          };
        }),
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
      expect(result.routeDegradation?.degradationReasons).toContain(
        'retrieval_degraded:dense_semantic:timeout',
      );
      expect(result.hardFilterDropLog).toEqual([
        {
          entityId: 'dropped-red',
          dropStage: 'hard_filter',
          dropReason: 'red-filter',
          lastKnownScore: 0.05,
          channels: [],
        },
        {
          entityId: 'dropped-white',
          dropStage: 'hard_filter',
          dropReason: 'white-filter',
          lastKnownScore: 0.05,
          channels: [],
        },
      ]);
    } finally {
      if (previousCriticFlag === undefined) {
        delete process.env['RETRIEVAL_EXECUTOR_CRITIC'];
      } else {
        process.env['RETRIEVAL_EXECUTOR_CRITIC'] = previousCriticFlag;
      }
    }
  });

  it('fail-closes typed recommendation discovery when a required wine-type branch rejects', async () => {
    const previousCriticFlag = process.env['RETRIEVAL_EXECUTOR_CRITIC'];
    process.env['RETRIEVAL_EXECUTOR_CRITIC'] = 'false';
    try {
      const plan = minimalPlan({
        rawQuery: '와인 잘 모르는 사람한테 선물할 거, 실패 없는 걸로',
        normalizedQuery: '와인 잘 모르는 사람한테 선물할 거, 실패 없는 걸로',
        constraints: {
          hard: [],
          soft: [
            {
              attribute: 'occasion',
              operator: 'in',
              value: ['gift'],
              source_phrase: '선물',
              confidence: 0.95,
            },
            {
              attribute: 'style',
              operator: 'in',
              value: ['approachable', 'crowd_pleasing'],
              source_phrase: '실패 없는',
              confidence: 0.9,
            },
          ],
          inferred: [],
        },
      });
      const compiled = buildCompiled(plan, {
        effectiveRetrievalMode: 'attribute_search',
      });

      const candidatePool = {
        execute: vi.fn(async (input) => {
          const wineType = input.hardConstraints.find((constraint) => constraint.attribute === 'wine_type')?.value;
          if (wineType === 'sparkling') {
            throw new Error('HTTP/2 GOAWAY');
          }
          return [
            makeCandidate({
              entityId: createEntityId(`wine-${String(wineType)}`),
              wineType: typeof wineType === 'string' ? wineType : undefined,
            }),
          ];
        }),
      };

      const result = await retrieveHybridCandidatesForPlan(
        plan,
        { candidatePool: candidatePool as never },
        async () => failedResolveResult(),
        compiled,
      );

      expect(candidatePool.execute).toHaveBeenCalledTimes(3);
      expect(result.candidates).toEqual([]);
      expect(result.routeDegradation?.degradationReasons).toContain(
        'retrieval_branch_fail_closed:typed_recommendation:sparkling',
      );
    } finally {
      if (previousCriticFlag === undefined) {
        delete process.env['RETRIEVAL_EXECUTOR_CRITIC'];
      } else {
        process.env['RETRIEVAL_EXECUTOR_CRITIC'] = previousCriticFlag;
      }
    }
  });

  it('propagates typed retrieval execution telemetry through generic hybrid retrieval without candidate-pool getters', async () => {
    const previousCriticFlag = process.env['RETRIEVAL_EXECUTOR_CRITIC'];
    process.env['RETRIEVAL_EXECUTOR_CRITIC'] = 'false';
    try {
      const plan = minimalPlan();
      const compiled = buildCompiled(plan, {
        effectiveRetrievalMode: 'attribute_search',
      });

      const candidatePool = {
        execute: vi.fn(async () => ({
          candidates: [
            makeCandidate({
              entityId: createEntityId('wine-typed'),
              canonicalLabel: 'Typed Telemetry Wine',
            }),
          ],
          telemetry: {
            degradationCodes: ['sparse_pool'],
            degradationSignals: [{
              component: 'dense_semantic',
              severity: 'warning' as const,
              reason: 'timeout',
              fallbackApplied: 'sparse_only',
            }],
            fusionTrace: {
              queryClass: plan.queryClass,
              fusionClass: plan.queryClass,
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
              entityId: 'dropped-typed',
              dropStage: 'hard_filter' as const,
              dropReason: 'typed filter',
              lastKnownScore: 0.11,
              channels: [],
            }],
          },
        })),
      };

      const result = await retrieveHybridCandidatesForPlan(
        plan,
        { candidatePool: candidatePool as never },
        async () => failedResolveResult(),
        compiled,
      );

      expect(candidatePool.execute).toHaveBeenCalledTimes(1);
      expect(result.candidates.map((candidate) => String(candidate.entityId))).toEqual(['wine-typed']);
      expect(result.retrievalFusionTrace).toEqual({
        queryClass: plan.queryClass,
        fusionClass: plan.queryClass,
        rrfK: 60,
        channelWeights: { sparse: 1, dense: 1, anchor: 0, learnedSparse: 0 },
        candidateCount: {
          beforeFusion: { sparse: 1, dense: 0, anchor: 0 },
          afterFusion: 1,
          afterHardFilter: 1,
          afterAssembly: 1,
        },
      });
      expect(result.hardFilterDropLog).toEqual([{
        entityId: 'dropped-typed',
        dropStage: 'hard_filter',
        dropReason: 'typed filter',
        lastKnownScore: 0.11,
        channels: [],
      }]);
      expect(result.routeDegradation?.degradationReasons).toContain(
        'retrieval_degraded:dense_semantic:timeout',
      );
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

  it('surfaces bundle-selector fail-closed reasons into route degradation', async () => {
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
                entityId: createEntityId('app-only'),
                priceUsd: 100,
                fusionRrfTotal: 0.95,
              }),
            ];
          }
          return [
            makeCandidate({
              entityId: createEntityId('main-only'),
              priceUsd: 100,
              fusionRrfTotal: 0.96,
            }),
          ];
        }),
      };

      const result = await retrieveHybridCandidatesForPlan(
        plan,
        { candidatePool: candidatePool as never },
        async () => failedResolveResult(),
        compiled,
      );

      expect(result.retrievalKind).toBe('generic_hybrid');
      expect(result.candidates).toEqual([]);
      expect(result.routeDegradation?.degradationReasons).toContain(
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

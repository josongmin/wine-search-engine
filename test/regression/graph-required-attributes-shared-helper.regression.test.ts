/**
 * ADR-011 Phase 1b.3a: shared `resolveRequiredAttributes` helper semantics.
 *
 * Locks the graph-vs-flat contract so `provenance-closure` and
 * `decision-input` cannot drift in XOR / OR / AND group semantics. Trivial
 * graph output MUST equal flat-fallback output byte-for-byte.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { resolveRequiredAttributes } from '../../src/domain/query/service/graph-required-attributes.js';
import { buildTrivialGraphFromAtoms } from '../../src/domain/query/service/build-trivial-graph-from-atoms.js';
import { liftBundleToAtoms } from '../../src/domain/shared/types/constraint-atom.js';
import type { ConstraintBundle } from '../../src/domain/shared/types/constraint-bundle.js';
import type { ConstraintGraph, ConstraintGraphNode } from '../../src/domain/query/model/constraint-graph.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';

const BUNDLE: ConstraintBundle = {
  hard: [
    { attribute: 'wine_type', operator: '=', value: 'red', source_phrase: 'red', confidence: 1 },
    { attribute: 'region', operator: '=', value: 'Bordeaux', source_phrase: 'Bordeaux', confidence: 1 },
  ],
  soft: [],
  inferred: [],
};

function makePlan(bundle: ConstraintBundle = BUNDLE): QueryPlanV1 {
  return {
    rawQuery: 'red Bordeaux',
    normalizedQuery: 'red bordeaux',
    intent: 'search' as QueryPlanV1['intent'],
    anchors: [],
    constraints: bundle,
    expansions: { lexical: [], semantic: [] },
    uncertainty: { parsing: 'low', anchoring: 'low', constraints: 'low' } as QueryPlanV1['uncertainty'],
    queryClass: 'constraint_only' as QueryPlanV1['queryClass'],
    plannerVersion: '0',
    policyRuleVersion: '0',
    thresholdProfileId: 'default',
    suggestedRoute: 'hybrid',
    suggestedRetrievalMode: 'attribute_search',
  } as QueryPlanV1;
}

function slot(id: string, attribute: string): ConstraintGraphNode {
  return {
    kind: 'slot',
    nodeId: id,
    atomRef: id,
    attribute,
    operator: '=',
    value: 'x',
    sourceTier: 'hard',
    sourceKind: 'explicit_utterance',
    confidence: 1,
  };
}

function customGraph(rootId: string, nodes: readonly ConstraintGraphNode[]): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1',
    origin: 'deterministic_from_atoms',
    rootNodeId: rootId,
    nodes,
    edges: [],
    globalBudgets: {},
  };
}

describe('resolveRequiredAttributes — flat fallback (no graph)', () => {
  it('all required matched → satisfied=true, unmet empty', () => {
    const r = resolveRequiredAttributes({
      plan: makePlan(),
      satisfiedAttributes: ['wine_type', 'region'],
    });
    expect([...r.matched].sort()).toEqual(['region', 'wine_type']);
    expect(r.unmet).toEqual([]);
    expect(r.satisfied).toBe(true);
  });

  it('partial match → satisfied=false, unmet reflects missing', () => {
    const r = resolveRequiredAttributes({
      plan: makePlan(),
      satisfiedAttributes: ['wine_type'],
    });
    expect(r.matched).toEqual(['wine_type']);
    expect(r.unmet).toEqual(['region']);
    expect(r.satisfied).toBe(false);
  });

  it('empty satisfied set → all required unmet, satisfied=false', () => {
    const r = resolveRequiredAttributes({
      plan: makePlan(),
      satisfiedAttributes: [],
    });
    expect(r.matched).toEqual([]);
    expect([...r.unmet].sort()).toEqual(['region', 'wine_type']);
    expect(r.satisfied).toBe(false);
  });

  it('plan with zero hard constraints → satisfied=false by legacy semantics', () => {
    const empty: ConstraintBundle = { hard: [], soft: [], inferred: [] };
    const r = resolveRequiredAttributes({
      plan: makePlan(empty),
      satisfiedAttributes: [],
    });
    expect(r.matched).toEqual([]);
    expect(r.unmet).toEqual([]);
    expect(r.satisfied).toBe(false);
  });

  it('extra satisfied attributes outside required set are ignored', () => {
    const r = resolveRequiredAttributes({
      plan: makePlan(),
      satisfiedAttributes: ['wine_type', 'region', 'price_usd', 'producer'],
    });
    expect([...r.matched].sort()).toEqual(['region', 'wine_type']);
    expect(r.unmet).toEqual([]);
    expect(r.satisfied).toBe(true);
  });
});

describe('resolveRequiredAttributes — trivial graph parity with flat', () => {
  it('trivial graph (from bundle) = flat path, byte-identical across all scenarios', () => {
    const atoms = liftBundleToAtoms(BUNDLE);
    const graph = buildTrivialGraphFromAtoms(atoms);
    const plan = makePlan();

    const scenarios: readonly (readonly string[])[] = [
      ['wine_type', 'region'],
      ['wine_type'],
      [],
      ['wine_type', 'region', 'extra_attr'],
    ];

    for (const satisfiedAttributes of scenarios) {
      const flat = resolveRequiredAttributes({ plan, satisfiedAttributes });
      const withGraph = resolveRequiredAttributes({ plan, graph, satisfiedAttributes });
      expect([...withGraph.matched].sort()).toEqual([...flat.matched].sort());
      expect([...withGraph.unmet].sort()).toEqual([...flat.unmet].sort());
      expect(withGraph.satisfied).toBe(flat.satisfied);
    }
  });
});

describe('resolveRequiredAttributes — graph-only semantics (XOR / OR / nested)', () => {
  const plan = makePlan();

  it('XOR group: one child matched → satisfied=true, matched carries only the picked slot', () => {
    const graph = customGraph('root', [
      { kind: 'group_xor', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'wine_type_red'),
      slot('s2', 'wine_type_white'),
    ]);
    const r = resolveRequiredAttributes({
      plan,
      graph,
      satisfiedAttributes: ['wine_type_red'],
    });
    expect(r.matched).toEqual(['wine_type_red']);
    expect(r.unmet).toEqual([]);
    expect(r.satisfied).toBe(true);
  });

  it('XOR group: both children matched → satisfied=false (mutual exclusion breached)', () => {
    const graph = customGraph('root', [
      { kind: 'group_xor', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'wine_type_red'),
      slot('s2', 'wine_type_white'),
    ]);
    const r = resolveRequiredAttributes({
      plan,
      graph,
      satisfiedAttributes: ['wine_type_red', 'wine_type_white'],
    });
    expect(r.satisfied).toBe(false);
  });

  it('OR group: any child matched → satisfied=true, unmet is empty (non-picked children do not linger as unmet)', () => {
    const graph = customGraph('root', [
      { kind: 'group_or', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'region_bordeaux'),
      slot('s2', 'region_burgundy'),
    ]);
    const r = resolveRequiredAttributes({
      plan,
      graph,
      satisfiedAttributes: ['region_bordeaux'],
    });
    expect(r.matched).toEqual(['region_bordeaux']);
    expect(r.unmet).toEqual([]);
    expect(r.satisfied).toBe(true);
  });

  it('Nested AND(OR, slot): inner OR picks one, outer AND still requires the second', () => {
    const graph = customGraph('root', [
      { kind: 'group_and', nodeId: 'root', children: ['or1', 's3'] },
      { kind: 'group_or', nodeId: 'or1', children: ['s1', 's2'] },
      slot('s1', 'region_bordeaux'),
      slot('s2', 'region_burgundy'),
      slot('s3', 'price_usd'),
    ]);
    const partial = resolveRequiredAttributes({
      plan,
      graph,
      satisfiedAttributes: ['region_bordeaux'],
    });
    expect(partial.matched).toEqual(['region_bordeaux']);
    expect(partial.unmet).toEqual(['price_usd']);
    expect(partial.satisfied).toBe(false);

    const full = resolveRequiredAttributes({
      plan,
      graph,
      satisfiedAttributes: ['region_burgundy', 'price_usd'],
    });
    expect(full.satisfied).toBe(true);
  });

  it('ignores inferred-tier slots when deriving required evidence obligations', () => {
    const bundle: ConstraintBundle = {
      hard: [
        { attribute: 'region', operator: '=', value: 'Toscana', source_phrase: 'toscana', confidence: 1 },
      ],
      soft: [],
      inferred: [
        { attribute: 'country', operator: '=', value: 'Italy', source_phrase: 'italy', confidence: 1 },
      ],
    };
    const graph = buildTrivialGraphFromAtoms(liftBundleToAtoms(bundle));
    const r = resolveRequiredAttributes({
      plan: makePlan(bundle),
      graph,
      satisfiedAttributes: ['region'],
    });
    expect(r.matched).toEqual(['region']);
    expect(r.unmet).toEqual([]);
    expect(r.satisfied).toBe(true);
  });
});

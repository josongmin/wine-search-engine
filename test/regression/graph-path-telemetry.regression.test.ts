/**
 * Wave F4: unified graph-path telemetry module regression.
 *
 * Locks the recorder/accumulator contract. Reader-side wiring (6 readers
 * calling `recordGraphPathDecision`) is intentionally deferred to a
 * follow-up commit — this regression ONLY proves the module itself is
 * correct. The allow-list regression picks up the new file.
 *
 * Append-only test: never delete this file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyGraphPresence,
  recordGraphPathDecision,
  resetGraphPathCounters,
  snapshotGraphPathCounters,
  type GraphPathDecision,
  type GraphPathOutcome,
  type GraphPathReader,
} from '../../src/observability/graph-path-telemetry.js';

describe('graph-path-telemetry — recorder + snapshot', () => {
  beforeEach(() => {
    resetGraphPathCounters();
  });
  afterEach(() => {
    resetGraphPathCounters();
  });

  it('starts at zero for every (reader, outcome) bucket after reset', () => {
    const snap = snapshotGraphPathCounters();
    for (const reader of Object.keys(snap.byReader)) {
      const record = snap.byReader[reader]!;
      for (const outcome of Object.keys(record)) {
        expect(record[outcome as GraphPathOutcome]).toBe(0);
      }
    }
    for (const outcome of Object.keys(snap.totalByOutcome)) {
      expect(snap.totalByOutcome[outcome as GraphPathOutcome]).toBe(0);
    }
  });

  it('recordGraphPathDecision increments per-reader and total counters', () => {
    const decision: GraphPathDecision = {
      reader: 'provenance_closure',
      outcome: 'graph_aware_trivial',
    };
    recordGraphPathDecision(decision);
    recordGraphPathDecision(decision);
    const snap = snapshotGraphPathCounters();
    expect(snap.byReader['provenance_closure']?.['graph_aware_trivial']).toBe(2);
    expect(snap.totalByOutcome['graph_aware_trivial']).toBe(2);
    // No cross-bucket leakage.
    expect(snap.byReader['provenance_closure']?.['flat_fallback_no_graph']).toBe(0);
    expect(snap.byReader['decision_input']?.['graph_aware_trivial']).toBe(0);
  });

  it('mixed workload accumulates correctly across readers', () => {
    const inputs: readonly GraphPathDecision[] = [
      { reader: 'provenance_closure', outcome: 'graph_aware_trivial' },
      { reader: 'provenance_closure', outcome: 'graph_aware_trivial' },
      { reader: 'provenance_closure', outcome: 'graph_aware_trivial' },
      { reader: 'decision_input', outcome: 'flat_fallback_no_graph' },
      { reader: 'decision_input', outcome: 'flat_fallback_no_graph' },
      { reader: 'ranker_hard_gate', outcome: 'graph_aware_hybrid' },
    ];
    for (const d of inputs) recordGraphPathDecision(d);
    const snap = snapshotGraphPathCounters();
    expect(snap.byReader['provenance_closure']?.['graph_aware_trivial']).toBe(3);
    expect(snap.byReader['decision_input']?.['flat_fallback_no_graph']).toBe(2);
    expect(snap.byReader['ranker_hard_gate']?.['graph_aware_hybrid']).toBe(1);
    expect(snap.totalByOutcome['graph_aware_trivial']).toBe(3);
    expect(snap.totalByOutcome['flat_fallback_no_graph']).toBe(2);
    expect(snap.totalByOutcome['graph_aware_hybrid']).toBe(1);
  });

  it('throws on unknown reader', () => {
    expect(() =>
      recordGraphPathDecision({
        reader: 'rogue_reader' as GraphPathReader,
        outcome: 'graph_aware_trivial',
      }),
    ).toThrow(/unknown reader/);
  });

  it('throws on unknown outcome', () => {
    expect(() =>
      recordGraphPathDecision({
        reader: 'provenance_closure',
        outcome: 'rogue_outcome' as GraphPathOutcome,
      }),
    ).toThrow(/unknown outcome/);
  });

  it('resetGraphPathCounters clears all buckets', () => {
    recordGraphPathDecision({
      reader: 'graph_executor',
      outcome: 'graph_aware_hybrid',
    });
    const beforeReset = snapshotGraphPathCounters();
    expect(beforeReset.totalByOutcome['graph_aware_hybrid']).toBe(1);
    resetGraphPathCounters();
    const afterReset = snapshotGraphPathCounters();
    expect(afterReset.totalByOutcome['graph_aware_hybrid']).toBe(0);
  });
});

describe('classifyGraphPresence — outcome derivation', () => {
  it('graph absent → flat_fallback_no_graph', () => {
    expect(
      classifyGraphPresence({ graphPresent: false, graphEmitFlagOn: true }),
    ).toBe('flat_fallback_no_graph');
  });

  it('trivial graph → graph_aware_trivial', () => {
    expect(
      classifyGraphPresence({
        graphPresent: true,
        graphOrigin: 'deterministic_from_atoms',
        graphEmitFlagOn: true,
      }),
    ).toBe('graph_aware_trivial');
  });

  it('planner_emitted graph → graph_aware_planner', () => {
    expect(
      classifyGraphPresence({
        graphPresent: true,
        graphOrigin: 'planner_emitted',
        graphEmitFlagOn: true,
      }),
    ).toBe('graph_aware_planner');
  });

  it('hybrid graph → graph_aware_hybrid', () => {
    expect(
      classifyGraphPresence({
        graphPresent: true,
        graphOrigin: 'hybrid',
        graphEmitFlagOn: true,
      }),
    ).toBe('graph_aware_hybrid');
  });

  it('flag-off override → flat_fallback_flag_off', () => {
    expect(
      classifyGraphPresence({ graphPresent: false, graphEmitFlagOn: false }),
    ).toBe('flat_fallback_flag_off');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Wave I2: graph_executor + bundle_selector reader-side wiring
// ─────────────────────────────────────────────────────────────────────

describe('graph-path-telemetry — graph_executor reader wiring (Wave I2)', () => {
  beforeEach(() => {
    resetGraphPathCounters();
  });
  afterEach(() => {
    resetGraphPathCounters();
  });

  it('executeGraphAware on a trivial graph increments byReader.graph_executor.graph_aware_trivial', async () => {
    const { executeGraphAware } = await import(
      '../../src/application/search/search-usecase-graph-executor.js'
    );
    const { BundleSelectorImpl } = await import(
      '../../src/domain/retrieval/service/bundle-selector.js'
    );
    type HybridCandidateT =
      import('../../src/domain/retrieval/model/hybrid-candidate.js').HybridCandidate;
    type CandidatePoolPortT =
      import('../../src/application/search/port/search-pipeline-deps.port.js').CandidatePoolPort;
    type HybridRetrievalInputT =
      import('../../src/domain/retrieval/model/retrieval-input.js').HybridRetrievalInput;
    type ConstraintGraphT =
      import('../../src/domain/query/model/constraint-graph.js').ConstraintGraph;

    const stubCandidatePool: CandidatePoolPortT = {
      execute: async () => [] as readonly HybridCandidateT[],
      generate: async () => [] as readonly HybridCandidateT[],
    };
    const stubInput = {
      queryPlan: {} as never,
      route: 'hybrid',
      lexicalQueries: [],
      semanticQueries: [],
      hardConstraints: [],
      softConstraints: [],
    } as unknown as HybridRetrievalInputT;

    const trivial: ConstraintGraphT = {
      graphSchemaVersion: 'constraint_graph_v1',
      origin: 'deterministic_from_atoms',
      rootNodeId: 'root',
      nodes: [{ kind: 'group_and', nodeId: 'root', children: [] }],
      edges: [],
      globalBudgets: {},
    };

    await executeGraphAware(
      stubInput,
      trivial,
      { candidatePool: stubCandidatePool, bundleSelector: new BundleSelectorImpl() },
      { scoreFor: () => 0, priceFor: () => 0 },
    );

    const snap = snapshotGraphPathCounters();
    expect(snap.byReader['graph_executor']?.['graph_aware_trivial']).toBeGreaterThanOrEqual(1);
    // Other reader buckets must not leak.
    expect(snap.byReader['bundle_selector']?.['graph_aware_trivial']).toBe(0);
  });
});

describe('graph-path-telemetry — bundle_selector reader wiring (Wave I2)', () => {
  beforeEach(() => {
    resetGraphPathCounters();
  });
  afterEach(() => {
    resetGraphPathCounters();
  });

  it('BundleSelectorImpl.chooseAssignment increments byReader.bundle_selector', async () => {
    const { BundleSelectorImpl } = await import(
      '../../src/domain/retrieval/service/bundle-selector.js'
    );
    type HybridCandidateT =
      import('../../src/domain/retrieval/model/hybrid-candidate.js').HybridCandidate;
    type ConstraintGraphT =
      import('../../src/domain/query/model/constraint-graph.js').ConstraintGraph;

    // Minimal hybrid graph with two subqueries — sufficient to reach the
    // telemetry call at the top of chooseAssignment. The solver path past
    // the telemetry is not under test here (the reader increments BEFORE
    // the k==0 / k>K_EXACT_LIMIT / empty-slot branches execute).
    const hybrid: ConstraintGraphT = {
      graphSchemaVersion: 'constraint_graph_v1.1',
      origin: 'hybrid',
      rootNodeId: 'root',
      nodes: [
        { kind: 'group_and', nodeId: 'root', children: ['sq_0', 'sq_1'] },
        { kind: 'subquery', nodeId: 'sq_0', purpose: 'p0', targetCardinality: 1 },
        { kind: 'subquery', nodeId: 'sq_1', purpose: 'p1', targetCardinality: 1 },
      ],
      edges: [],
      globalBudgets: {},
    };

    const pools = new Map<string, readonly HybridCandidateT[]>([
      ['sq_0', []],
      ['sq_1', []],
    ]);

    new BundleSelectorImpl().chooseAssignment(hybrid, pools, {
      scoreFor: () => 0,
      priceFor: () => 0,
    });

    const snap = snapshotGraphPathCounters();
    // hybrid graph → graph_aware_hybrid outcome
    expect(snap.byReader['bundle_selector']?.['graph_aware_hybrid']).toBeGreaterThanOrEqual(1);
    // graph_executor reader must NOT be touched by a direct chooseAssignment call.
    expect(snap.byReader['graph_executor']?.['graph_aware_hybrid']).toBe(0);
  });
});

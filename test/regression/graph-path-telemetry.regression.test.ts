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

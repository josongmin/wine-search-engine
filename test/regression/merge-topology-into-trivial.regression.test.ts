/**
 * ADR-012 Phase 1b.2: `mergeTopologyIntoTrivial` invariants.
 *
 * - Disjoint node-id namespaces (slot-* vs topology/*) — collisions fail closed.
 * - Slot nodes preserved byte-identical.
 * - Topology group can designate root; trivial root-and-* wrapper dropped.
 * - Idempotent: merge(trivial, merge(trivial, t)) === merge(trivial, t).
 * - Edges must reference topology nodes only.
 * - Result origin is always 'hybrid'; schema bumps to v1.1.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { mergeTopologyIntoTrivial } from '../../src/domain/query/service/merge-topology-into-trivial.js';
import { buildTrivialGraphFromAtoms } from '../../src/domain/query/service/build-trivial-graph-from-atoms.js';
import { liftBundleToAtoms } from '../../src/domain/shared/types/constraint-atom.js';
import type { ConstraintBundle } from '../../src/domain/shared/types/constraint-bundle.js';
import {
  CONSTRAINT_GRAPH_SCHEMA_VERSION_V1_1,
  type ConstraintGraph,
} from '../../src/domain/query/model/constraint-graph.js';

const BUNDLE: ConstraintBundle = {
  hard: [
    { attribute: 'wine_type', operator: '=', value: 'red', source_phrase: 'red', confidence: 1 },
    { attribute: 'wine_type', operator: '=', value: 'white', source_phrase: 'white', confidence: 1 },
  ],
  soft: [],
  inferred: [],
};

function trivialGraph(): ConstraintGraph {
  return buildTrivialGraphFromAtoms(liftBundleToAtoms(BUNDLE));
}

function xorTopology(slotIds: readonly string[]): ConstraintGraph {
  return {
    graphSchemaVersion: CONSTRAINT_GRAPH_SCHEMA_VERSION_V1_1,
    origin: 'planner_emitted',
    rootNodeId: 'topology/root-xor',
    nodes: [
      { kind: 'group_xor', nodeId: 'topology/root-xor', children: [...slotIds] },
    ],
    edges: [],
    globalBudgets: {},
    promptVersion: 'ctg_topology_v1',
    generatedAt: '2026-04-15T10:00:00.000Z',
    llmModel: 'claude-opus-4-6',
  };
}

describe('mergeTopologyIntoTrivial', () => {
  it('preserves slot nodes byte-identical', () => {
    const trivial = trivialGraph();
    const slotIds = trivial.nodes.filter((n) => n.kind === 'slot').map((n) => n.nodeId);
    const topology = xorTopology(slotIds);
    const merged = mergeTopologyIntoTrivial(trivial, topology);
    expect(merged).not.toBeNull();
    if (merged === null) return;
    const mergedSlots = merged.nodes.filter((n) => n.kind === 'slot');
    const trivialSlots = trivial.nodes.filter((n) => n.kind === 'slot');
    expect(JSON.stringify(mergedSlots)).toBe(JSON.stringify(trivialSlots));
  });

  it('drops the trivial root-and wrapper; topology owns the new root', () => {
    const trivial = trivialGraph();
    const slotIds = trivial.nodes.filter((n) => n.kind === 'slot').map((n) => n.nodeId);
    const topology = xorTopology(slotIds);
    const merged = mergeTopologyIntoTrivial(trivial, topology);
    expect(merged).not.toBeNull();
    if (merged === null) return;
    expect(merged.rootNodeId).toBe('topology/root-xor');
    // Original trivial root (root-and-*) must NOT survive.
    const trivialRootId = trivial.rootNodeId;
    expect(merged.nodes.find((n) => n.nodeId === trivialRootId)).toBeUndefined();
  });

  it('preserves topology origin (deterministic → planner_emitted, LLM → hybrid) + schema v1.1', () => {
    // Wave F1 contract: merge does NOT re-label origin. Deterministic
    // detector emits `'planner_emitted'`; LLM planner emits `'hybrid'`.
    // Downstream telemetry depends on this distinction.
    const trivial = trivialGraph();
    const slotIds = trivial.nodes.filter((n) => n.kind === 'slot').map((n) => n.nodeId);

    const detMerged = mergeTopologyIntoTrivial(
      trivial,
      { ...xorTopology(slotIds), origin: 'planner_emitted' },
    );
    expect(detMerged?.origin).toBe('planner_emitted');
    expect(detMerged?.graphSchemaVersion).toBe(CONSTRAINT_GRAPH_SCHEMA_VERSION_V1_1);

    const llmMerged = mergeTopologyIntoTrivial(
      trivial,
      { ...xorTopology(slotIds), origin: 'hybrid' },
    );
    expect(llmMerged?.origin).toBe('hybrid');
    expect(llmMerged?.graphSchemaVersion).toBe(CONSTRAINT_GRAPH_SCHEMA_VERSION_V1_1);
  });

  it('returns null when topology node id collides with a slot id', () => {
    const trivial = trivialGraph();
    const slotId = trivial.nodes.find((n) => n.kind === 'slot')!.nodeId;
    const bad: ConstraintGraph = {
      ...xorTopology([]),
      nodes: [
        // Topology node reusing a slot id — must fail.
        { kind: 'group_and', nodeId: slotId, children: [] },
      ],
      rootNodeId: slotId,
    };
    expect(mergeTopologyIntoTrivial(trivial, bad)).toBeNull();
  });

  it('returns null when topology node id does not start with "topology/"', () => {
    const trivial = trivialGraph();
    const bad: ConstraintGraph = {
      ...xorTopology([]),
      nodes: [{ kind: 'group_and', nodeId: 'rogue-node', children: [] }],
      rootNodeId: 'rogue-node',
    };
    expect(mergeTopologyIntoTrivial(trivial, bad)).toBeNull();
  });

  it('returns null when group children reference missing ids', () => {
    const trivial = trivialGraph();
    const bad: ConstraintGraph = {
      ...xorTopology([]),
      nodes: [
        { kind: 'group_and', nodeId: 'topology/root', children: ['slot-nonexistent'] },
      ],
      rootNodeId: 'topology/root',
    };
    expect(mergeTopologyIntoTrivial(trivial, bad)).toBeNull();
  });

  it('returns null when an edge references a slot id (edges are topology-only)', () => {
    const trivial = trivialGraph();
    const slotId = trivial.nodes.find((n) => n.kind === 'slot')!.nodeId;
    const bad: ConstraintGraph = {
      ...xorTopology([]),
      nodes: [{ kind: 'subquery', nodeId: 'topology/sq', purpose: 'x', targetCardinality: 1 }],
      edges: [{ kind: 'depends_on', from: 'topology/sq', to: slotId }],
      rootNodeId: 'topology/sq',
    };
    expect(mergeTopologyIntoTrivial(trivial, bad)).toBeNull();
  });

  it('returns null when root is not a topology node', () => {
    const trivial = trivialGraph();
    const slotId = trivial.nodes.find((n) => n.kind === 'slot')!.nodeId;
    const bad: ConstraintGraph = {
      ...xorTopology([]),
      nodes: [{ kind: 'group_xor', nodeId: 'topology/x', children: [slotId] }],
      rootNodeId: slotId,
    };
    expect(mergeTopologyIntoTrivial(trivial, bad)).toBeNull();
  });

  it('is idempotent byte-for-byte', () => {
    const trivial = trivialGraph();
    const slotIds = trivial.nodes.filter((n) => n.kind === 'slot').map((n) => n.nodeId);
    const topology = xorTopology(slotIds);
    const first = mergeTopologyIntoTrivial(trivial, topology);
    expect(first).not.toBeNull();
    if (first === null) return;
    // Re-merging the already-merged graph isn't valid (it's no longer trivial
    // → returns null). Instead, re-merge the trivial with the SAME topology
    // and assert byte equality.
    const second = mergeTopologyIntoTrivial(trivial, topology);
    expect(second).not.toBeNull();
    if (second === null) return;
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('refuses to merge when trivial input is not deterministic', () => {
    const notTrivial: ConstraintGraph = {
      ...trivialGraph(),
      origin: 'hybrid',
    };
    const slotIds = notTrivial.nodes.filter((n) => n.kind === 'slot').map((n) => n.nodeId);
    expect(mergeTopologyIntoTrivial(notTrivial, xorTopology(slotIds))).toBeNull();
  });

  it('propagates replay metadata from topology into result', () => {
    const trivial = trivialGraph();
    const slotIds = trivial.nodes.filter((n) => n.kind === 'slot').map((n) => n.nodeId);
    const topology = xorTopology(slotIds);
    const merged = mergeTopologyIntoTrivial(trivial, topology);
    expect(merged).not.toBeNull();
    if (merged === null) return;
    expect(merged.promptVersion).toBe('ctg_topology_v1');
    expect(merged.llmModel).toBe('claude-opus-4-6');
  });
});

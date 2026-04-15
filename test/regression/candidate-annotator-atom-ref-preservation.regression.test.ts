/**
 * ADR-014 Phase 1b.3b: annotator preserves per-atom match records via
 * `matchedAtomRefs` / `unmetAtomRefs` keyed to graph slot-node IDs.
 *
 * Locks:
 *  - Same attribute matched under two distinct slot nodes produces two
 *    distinct atomRef entries (XOR slot A vs slot B).
 *  - Trivial-graph atomRef emission aligns 1:1 with slot insertion
 *    order.
 *  - Ordering deterministic for identical input.
 *  - Absent graph → no atomRef fields written (exactOptionalPropertyTypes).
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { annotateCandidateConstraintEvidence } from '../../src/domain/retrieval/service/candidate-constraint-evidence.js';
import type { ConstraintBundle } from '../../src/domain/shared/types/index.js';
import type { CanonicalEntityId } from '../../src/domain/shared/types/index.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';
import type {
  ConstraintGraph,
  ConstraintGraphNode,
} from '../../src/domain/query/model/constraint-graph.js';

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

function graph(
  rootId: string,
  nodes: readonly ConstraintGraphNode[],
): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1',
    origin: 'deterministic_from_atoms',
    rootNodeId: rootId,
    nodes,
    edges: [],
    globalBudgets: {},
  };
}

function bundle(): ConstraintBundle {
  return { hard: [], soft: [], inferred: [] };
}

function baseCandidate(overrides: Partial<HybridCandidate> = {}): HybridCandidate {
  return {
    entityId: 'wine-xxxx' as CanonicalEntityId,
    matchedConstraints: [],
    retrievalFusionScore: 0,
    ...overrides,
  } as unknown as HybridCandidate;
}

describe('annotator atomRef preservation — ADR-014 Phase 1b.3b', () => {
  it('same attribute matched via two slots → two distinct matchedAtomRefs', () => {
    const g = graph('root', [
      { kind: 'group_xor', nodeId: 'root', children: ['sA', 'sB'] },
      slot('sA', 'region'),
      slot('sB', 'region'),
    ]);
    const candidate = baseCandidate({
      matchedConstraints: ['region'],
    });
    const annotated = annotateCandidateConstraintEvidence(
      candidate,
      bundle(),
      g,
    );
    expect(annotated.matchedAtomRefs).toBeDefined();
    expect([...(annotated.matchedAtomRefs ?? [])]).toEqual(['sA', 'sB']);
    expect(annotated.unmetAtomRefs).toBeDefined();
    expect(annotated.unmetAtomRefs).toEqual([]);
  });

  it('trivial graph atomRef emission aligns 1:1 with slot order', () => {
    const g = graph('root', [
      { kind: 'group_and', nodeId: 'root', children: ['s1', 's2', 's3'] },
      slot('s1', 'wine_type'),
      slot('s2', 'region'),
      slot('s3', 'price_usd'),
    ]);
    const candidate = baseCandidate({
      matchedConstraints: ['wine_type', 'price_usd'],
    });
    const annotated = annotateCandidateConstraintEvidence(
      candidate,
      bundle(),
      g,
    );
    // matchedAtomRefs order follows graph.nodes slot order.
    expect([...(annotated.matchedAtomRefs ?? [])]).toEqual(['s1', 's3']);
    expect([...(annotated.unmetAtomRefs ?? [])]).toEqual(['s2']);
  });

  it('ordering is deterministic across repeated invocations', () => {
    const g = graph('root', [
      { kind: 'group_and', nodeId: 'root', children: ['s1', 's2', 's3'] },
      slot('s1', 'region'),
      slot('s2', 'wine_type'),
      slot('s3', 'price_usd'),
    ]);
    const candidate = baseCandidate({
      matchedConstraints: ['region', 'wine_type'],
    });
    const a1 = annotateCandidateConstraintEvidence(candidate, bundle(), g);
    const a2 = annotateCandidateConstraintEvidence(candidate, bundle(), g);
    expect(a1.matchedAtomRefs).toEqual(a2.matchedAtomRefs);
    expect(a1.unmetAtomRefs).toEqual(a2.unmetAtomRefs);
  });

  it('absent graph → no atomRef fields set (exactOptionalPropertyTypes)', () => {
    const candidate = baseCandidate({
      matchedConstraints: ['region'],
    });
    const annotated = annotateCandidateConstraintEvidence(
      candidate,
      bundle(),
    );
    // Both atomRef fields must be absent — not set to undefined, which
    // would break exactOptionalPropertyTypes equality on clients.
    expect('matchedAtomRefs' in annotated).toBe(false);
    expect('unmetAtomRefs' in annotated).toBe(false);
  });

  it('subquery / group nodes are not emitted — only slot nodes', () => {
    const g = graph('root', [
      { kind: 'group_and', nodeId: 'root', children: ['sub', 's1'] },
      { kind: 'subquery', nodeId: 'sub', purpose: 'appetiser', targetCardinality: 1 },
      slot('s1', 'wine_type'),
    ]);
    const candidate = baseCandidate({
      matchedConstraints: ['wine_type'],
    });
    const annotated = annotateCandidateConstraintEvidence(
      candidate,
      bundle(),
      g,
    );
    expect([...(annotated.matchedAtomRefs ?? [])]).toEqual(['s1']);
    expect([...(annotated.unmetAtomRefs ?? [])]).toEqual([]);
  });
});

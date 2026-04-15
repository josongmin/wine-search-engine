/**
 * ADR-012 Phase 1b.2: replay stability for LLM-sourced topology.
 *
 * Identical atoms + identical normalizedQuery + identical prompt-version +
 * identical LLM text → identical merged ConstraintGraph bytes (modulo
 * `generatedAt`, which is excluded from the replay hash).
 *
 * Uses a deterministic fake `ChatLlmPort` that echoes a fixed response;
 * no real LLM calls. This test is the smoke gate for replay regressions
 * — when the prompt is bumped to v2, this file's snapshot must drift
 * loudly (break the test) rather than silently returning new bytes.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { ConstraintTopologyPlanner } from '../../src/domain/query/service/constraint-topology-planner.js';
import { mergeTopologyIntoTrivial } from '../../src/domain/query/service/merge-topology-into-trivial.js';
import { buildTrivialGraphFromAtoms } from '../../src/domain/query/service/build-trivial-graph-from-atoms.js';
import { liftBundleToAtoms } from '../../src/domain/shared/types/constraint-atom.js';
import type { ConstraintBundle } from '../../src/domain/shared/types/constraint-bundle.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatLlmPort,
} from '../../src/domain/ai/port/chat-llm.port.js';

const BUNDLE: ConstraintBundle = {
  hard: [
    { attribute: 'wine_type', operator: '=', value: 'red', source_phrase: 'red', confidence: 1 },
    { attribute: 'wine_type', operator: '=', value: 'white', source_phrase: 'white', confidence: 1 },
  ],
  soft: [],
  inferred: [],
};

class DeterministicFakeLlm implements ChatLlmPort {
  constructor(private readonly responseText: string) {}
  complete(_req: ChatCompletionRequest): Promise<ChatCompletionResult> {
    return Promise.resolve({
      text: this.responseText,
      model: 'claude-opus-4-6',
      finishReason: 'stop',
    });
  }
}

/** Remove replay-volatile fields (only `generatedAt`) before hashing. */
function stripVolatile(graph: Record<string, unknown>): Record<string, unknown> {
  const { generatedAt: _dropped, ...rest } = graph;
  return rest;
}

describe('ConstraintGraph replay stability', () => {
  const atoms = liftBundleToAtoms(BUNDLE);
  const trivial = buildTrivialGraphFromAtoms(atoms);
  const slotIds = trivial.nodes.filter((n) => n.kind === 'slot').map((n) => n.nodeId);

  const xorPayload = JSON.stringify({
    origin: 'planner_emitted',
    rootNodeId: 'topology/root-xor',
    nodes: [{ kind: 'group_xor', nodeId: 'topology/root-xor', children: slotIds }],
    edges: [],
  });

  it('identical inputs → identical merged graph bytes (ex. generatedAt)', async () => {
    const planner = new ConstraintTopologyPlanner(new DeterministicFakeLlm(xorPayload));
    const first = await planner.plan({ atoms, normalizedQuery: '레드 또는 화이트', slotIds });
    const second = await planner.plan({ atoms, normalizedQuery: '레드 또는 화이트', slotIds });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (first === null || second === null) return;

    const a = mergeTopologyIntoTrivial(trivial, first);
    const b = mergeTopologyIntoTrivial(trivial, second);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (a === null || b === null) return;

    const stripA = stripVolatile(a as unknown as Record<string, unknown>);
    const stripB = stripVolatile(b as unknown as Record<string, unknown>);
    expect(JSON.stringify(stripA)).toBe(JSON.stringify(stripB));
  });

  it('prompt version is emitted into the merged graph for replay diffing', async () => {
    const planner = new ConstraintTopologyPlanner(new DeterministicFakeLlm(xorPayload));
    const topology = await planner.plan({
      atoms,
      normalizedQuery: '레드 또는 화이트',
      slotIds,
    });
    expect(topology).not.toBeNull();
    if (topology === null) return;
    const merged = mergeTopologyIntoTrivial(trivial, topology);
    expect(merged).not.toBeNull();
    if (merged === null) return;
    expect(merged.promptVersion).toBe('ctg_topology_v1');
    expect(merged.llmModel).toBe('claude-opus-4-6');
  });

  it('different LLM-text payloads produce different topology (regression guard)', async () => {
    const xor1 = JSON.stringify({
      origin: 'planner_emitted',
      rootNodeId: 'topology/root-xor',
      nodes: [{ kind: 'group_xor', nodeId: 'topology/root-xor', children: slotIds }],
      edges: [],
    });
    const or1 = JSON.stringify({
      origin: 'planner_emitted',
      rootNodeId: 'topology/root-or',
      nodes: [{ kind: 'group_or', nodeId: 'topology/root-or', children: slotIds }],
      edges: [],
    });
    const xorPlanner = new ConstraintTopologyPlanner(new DeterministicFakeLlm(xor1));
    const orPlanner = new ConstraintTopologyPlanner(new DeterministicFakeLlm(or1));
    const [xorG, orG] = await Promise.all([
      xorPlanner.plan({ atoms, normalizedQuery: '레드 또는 화이트', slotIds }),
      orPlanner.plan({ atoms, normalizedQuery: '레드 또는 화이트', slotIds }),
    ]);
    expect(xorG).not.toBeNull();
    expect(orG).not.toBeNull();
    if (xorG === null || orG === null) return;
    expect(xorG.rootNodeId).not.toBe(orG.rootNodeId);
    const xorRoot = xorG.nodes.find((n) => n.nodeId === xorG.rootNodeId);
    const orRoot = orG.nodes.find((n) => n.nodeId === orG.rootNodeId);
    expect(xorRoot?.kind).toBe('group_xor');
    expect(orRoot?.kind).toBe('group_or');
  });
});

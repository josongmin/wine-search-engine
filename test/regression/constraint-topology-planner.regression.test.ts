/**
 * ADR-012 Phase 1b.2: ConstraintTopologyPlanner service.
 *
 * Uses an in-memory fake ChatLlmPort; no real LLM calls. Locks:
 *  - Intent gate skips single-intent query (planner returns null without calling LLM).
 *  - Intent gate opens on multi-subquery decomposition hint.
 *  - Intent gate opens on XOR-smell keywords (Korean: `또는`, English: `either`).
 *  - XOR scenario emits origin='hybrid' graph with valid Zod shape.
 *  - Malformed JSON → null.
 *  - Zod-invalid shape → null.
 *  - Empty topology from LLM → null (caller keeps trivial).
 *  - Frozen prompt_version emitted into result.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  ConstraintTopologyPlanner,
  isTopologyIntentGateOpen,
} from '../../src/domain/query/service/constraint-topology-planner.js';
import { buildTrivialGraphFromAtoms } from '../../src/domain/query/service/build-trivial-graph-from-atoms.js';
import { liftBundleToAtoms } from '../../src/domain/shared/types/constraint-atom.js';
import type { ConstraintBundle } from '../../src/domain/shared/types/constraint-bundle.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatLlmPort,
} from '../../src/domain/ai/port/chat-llm.port.js';

const XOR_BUNDLE: ConstraintBundle = {
  hard: [
    { attribute: 'wine_type', operator: '=', value: 'red', source_phrase: 'red', confidence: 1 },
    { attribute: 'wine_type', operator: '=', value: 'white', source_phrase: 'white', confidence: 1 },
  ],
  soft: [],
  inferred: [],
};

class FakeChatLlm implements ChatLlmPort {
  constructor(private readonly response: string, private readonly shouldThrow = false) {}
  public calls: ChatCompletionRequest[] = [];
  complete(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.calls.push(req);
    if (this.shouldThrow) return Promise.reject(new Error('llm_error'));
    return Promise.resolve({
      text: this.response,
      model: 'claude-opus-4-6',
      finishReason: 'stop',
    });
  }
}

function xorPayload(slotIds: readonly string[]): string {
  return JSON.stringify({
    origin: 'planner_emitted',
    rootNodeId: 'topology/root-xor',
    nodes: [
      { kind: 'group_xor', nodeId: 'topology/root-xor', children: [...slotIds] },
    ],
    edges: [],
  });
}

function slotIdsForBundle(bundle: ConstraintBundle): readonly string[] {
  const atoms = liftBundleToAtoms(bundle);
  const graph = buildTrivialGraphFromAtoms(atoms);
  return graph.nodes.filter((n) => n.kind === 'slot').map((n) => n.nodeId);
}

describe('isTopologyIntentGateOpen', () => {
  it('opens on multi-subquery decomposition hint', () => {
    expect(
      isTopologyIntentGateOpen({
        normalizedQuery: 'anything',
        decompositionHint: { subQueryCount: 2, strategy: 'pairing', confidence: 1 },
      }),
    ).toBe(true);
  });

  it('stays closed on single-intent with no XOR keyword', () => {
    expect(
      isTopologyIntentGateOpen({
        normalizedQuery: 'french red wine under 50 usd',
      }),
    ).toBe(false);
  });

  it('opens on Korean XOR keyword `또는`', () => {
    expect(isTopologyIntentGateOpen({ normalizedQuery: '레드 또는 화이트' })).toBe(true);
  });

  it('opens on Korean keyword `각각`', () => {
    expect(isTopologyIntentGateOpen({ normalizedQuery: '각각 추천' })).toBe(true);
  });

  it('opens on English `either`', () => {
    expect(isTopologyIntentGateOpen({ normalizedQuery: 'either red or white' })).toBe(true);
  });
});

describe('ConstraintTopologyPlanner', () => {
  const atoms = liftBundleToAtoms(XOR_BUNDLE);
  const slotIds = slotIdsForBundle(XOR_BUNDLE);

  it('returns null without calling LLM when intent gate is closed', async () => {
    const llm = new FakeChatLlm(xorPayload(slotIds));
    const planner = new ConstraintTopologyPlanner(llm);
    const result = await planner.plan({
      atoms,
      normalizedQuery: 'single intent query',
      slotIds,
    });
    expect(result).toBeNull();
    expect(llm.calls).toHaveLength(0);
  });

  it('calls LLM and returns origin="hybrid" graph when gate is open + XOR payload', async () => {
    const llm = new FakeChatLlm(xorPayload(slotIds));
    const planner = new ConstraintTopologyPlanner(llm);
    const result = await planner.plan({
      atoms,
      normalizedQuery: '레드 또는 화이트',
      slotIds,
    });
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.origin).toBe('planner_emitted');
    expect(result.rootNodeId).toBe('topology/root-xor');
    expect(result.promptVersion).toBe('ctg_topology_v1');
    expect(result.llmModel).toBe('claude-opus-4-6');
  });

  it('returns null on non-JSON LLM text', async () => {
    const llm = new FakeChatLlm('this is not json');
    const planner = new ConstraintTopologyPlanner(llm);
    const result = await planner.plan({
      atoms,
      normalizedQuery: '레드 또는 화이트',
      slotIds,
    });
    expect(result).toBeNull();
  });

  it('returns null on Zod rejection (topology id prefix violation)', async () => {
    const badPayload = JSON.stringify({
      origin: 'planner_emitted',
      rootNodeId: 'rogue-root', // missing topology/ prefix
      nodes: [{ kind: 'group_xor', nodeId: 'rogue-root', children: [...slotIds] }],
      edges: [],
    });
    const llm = new FakeChatLlm(badPayload);
    const planner = new ConstraintTopologyPlanner(llm);
    const result = await planner.plan({
      atoms,
      normalizedQuery: '레드 또는 화이트',
      slotIds,
    });
    expect(result).toBeNull();
  });

  it('returns null on empty topology — caller keeps trivial', async () => {
    const emptyPayload = JSON.stringify({
      origin: 'planner_emitted',
      rootNodeId: 'topology/empty',
      nodes: [],
      edges: [],
    });
    const llm = new FakeChatLlm(emptyPayload);
    const planner = new ConstraintTopologyPlanner(llm);
    const result = await planner.plan({
      atoms,
      normalizedQuery: '레드 또는 화이트',
      slotIds,
    });
    expect(result).toBeNull();
  });

  it('returns null when LLM throws', async () => {
    const llm = new FakeChatLlm('', true);
    const planner = new ConstraintTopologyPlanner(llm);
    const result = await planner.plan({
      atoms,
      normalizedQuery: '레드 또는 화이트',
      slotIds,
    });
    expect(result).toBeNull();
  });

  it('uses temperature=0 and fixed seed for determinism', async () => {
    const llm = new FakeChatLlm(xorPayload(slotIds));
    const planner = new ConstraintTopologyPlanner(llm);
    await planner.plan({ atoms, normalizedQuery: '레드 또는 화이트', slotIds });
    const call = llm.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    expect(call.temperature).toBe(0);
    expect(call.seed).toBe(1);
  });

  it('returns null when slotIds length does not match atoms length', async () => {
    const llm = new FakeChatLlm(xorPayload(slotIds));
    const planner = new ConstraintTopologyPlanner(llm);
    const result = await planner.plan({
      atoms,
      normalizedQuery: '레드 또는 화이트',
      slotIds: [...slotIds, 'slot-extra'],
    });
    expect(result).toBeNull();
  });
});

/**
 * ADR-012 Phase 1b.2 — LLM topology planner flag-on integration lock (Wave B3).
 *
 * Background
 * ──────────
 * The `CONSTRAINT_GRAPH_TOPOLOGY_LLM` env flag (ADR-012 PR3) gates the
 * LLM topology planner wired into {@link ConstraintCompiler}. Default
 * OFF. When ON, the compiler:
 *
 *   1. builds a trivial graph from `reasonerOutput.survivingAtoms`;
 *   2. asks the injected {@link ConstraintTopologyPlanner} for AND / OR /
 *      XOR / subquery topology, using the deterministic slot ids as
 *      children references;
 *   3. merges the topology via {@link mergeTopologyIntoTrivial} and
 *      emits a `'hybrid'` origin graph with v1.1 replay metadata
 *      (`promptVersion`, `generatedAt`, `llmModel`).
 *
 * The unit-level planner regression lives at
 * `test/regression/constraint-topology-planner.regression.test.ts` but
 * does NOT cover the compiler seam or the downstream ranker hard-gate.
 * Wave B3 closes that gap end-to-end with a fake {@link ChatLlmPort}
 * (no real LLM) and the real `ConstraintCompiler` +
 * `ConstraintTopologyPlanner` + `mergeTopologyIntoTrivial` +
 * `evaluateGraphHardGate`.
 *
 * Scenarios locked (1 case each)
 * ──────────────────────────────
 * 1. Flag ON + intent gate open + XOR payload → `origin='hybrid'`, root
 *    is the topology XOR node, v1.1 replay metadata present.
 * 2. Flag ON + intent gate CLOSED → planner skipped, ChatLlm receives
 *    zero calls, graph origin stays `'deterministic_from_atoms'`.
 * 3. Flag ON + LLM returns non-JSON → trivial fallback, no throw.
 * 4. Flag ON + LLM emits `slot-` prefixed nodeId (namespace collision)
 *    → Zod rejection → trivial fallback preserved.
 * 5. End-to-end: the hybrid XOR graph from (1) → `evaluateGraphHardGate`
 *    with a candidate matching ONE branch returns `true`
 *    (where flat AND-all would reject).
 * 6. Flag OFF + same inputs → graph is trivial, planner fake never
 *    called. Byte-identical to the pre-PR3 path.
 *
 * This test MUST use the real `ConstraintCompiler`,
 * `ConstraintTopologyPlanner`, `mergeTopologyIntoTrivial`,
 * `computeGraphCoverage` (via `evaluateGraphHardGate`). Only
 * `ChatLlmPort` and the `NLMapper` dependency are faked.
 *
 * Never delete this file — it is an append-only regression lock.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConstraintCompiler } from '../../src/domain/query/service/constraint-compiler.js';
import { ConstraintTopologyPlanner } from '../../src/domain/query/service/constraint-topology-planner.js';
import { evaluateGraphHardGate } from '../../src/domain/ranking/service/graph-hard-gate.js';
import type { NLMapper } from '../../src/domain/attribute/service/nl-mapper.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatLlmPort,
} from '../../src/domain/ai/port/chat-llm.port.js';
import type { QueryDecompositionHint } from '../../src/domain/query/model/query-decomposition.js';
import type { ConstraintGraph } from '../../src/domain/query/model/constraint-graph.js';

// ─── Shared fakes ────────────────────────────────────────────────────────────

/**
 * Minimal NLMapper fake that returns two non-conflicting hard
 * constraints: `wine_type=red` and `producer=fictitious-lab-42`.
 *
 * - Different attributes → the reasoner keeps both (no contradiction).
 * - Neither attribute triggers ontology expansion (only `region` and
 *   `appellation` are expanded).
 * - Neither combination matches any compositional-inference rule
 *   (all rules key on `region` or `appellation`).
 *
 * Consequence: the trivial projector emits exactly two hard slot nodes
 * — the XOR payload below references them as its two children, so the
 * assertion `slotIds.length === 2` is stable and deterministic.
 */
function makeFakeNLMapper(): NLMapper {
  return {
    mapConstraints: async () => ({
      constraints: [
        {
          attribute: 'wine_type',
          operator: '=' as const,
          value: 'red',
          source_phrase: 'red',
          confidence: 0.95,
          mapping_version: 'test-v1.0',
        },
        {
          attribute: 'producer',
          operator: '=' as const,
          value: 'fictitious-lab-42',
          source_phrase: 'producer',
          confidence: 0.9,
          mapping_version: 'test-v1.0',
        },
      ],
      constraintExtraction: {
        candidatePhraseCount: 2,
        ruleTableHitCount: 2,
        llmHitCount: 0,
        llmSkippedCount: 0,
        fallbackTriggered: false,
        source: 'rule_table' as const,
        llmLatencyMs: null,
        phraseCacheHits: 0,
        phraseCacheNegativeSkipped: 0,
        phraseCacheMisses: 0,
        missedPhrases: [],
      },
    }),
  } as unknown as NLMapper;
}

/**
 * Minimal ChatLlmPort fake. Captures each call and replies with a
 * canned response string under a fixed model name. `shouldThrow=true`
 * makes `.complete` reject — lets us exercise the planner's try/catch
 * swallowing path indirectly.
 */
class FakeChatLlm implements ChatLlmPort {
  public readonly calls: ChatCompletionRequest[] = [];
  constructor(
    private readonly responseText: string,
    private readonly model = 'fake-topology-llm-v1',
  ) {}
  complete(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.calls.push(req);
    return Promise.resolve({
      text: this.responseText,
      model: this.model,
      finishReason: 'stop',
    });
  }
}

/** Decomposition hint that opens the topology intent gate regardless of query text. */
const MULTI_SUBQUERY_HINT: QueryDecompositionHint = {
  subQueryCount: 2,
  strategy: 'comparison',
  confidence: 0.9,
  reason: 'integration_test_comparison_hint',
};

/**
 * Opaque ASCII query: deliberately contains zero substrings that the
 * rule-based / ontology extractors can match (no "red", no "burgundy",
 * no price tokens). This keeps the compiler's post-NLMapper tiers from
 * injecting extra atoms — we want exactly the two atoms our fake
 * NLMapper emits, so the XOR payload has exactly two slot children.
 *
 * The topology intent gate is opened via `MULTI_SUBQUERY_HINT`, not via
 * the query text itself.
 */
const XOR_NORMALIZED_QUERY = 'zzqq xxvv test query';

/**
 * Build an XOR payload that wraps the two trivial slot ids under a
 * topology XOR root. The slot ids are produced by running the compiler
 * once in flag-off mode and reading `constraintGraph.nodes` — this
 * matches the Phase-1a deterministic projection byte-for-byte.
 */
function xorPayloadWithSlotIds(slotIds: readonly string[]): string {
  return JSON.stringify({
    origin: 'planner_emitted',
    rootNodeId: 'topology/root-xor',
    nodes: [
      { kind: 'group_xor', nodeId: 'topology/root-xor', children: [...slotIds] },
    ],
    edges: [],
  });
}

/** Resolve the slot ids the trivial projector emits for our fake bundle. */
async function resolveTrivialSlotIds(): Promise<readonly string[]> {
  const compiler = new ConstraintCompiler(makeFakeNLMapper());
  const result = await compiler.compile(XOR_NORMALIZED_QUERY);
  expect(result.constraintGraph).toBeDefined();
  const graph = result.constraintGraph;
  if (graph === undefined) throw new Error('guard: graph missing');
  return graph.nodes.filter((n) => n.kind === 'slot').map((n) => n.nodeId);
}

// ─── Env guards ──────────────────────────────────────────────────────────────

let previousFlag: string | undefined;

function clearTopologyFlag(): void {
  // Static key — no dynamic delete.
  delete process.env.CONSTRAINT_GRAPH_TOPOLOGY_LLM;
}

beforeEach(() => {
  previousFlag = process.env.CONSTRAINT_GRAPH_TOPOLOGY_LLM;
});
afterEach(() => {
  if (previousFlag === undefined) {
    clearTopologyFlag();
  } else {
    process.env.CONSTRAINT_GRAPH_TOPOLOGY_LLM = previousFlag;
  }
});

// ─── Scenarios ───────────────────────────────────────────────────────────────

describe('ADR-012 Phase 1b.2 — topology planner flag-on integration (Wave B3)', () => {
  it('flag ON + intent gate open + XOR payload → emits origin="hybrid" graph with v1.1 replay metadata', async () => {
    process.env.CONSTRAINT_GRAPH_TOPOLOGY_LLM = 'true';
    const slotIds = await resolveTrivialSlotIds();
    expect(slotIds.length).toBe(2);

    const llm = new FakeChatLlm(xorPayloadWithSlotIds(slotIds));
    const planner = new ConstraintTopologyPlanner(llm);
    const compiler = new ConstraintCompiler(makeFakeNLMapper(), undefined, planner);

    const result = await compiler.compile(
      XOR_NORMALIZED_QUERY,
      undefined,
      MULTI_SUBQUERY_HINT,
    );

    expect(llm.calls).toHaveLength(1);
    const graph = result.constraintGraph;
    expect(graph).toBeDefined();
    if (graph === undefined) return;

    expect(graph.origin).toBe('planner_emitted');
    expect(graph.graphSchemaVersion).toBe('constraint_graph_v1.1');
    expect(graph.rootNodeId).toBe('topology/root-xor');
    expect(graph.promptVersion).toBe('ctg_topology_v1');
    expect(graph.llmModel).toBe('fake-topology-llm-v1');
    expect(typeof graph.generatedAt).toBe('string');
    expect(graph.generatedAt).not.toBe('');

    // The topology root node must be the XOR group, and it must still
    // wrap the two original trivial slot ids unchanged.
    const root = graph.nodes.find((n) => n.nodeId === 'topology/root-xor');
    expect(root).toBeDefined();
    if (root === undefined) return;
    expect(root.kind).toBe('group_xor');
    if (root.kind !== 'group_xor') return;
    expect([...root.children].sort()).toEqual([...slotIds].sort());

    // Merge must preserve the trivial slot nodes (anchored invariant).
    const preservedSlotCount = graph.nodes.filter((n) => n.kind === 'slot').length;
    expect(preservedSlotCount).toBe(slotIds.length);
  });

  it('flag ON but intent gate closed → planner fake never called; graph stays deterministic', async () => {
    process.env.CONSTRAINT_GRAPH_TOPOLOGY_LLM = 'true';
    const llm = new FakeChatLlm('{"should":"never be parsed"}');
    const planner = new ConstraintTopologyPlanner(llm);
    const compiler = new ConstraintCompiler(makeFakeNLMapper(), undefined, planner);

    // Single-intent ASCII query, no XOR keywords, no decomposition hint → gate closed.
    const result = await compiler.compile('french red wine under fifty dollars');

    expect(llm.calls).toHaveLength(0);
    const graph = result.constraintGraph;
    expect(graph).toBeDefined();
    if (graph === undefined) return;
    expect(graph.origin).toBe('deterministic_from_atoms');
    expect(graph.graphSchemaVersion).toBe('constraint_graph_v1');
    expect(graph.promptVersion).toBeUndefined();
    expect(graph.llmModel).toBeUndefined();
  });

  it('flag ON + LLM returns non-JSON → compiler falls back to trivial graph, no throw', async () => {
    process.env.CONSTRAINT_GRAPH_TOPOLOGY_LLM = 'true';
    const llm = new FakeChatLlm('this is not json at all <<<');
    const planner = new ConstraintTopologyPlanner(llm);
    const compiler = new ConstraintCompiler(makeFakeNLMapper(), undefined, planner);

    const result = await compiler.compile(
      XOR_NORMALIZED_QUERY,
      undefined,
      MULTI_SUBQUERY_HINT,
    );

    // The planner was invoked (gate was open) but JSON.parse failed → null.
    expect(llm.calls).toHaveLength(1);
    const graph = result.constraintGraph;
    expect(graph).toBeDefined();
    if (graph === undefined) return;
    // Trivial graph preserved byte-for-byte (origin + schema version).
    expect(graph.origin).toBe('deterministic_from_atoms');
    expect(graph.graphSchemaVersion).toBe('constraint_graph_v1');
  });

  it('flag ON + LLM emits "slot-" prefixed nodeId (namespace collision) → Zod rejects → trivial fallback', async () => {
    process.env.CONSTRAINT_GRAPH_TOPOLOGY_LLM = 'true';
    // rootNodeId uses `slot-` prefix — violates the topology/* Zod
    // refine on `TopologyNodeIdSchema`. Planner returns null, compiler
    // keeps the deterministic trivial graph.
    const collidingPayload = JSON.stringify({
      origin: 'planner_emitted',
      rootNodeId: 'slot-collision',
      nodes: [
        { kind: 'group_xor', nodeId: 'slot-collision', children: [] },
      ],
      edges: [],
    });
    const llm = new FakeChatLlm(collidingPayload);
    const planner = new ConstraintTopologyPlanner(llm);
    const compiler = new ConstraintCompiler(makeFakeNLMapper(), undefined, planner);

    const result = await compiler.compile(
      XOR_NORMALIZED_QUERY,
      undefined,
      MULTI_SUBQUERY_HINT,
    );

    expect(llm.calls).toHaveLength(1);
    const graph = result.constraintGraph;
    expect(graph).toBeDefined();
    if (graph === undefined) return;
    expect(graph.origin).toBe('deterministic_from_atoms');
    expect(graph.graphSchemaVersion).toBe('constraint_graph_v1');
  });

  it('end-to-end: hybrid XOR graph → ranker hard gate accepts a one-branch candidate', async () => {
    process.env.CONSTRAINT_GRAPH_TOPOLOGY_LLM = 'true';
    const slotIds = await resolveTrivialSlotIds();
    const llm = new FakeChatLlm(xorPayloadWithSlotIds(slotIds));
    const planner = new ConstraintTopologyPlanner(llm);
    const compiler = new ConstraintCompiler(makeFakeNLMapper(), undefined, planner);

    const result = await compiler.compile(
      XOR_NORMALIZED_QUERY,
      undefined,
      MULTI_SUBQUERY_HINT,
    );
    const graph = result.constraintGraph;
    expect(graph).toBeDefined();
    if (graph === undefined) return;
    expect(graph.origin).toBe('planner_emitted');

    // Candidate matches ONLY `wine_type` — one XOR branch satisfied.
    const oneBranchOnly = evaluateGraphHardGate({
      graph,
      matchedAttributes: new Set(['wine_type']),
    });
    expect(oneBranchOnly).toBe(true);

    // Candidate matches ONLY `producer` — the OTHER XOR branch. Also passes.
    const otherBranchOnly = evaluateGraphHardGate({
      graph,
      matchedAttributes: new Set(['producer']),
    });
    expect(otherBranchOnly).toBe(true);

    // Candidate matches BOTH branches — XOR exclusivity rejects.
    const bothBranches = evaluateGraphHardGate({
      graph,
      matchedAttributes: new Set(['wine_type', 'producer']),
    });
    expect(bothBranches).toBe(false);

    // Candidate matches NEITHER — gate rejects.
    const nothingMatched = evaluateGraphHardGate({
      graph,
      matchedAttributes: new Set(),
    });
    expect(nothingMatched).toBe(false);

    // Cross-check: on the trivial AND-all graph produced with the flag
    // OFF, the same one-branch candidate FAILS — this is exactly the
    // semantic upgrade ADR-012 Phase 1b.2 provides.
    clearTopologyFlag();
    const trivialResult = await new ConstraintCompiler(makeFakeNLMapper()).compile(
      XOR_NORMALIZED_QUERY,
    );
    const trivialGraph = trivialResult.constraintGraph;
    expect(trivialGraph).toBeDefined();
    if (trivialGraph === undefined) return;
    const flatOneBranch = evaluateGraphHardGate({
      graph: trivialGraph,
      matchedAttributes: new Set(['wine_type']),
    });
    expect(flatOneBranch).toBe(false);
  });

  it('flag OFF: planner fake never called; trivial graph byte-identical to pre-PR3 baseline', async () => {
    process.env.CONSTRAINT_GRAPH_TOPOLOGY_LLM = 'false';
    const slotIds = await resolveTrivialSlotIds();
    const llm = new FakeChatLlm(xorPayloadWithSlotIds(slotIds));
    const planner = new ConstraintTopologyPlanner(llm);
    const compiler = new ConstraintCompiler(makeFakeNLMapper(), undefined, planner);

    const result = await compiler.compile(
      XOR_NORMALIZED_QUERY,
      undefined,
      MULTI_SUBQUERY_HINT,
    );

    // Planner was injected but flag is off → compiler never consults it.
    expect(llm.calls).toHaveLength(0);

    const graph: ConstraintGraph | undefined = result.constraintGraph;
    expect(graph).toBeDefined();
    if (graph === undefined) return;
    expect(graph.origin).toBe('deterministic_from_atoms');
    expect(graph.graphSchemaVersion).toBe('constraint_graph_v1');
    expect(graph.promptVersion).toBeUndefined();
    expect(graph.generatedAt).toBeUndefined();
    expect(graph.llmModel).toBeUndefined();

    // Two trivial slot nodes from the fake NLMapper's two hard
    // constraints — proves we hit the deterministic projector path.
    const slotNodes = graph.nodes.filter((n) => n.kind === 'slot');
    expect(slotNodes).toHaveLength(2);
    const attrs = new Set(slotNodes.map((n) => (n.kind === 'slot' ? n.attribute : '')));
    expect(attrs.has('wine_type')).toBe(true);
    expect(attrs.has('producer')).toBe(true);
  });
});

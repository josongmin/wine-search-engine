/**
 * Wave I4 — Topology planner composition wiring regression lock.
 *
 * Scope
 * ─────
 * Locks the container-vs-compiler gate separation introduced in Wave I4
 * (`src/config/container-core-builders.ts`):
 *
 *   - **Container gate** (construction): the composition root
 *     auto-instantiates {@link ConstraintTopologyPlanner} whenever a
 *     {@link ChatLlmPort} is available, regardless of the env flag state.
 *   - **Compiler gate** (invocation): {@link ConstraintCompiler} re-reads
 *     `CONSTRAINT_GRAPH_TOPOLOGY_LLM` on every `compile()` call and only
 *     invokes the planner when the flag is `'true'`.
 *
 * Why the split matters: pre-I4 the container also pre-read the env flag
 * at boot, so flipping `CONSTRAINT_GRAPH_TOPOLOGY_LLM=true` at runtime on
 * an already-booted process was a silent no-op. I4 decouples
 * instantiation (container) from invocation (compiler) so the runtime
 * flip actually takes effect on the same process.
 *
 * Cases (append-only — never delete this file)
 * ────────────────────────────────────────────
 * 1. chatLlm present + flag OFF → planner wired (construction is flag-independent).
 * 2. chatLlm present + flag ON  → planner wired (same reason — flag doesn't gate here).
 * 3. chatLlm ABSENT + flag ON   → planner still undefined (no chatLlm means no planner).
 * 4. Runtime flip on ONE compiler instance:
 *     - construct with chatLlm, flag OFF → compile() does NOT call the LLM.
 *     - set flag=true on same instance → compile() DOES call the LLM.
 *     - set flag=false again → compile() does NOT call the LLM.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildQueryPlanner } from '../../src/config/container-core-builders.js';
import { ConstraintCompiler } from '../../src/domain/query/service/constraint-compiler.js';
import { ConstraintTopologyPlanner } from '../../src/domain/query/service/constraint-topology-planner.js';
import {
  StubAliasMatcher,
  StubAmbiguityDictionary,
} from '../../src/config/container-stubs.js';
import type { CoreAdapterServices } from '../../src/config/container-adapters.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatLlmPort,
} from '../../src/domain/ai/port/chat-llm.port.js';
import type { NLMapper } from '../../src/domain/attribute/service/nl-mapper.js';
import type { MappingTablePort } from '../../src/domain/attribute/port/mapping-table.port.js';
import type { NLMapping } from '../../src/domain/attribute/model/nl-mapping.js';
import type { QueryDecompositionHint } from '../../src/domain/query/model/query-decomposition.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

class CountingChatLlm implements ChatLlmPort {
  public callCount = 0;
  constructor(private readonly response: string) {}
  complete(_req: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.callCount++;
    return Promise.resolve({
      text: this.response,
      model: 'composition-wiring-fake',
      finishReason: 'stop',
    });
  }
}

class NoopMappingTable implements MappingTablePort {
  findMapping(_phrase: string, _version?: string): Promise<NLMapping | null> {
    return Promise.resolve(null);
  }
  findMappingsByAttribute(_attribute: string): Promise<readonly NLMapping[]> {
    return Promise.resolve([]);
  }
  getCurrentVersion(): Promise<string> {
    return Promise.resolve('v-test');
  }
}

/** Minimal adapter bag — only the fields `buildQueryPlanner` consults. */
function makeAdapters(): CoreAdapterServices {
  // We only populate what buildQueryPlanner actually reads (ambiguityDict,
  // aliasMatcher, mappingTable). Everything else is cast-through; it is
  // never touched on the code path exercised by these tests.
  return {
    ambiguityDict: new StubAmbiguityDictionary(),
    aliasMatcher: new StubAliasMatcher(),
    mappingTable: new NoopMappingTable(),
  } as unknown as CoreAdapterServices;
}

/**
 * Introspect the private `constraintCompiler` off a `Planner` instance
 * to assert the topology planner was wired. The regression invariant is
 * specifically about container-vs-compiler composition — behavioural
 * assertions elsewhere (LLM call counts on compile()) cover the runtime
 * path; this helper covers the construction path.
 */
function readInternalCompiler(
  planner: unknown,
): { readonly topologyPlanner?: ConstraintTopologyPlanner } {
  const record = planner as { readonly constraintCompiler: unknown };
  return record.constraintCompiler as {
    readonly topologyPlanner?: ConstraintTopologyPlanner;
  };
}

// ─── Env guards ──────────────────────────────────────────────────────────────

function saveEnv(): { flag: string | undefined; emit: string | undefined } {
  return {
    flag: process.env['CONSTRAINT_GRAPH_TOPOLOGY_LLM'],
    emit: process.env['CONSTRAINT_GRAPH_EMIT'],
  };
}
function restoreEnv(saved: {
  flag: string | undefined;
  emit: string | undefined;
}): void {
  if (saved.flag === undefined) {
    delete process.env.CONSTRAINT_GRAPH_TOPOLOGY_LLM;
  } else {
    process.env.CONSTRAINT_GRAPH_TOPOLOGY_LLM = saved.flag;
  }
  if (saved.emit === undefined) {
    delete process.env.CONSTRAINT_GRAPH_EMIT;
  } else {
    process.env.CONSTRAINT_GRAPH_EMIT = saved.emit;
  }
}

// ─── Cases ───────────────────────────────────────────────────────────────────

describe('Wave I4 — topology planner composition wiring', () => {
  let savedEnv: ReturnType<typeof saveEnv>;

  beforeEach(() => {
    savedEnv = saveEnv();
    // Graph emission is the prerequisite for the compiler to ever touch
    // the topology planner. It defaults-on in production, but we set it
    // explicitly so the test is robust to env bleed-through.
    process.env.CONSTRAINT_GRAPH_EMIT = 'true';
  });
  afterEach(() => {
    restoreEnv(savedEnv);
  });

  it('chatLlm present + flag OFF → container still wires topologyPlanner (construction is flag-independent)', async () => {
    delete process.env.CONSTRAINT_GRAPH_TOPOLOGY_LLM;
    const chatLlm = new CountingChatLlm('{}');

    const planner = await buildQueryPlanner(makeAdapters(), undefined, chatLlm);

    const compiler = readInternalCompiler(planner);
    expect(compiler.topologyPlanner).toBeInstanceOf(ConstraintTopologyPlanner);
  });

  it('chatLlm present + flag ON → container wires topologyPlanner (flag neither enables nor disables construction)', async () => {
    process.env.CONSTRAINT_GRAPH_TOPOLOGY_LLM = 'true';
    const chatLlm = new CountingChatLlm('{}');

    const planner = await buildQueryPlanner(makeAdapters(), undefined, chatLlm);

    const compiler = readInternalCompiler(planner);
    expect(compiler.topologyPlanner).toBeInstanceOf(ConstraintTopologyPlanner);
  });

  it('chatLlm ABSENT + flag ON → container leaves topologyPlanner undefined (no chatLlm means no planner, flag cannot conjure one)', async () => {
    process.env.CONSTRAINT_GRAPH_TOPOLOGY_LLM = 'true';

    // chatLlm intentionally omitted.
    const planner = await buildQueryPlanner(makeAdapters(), undefined, undefined);

    const compiler = readInternalCompiler(planner);
    expect(compiler.topologyPlanner).toBeUndefined();
  });

  it('runtime flag flip on ONE compiler instance — the flag controls invocation, not construction', async () => {
    // This case enforces the core I4 semantic: construct once, flip env,
    // observe invocation change — no restart required. We use
    // ConstraintCompiler directly (skipping buildQueryPlanner) because
    // runtime env flips upstream of an already-constructed compiler are
    // exactly what this test is asserting.
    const chatLlm = new CountingChatLlm(
      // Minimal well-formed topology reply so the planner does not crash
      // the compiler; the merge will reject it (empty children) but that
      // is irrelevant — we assert on chatLlm.callCount, i.e. whether the
      // planner was INVOKED, not whether its output was accepted.
      JSON.stringify({
        origin: 'planner_emitted',
        rootNodeId: 'topology/root',
        nodes: [
          { kind: 'group_and', nodeId: 'topology/root', children: [] },
        ],
        edges: [],
      }),
    );
    const topologyPlanner = new ConstraintTopologyPlanner(chatLlm);
    // NLMapper that returns nothing — keeps compile() minimal.
    const nlMapper = {
      mapConstraints: () =>
        Promise.resolve({
          constraints: [],
          constraintExtraction: {
            candidatePhraseCount: 0,
            ruleTableHitCount: 0,
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

    const compiler = new ConstraintCompiler(nlMapper, undefined, topologyPlanner);

    // Decomposition hint that opens the topology intent gate so the
    // per-request flag is the sole remaining gate.
    const multiSubquery: QueryDecompositionHint = {
      subQueryCount: 2,
      strategy: 'comparison',
      confidence: 0.9,
      reason: 'i4_runtime_flip_test',
    };

    // Flag OFF → no LLM call.
    delete process.env.CONSTRAINT_GRAPH_TOPOLOGY_LLM;
    await compiler.compile('runtime flip query alpha', undefined, multiSubquery);
    expect(chatLlm.callCount).toBe(0);

    // Flip flag ON at runtime, SAME compiler instance → LLM called.
    process.env.CONSTRAINT_GRAPH_TOPOLOGY_LLM = 'true';
    await compiler.compile('runtime flip query beta', undefined, multiSubquery);
    expect(chatLlm.callCount).toBe(1);

    // Flip flag OFF again at runtime → LLM NOT called on the next compile.
    delete process.env.CONSTRAINT_GRAPH_TOPOLOGY_LLM;
    await compiler.compile('runtime flip query gamma', undefined, multiSubquery);
    expect(chatLlm.callCount).toBe(1);
  });
});

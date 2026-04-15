/**
 * Wave F1 — ConstraintCompiler topology priority chain regression lock.
 *
 * Priority chain: LLM (if enabled + planner injected) > deterministic (if enabled) > trivial.
 *
 * Tests:
 *  1. Both flags OFF → origin is 'deterministic_from_atoms' (trivial).
 *  2. Deterministic ON (default), no LLM planner, XOR query →
 *     origin is 'planner_emitted' (detector hit).
 *  3. Deterministic ON (default), no LLM planner, non-XOR query →
 *     origin is 'deterministic_from_atoms' (no detector hit → trivial).
 *  4. Both LLM ON + deterministic ON, XOR query, LLM returns valid XOR
 *     topology → origin is 'hybrid' (LLM wins).
 *  5. Deterministic flag explicitly OFF → detector is bypassed, trivial only.
 *
 * Append-only test: never delete this file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConstraintCompiler } from '../../src/domain/query/service/constraint-compiler.js';
import { ConstraintTopologyPlanner } from '../../src/domain/query/service/constraint-topology-planner.js';
import { NLMapper } from '../../src/domain/attribute/service/nl-mapper.js';
import type { MappingTablePort } from '../../src/domain/attribute/port/mapping-table.port.js';
import type { NLMapping } from '../../src/domain/attribute/model/nl-mapping.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatLlmPort,
} from '../../src/domain/ai/port/chat-llm.port.js';

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

function makeNlMapper(): NLMapper {
  return new NLMapper(new NoopMappingTable());
}

class FakeChatLlm implements ChatLlmPort {
  constructor(private readonly response: string) {}
  complete(_req: ChatCompletionRequest): Promise<ChatCompletionResult> {
    return Promise.resolve({
      text: this.response,
      model: 'claude-opus-4-6',
      finishReason: 'stop',
    });
  }
}

// Multi-course pairing query — the detector's subquery branch fires on
// course-keyword presence alone, regardless of atom count. XOR queries
// require ≥2 atoms of the same attribute which the compiler's
// rule-based wine_type extractor intentionally de-dups, so we use the
// multi-course channel to exercise the priority chain end-to-end.
const PAIRING_QUERY = '메인에 고기 디저트에 초콜릿 어울리는 와인';
const PLAIN_QUERY = '좋은 레드 와인 하나 추천해줘';

function saveEnv() {
  return {
    emit: process.env['CONSTRAINT_GRAPH_EMIT'],
    llm: process.env['CONSTRAINT_GRAPH_TOPOLOGY_LLM'],
    det: process.env['CONSTRAINT_GRAPH_TOPOLOGY_DETERMINISTIC'],
  };
}

function restoreEnv(saved: { emit?: string; llm?: string; det?: string }) {
  const set = (k: 'CONSTRAINT_GRAPH_EMIT' | 'CONSTRAINT_GRAPH_TOPOLOGY_LLM' | 'CONSTRAINT_GRAPH_TOPOLOGY_DETERMINISTIC', v: string | undefined) => {
    if (v === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- env keys are a closed literal union above; dynamic-delete lint false-positive
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  };
  set('CONSTRAINT_GRAPH_EMIT', saved.emit);
  set('CONSTRAINT_GRAPH_TOPOLOGY_LLM', saved.llm);
  set('CONSTRAINT_GRAPH_TOPOLOGY_DETERMINISTIC', saved.det);
}

describe('ConstraintCompiler topology priority chain (LLM > deterministic > trivial)', () => {
  let saved: ReturnType<typeof saveEnv>;

  beforeEach(() => {
    saved = saveEnv();
  });
  afterEach(() => {
    restoreEnv(saved);
  });

  it('both flags OFF → trivial graph (deterministic_from_atoms)', async () => {
    delete process.env['CONSTRAINT_GRAPH_TOPOLOGY_LLM'];
    process.env['CONSTRAINT_GRAPH_TOPOLOGY_DETERMINISTIC'] = 'false';
    const compiler = new ConstraintCompiler(makeNlMapper());
    const result = await compiler.compile(PAIRING_QUERY);
    expect(result.constraintGraph).toBeDefined();
    expect(result.constraintGraph?.origin).toBe('deterministic_from_atoms');
  });

  it('deterministic ON (default unset) + XOR query → planner_emitted', async () => {
    delete process.env['CONSTRAINT_GRAPH_TOPOLOGY_LLM'];
    delete process.env['CONSTRAINT_GRAPH_TOPOLOGY_DETERMINISTIC'];
    const compiler = new ConstraintCompiler(makeNlMapper());
    const result = await compiler.compile(PAIRING_QUERY);
    expect(result.constraintGraph).toBeDefined();
    expect(result.constraintGraph?.origin).toBe('planner_emitted');
  });

  it('deterministic ON + non-XOR query → deterministic_from_atoms (no detector hit)', async () => {
    delete process.env['CONSTRAINT_GRAPH_TOPOLOGY_LLM'];
    delete process.env['CONSTRAINT_GRAPH_TOPOLOGY_DETERMINISTIC'];
    const compiler = new ConstraintCompiler(makeNlMapper());
    const result = await compiler.compile(PLAIN_QUERY);
    expect(result.constraintGraph).toBeDefined();
    expect(result.constraintGraph?.origin).toBe('deterministic_from_atoms');
  });

  it('LLM planner wins over deterministic when both active and LLM intent gate opens', async () => {
    process.env['CONSTRAINT_GRAPH_TOPOLOGY_LLM'] = 'true';
    delete process.env['CONSTRAINT_GRAPH_TOPOLOGY_DETERMINISTIC'];
    // Query opens the LLM intent gate (contains `또는`). The LLM
    // returns a minimal topology tagged `'hybrid'`; merge preserves that
    // origin verbatim. (Wave F1 contract: merge does NOT re-label origin
    // — deterministic outputs stay `'planner_emitted'`, LLM outputs emit
    // their own `'planner_emitted' | 'hybrid'` choice. Here we pick
    // `'hybrid'` to make the "LLM wins" distinction visible.)
    const llmResponse = JSON.stringify({
      origin: 'hybrid',
      rootNodeId: 'topology/root',
      nodes: [
        { kind: 'group_and', nodeId: 'topology/root', children: [] },
      ],
      edges: [],
    });
    const planner = new ConstraintTopologyPlanner(new FakeChatLlm(llmResponse));
    const compiler = new ConstraintCompiler(makeNlMapper(), undefined, planner);
    const result = await compiler.compile('레드 또는 화이트 와인 추천');
    expect(result.constraintGraph).toBeDefined();
    expect(result.constraintGraph?.origin).toBe('hybrid');
  });

  it('deterministic flag OFF explicitly → detector skipped, trivial kept', async () => {
    delete process.env['CONSTRAINT_GRAPH_TOPOLOGY_LLM'];
    process.env['CONSTRAINT_GRAPH_TOPOLOGY_DETERMINISTIC'] = 'false';
    const compiler = new ConstraintCompiler(makeNlMapper());
    const result = await compiler.compile(PAIRING_QUERY);
    expect(result.constraintGraph).toBeDefined();
    expect(result.constraintGraph?.origin).toBe('deterministic_from_atoms');
  });
});

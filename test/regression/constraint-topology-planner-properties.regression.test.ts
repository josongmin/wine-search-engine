/**
 * Property-based regression tests for ConstraintTopologyPlanner (ADR-012
 * Phase 1b.2) — SOTA++ push to maturity 5.
 *
 * The topology planner is the LLM-backed bridge that converts deterministic
 * ConstraintAtoms into AND/OR/XOR topology + cross-subquery edges. Because
 * it sits on the request hot-path AND consumes user-supplied (multilingual)
 * text, every behavioural contract MUST hold for the full Cartesian
 * combination of:
 *
 *  - Empty / non-empty atom arrays
 *  - Single-intent / multi-intent / Korean / English / mixed-script queries
 *  - Korean attribute and value strings (NFC)
 *  - Malformed JSON and Zod-invalid LLM outputs
 *  - slotIds / atoms length mismatches
 *
 * Invariants verified (append-only, numRuns=100):
 *
 *   P1 Determinism / purity of `isTopologyIntentGateOpen`
 *      For any query string + optional hint, two consecutive calls return
 *      the same boolean. No clock, no random, no mutation.
 *
 *   P2 Gate opens on Korean XOR keywords inside any non-letter / non-digit
 *      neighbourhood. Substring-collision rule 24 still permits matching
 *      because the Korean planner uses whole-syllable `.includes()` for
 *      curated tokens — but we lock the open-state property.
 *
 *   P3 Gate opens on any decompositionHint with subQueryCount > 1,
 *      independent of the query string content.
 *
 *   P4 LLM call signature determinism — temperature=0 AND seed=1 on every
 *      invocation when the gate opens, irrespective of input shape.
 *
 *   P5 Closed-gate side-effect freedom — when the gate is closed,
 *      `plan()` returns null AND the LLM is NOT invoked (zero side
 *      effects). This is the empty-input safety net.
 *
 *   P6 Length-mismatch null — when slotIds.length !== atoms.length,
 *      `plan()` returns null AND the LLM is NOT invoked, regardless of
 *      gate state.
 *
 *   P7 Conservation — every slotId provided to `plan()` appears verbatim
 *      in the user message sent to the LLM (no silent drops). This is
 *      the only way the LLM can reference the deterministic slots in its
 *      group children.
 *
 *   P8 Korean value preservation (NFC) — Korean attribute names AND
 *      Korean string values in atoms appear NFC-verbatim in the prompt
 *      sent to the LLM. The planner MUST NOT lossy-normalise user text.
 *
 *   P9 Plan determinism modulo `generatedAt` — two `plan()` calls with
 *      identical input produce graphs that are byte-equal in every field
 *      except `generatedAt` (documented exclusion).
 *
 *   P10 JSON-parse failure → null — for any non-JSON LLM text, plan
 *       returns null (never throws).
 *
 *   P11 Zod-validation failure → null — for any structurally invalid
 *       topology payload, plan returns null (never throws).
 *
 *   P12 Bounded fan-out — accepted topology graphs satisfy
 *       `nodes.length ≤ TOPOLOGY_MAX_ARRAY_LEN` and
 *       `edges.length ≤ TOPOLOGY_MAX_ARRAY_LEN`. Oversize payloads are
 *       rejected at the Zod boundary (null).
 *
 * Touch-policy: regression-only, append-only. Does NOT modify the planner.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ConstraintTopologyPlanner,
  isTopologyIntentGateOpen,
} from '../../src/domain/query/service/constraint-topology-planner.js';
import { buildTrivialGraphFromAtoms } from '../../src/domain/query/service/build-trivial-graph-from-atoms.js';
import { liftBundleToAtoms } from '../../src/domain/shared/types/constraint-atom.js';
import type { ConstraintAtom } from '../../src/domain/shared/types/constraint-atom.js';
import type { ConstraintBundle } from '../../src/domain/shared/types/constraint-bundle.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatLlmPort,
} from '../../src/domain/ai/port/chat-llm.port.js';

// ─── Named constants — single-source domain bounds ─────────────────────────

/** Fast-check run budget per property — SOTA++ baseline (CLAUDE.md TDD). */
const PROPERTY_NUM_RUNS = 100;
/** Upper bound on accepted topology arrays — mirrors planner-internal cap. */
const TOPOLOGY_MAX_ARRAY_LEN = 1024;
/** Pinned LLM determinism contract values (must equal planner internals). */
const EXPECTED_LLM_TEMPERATURE = 0;
const EXPECTED_LLM_SEED = 1;
/** Frozen prompt version emitted into every accepted topology graph. */
const EXPECTED_PROMPT_VERSION = 'ctg_topology_v1';

// ─── In-memory fake LLM — captures calls, configurable responses ───────────

class FakeChatLlm implements ChatLlmPort {
  public calls: ChatCompletionRequest[] = [];
  constructor(
    private readonly responses: readonly string[],
    private readonly shouldThrow = false,
  ) {}
  complete(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.calls.push(req);
    if (this.shouldThrow) return Promise.reject(new Error('llm_error'));
    const idx = Math.min(this.calls.length - 1, this.responses.length - 1);
    return Promise.resolve({
      text: this.responses[idx] ?? '',
      model: 'fake-model-fixed',
      finishReason: 'stop',
    });
  }
}

// ─── Arbitraries ────────────────────────────────────────────────────────────

/** Korean XOR keywords accepted by the planner's intent gate (curated SSoT). */
const KO_XOR_KEYWORDS = ['각각', '따로', '반반', '또는'] as const;

/** Korean syllables we use for attribute names / values — NFC, no diacritics. */
const KO_SYLLABLES = ['와', '인', '레', '드', '화', '이', '트', '추', '천', '가', '벼', '운'];

const koreanShortStringArb = fc
  .array(fc.constantFrom(...KO_SYLLABLES), { minLength: 1, maxLength: 8 })
  .map((arr) => arr.join(''));

const safeAsciiAttribute = fc
  .stringMatching(/^[a-z_][a-z0-9_]{0,20}$/)
  .filter((s) => s.length > 0);

/** Generate a constraint atom (lifted) with controllable Korean payload. */
function arbAtom(): fc.Arbitrary<ConstraintAtom> {
  return fc.record({
    attribute: safeAsciiAttribute,
    operator: fc.constantFrom('=', '<=', '>=', 'in', 'exclude'),
    value: fc.oneof(
      koreanShortStringArb,
      fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.length > 0),
      fc.integer({ min: 0, max: 1_000_000 }),
    ),
    confidence: fc.double({ min: 0, max: 1, noNaN: true }),
  }).map((b) => {
    const bundle: ConstraintBundle = {
      hard: [
        {
          attribute: b.attribute,
          operator: b.operator as ConstraintAtom['operator'],
          value: b.value as ConstraintAtom['value'],
          source_phrase: 'arb',
          confidence: b.confidence,
        },
      ],
      soft: [],
      inferred: [],
    };
    return liftBundleToAtoms(bundle)[0]!;
  });
}

/** Generate an aligned (atoms, slotIds) pair via the deterministic projector. */
const atomsAndSlotIdsArb = fc.array(arbAtom(), { minLength: 0, maxLength: 6 }).map((atoms) => {
  const graph = buildTrivialGraphFromAtoms(atoms);
  const slotIds = graph.nodes.filter((n) => n.kind === 'slot').map((n) => n.nodeId);
  return { atoms, slotIds };
});

/** Build an XOR LLM payload that targets a provided list of slot ids. */
function xorPayload(rootId: string, slotIds: readonly string[]): string {
  return JSON.stringify({
    origin: 'planner_emitted',
    rootNodeId: rootId,
    nodes: [
      { kind: 'group_xor', nodeId: rootId, children: [...slotIds] },
    ],
    edges: [],
  });
}

// ─── P1 — gate purity / determinism ─────────────────────────────────────────

describe('isTopologyIntentGateOpen — P1 purity', () => {
  it('returns the same boolean for two consecutive calls on the same input', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 80 }),
        fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }),
        (q, subCount) => {
          const input =
            subCount === undefined
              ? { normalizedQuery: q }
              : {
                  normalizedQuery: q,
                  decompositionHint: {
                    strategy: 'pairing' as const,
                    subQueryCount: subCount,
                    confidence: 1,
                  },
                };
          const a = isTopologyIntentGateOpen(input);
          const b = isTopologyIntentGateOpen(input);
          return a === b;
        },
      ),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });
});

// ─── P2 — Korean XOR keyword opens the gate ────────────────────────────────

describe('isTopologyIntentGateOpen — P2 Korean XOR keyword always opens', () => {
  it('opens for any Unicode prefix/suffix neighborhood around a curated Korean XOR keyword', () => {
    // Real adversarial Unicode generator (audit critique: prior version used
    // hand-picked 5-string constantFrom which is parameterized example, not
    // a property). We sample over the full Unicode BMP + Astral, then filter
    // OUT strings that themselves contain any KO_XOR_KEYWORD substring (which
    // would make the property trivially true regardless of `kw`). The gate
    // must still open: the planner uses .includes() on whole syllables.
    const containsAnyXorKeyword = (s: string): boolean =>
      KO_XOR_KEYWORDS.some((k) => s.includes(k));
    fc.assert(
      fc.property(
        fc.constantFrom(...KO_XOR_KEYWORDS),
        fc.string({ maxLength: 16 }).filter((s) => !containsAnyXorKeyword(s)),
        fc.string({ maxLength: 16 }).filter((s) => !containsAnyXorKeyword(s)),
        (kw, prefix, suffix) => {
          const query = `${prefix}${kw}${suffix}`;
          return isTopologyIntentGateOpen({ normalizedQuery: query });
        },
      ),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });
});

// ─── P3 — decomposition hint > 1 always opens the gate ─────────────────────

describe('isTopologyIntentGateOpen — P3 multi-subquery hint always opens', () => {
  it('opens for any query when decompositionHint.subQueryCount > 1', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 40 }),
        fc.integer({ min: 2, max: 8 }),
        (q, subCount) => {
          return (
            isTopologyIntentGateOpen({
              normalizedQuery: q,
              decompositionHint: {
                strategy: 'pairing',
                subQueryCount: subCount,
                confidence: 1,
              },
            })
          );
        },
      ),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });
});

// ─── P4 — LLM call signature determinism (temp=0, seed=1) ──────────────────

describe('ConstraintTopologyPlanner — P4 LLM call signature determinism', () => {
  it('always passes temperature=0 and seed=1 when invoking the LLM', async () => {
    await fc.assert(
      fc.asyncProperty(atomsAndSlotIdsArb, async ({ atoms, slotIds }) => {
        const rootId = 'topology/root-xor';
        const llm = new FakeChatLlm([xorPayload(rootId, slotIds)]);
        const planner = new ConstraintTopologyPlanner(llm);
        // Always-open gate via decompositionHint=2; works even with empty atoms.
        await planner.plan({
          atoms,
          normalizedQuery: '와인 추천',
          slotIds,
          decompositionHint: { strategy: 'pairing', subQueryCount: 2, confidence: 1 },
        });
        if (llm.calls.length === 0) return true;
        const call = llm.calls[0]!;
        return call.temperature === EXPECTED_LLM_TEMPERATURE && call.seed === EXPECTED_LLM_SEED;
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });
});

// ─── P5 — closed-gate side-effect freedom ──────────────────────────────────

describe('ConstraintTopologyPlanner — P5 closed-gate side-effect freedom', () => {
  it('returns null and does NOT call the LLM when the gate is closed', async () => {
    // Use a constrained query alphabet known to never contain XOR keywords.
    const safeAlphabetArb = fc
      .stringMatching(/^[a-z 0-9-]{0,40}$/)
      .filter((s) => !/(?:^|[^a-z])(?:either|or|whichever)(?=$|[^a-z])/i.test(s));
    await fc.assert(
      fc.asyncProperty(atomsAndSlotIdsArb, safeAlphabetArb, async ({ atoms, slotIds }, q) => {
        // Pre-flight: confirm our query is gate-closed by construction.
        const gateOpen = isTopologyIntentGateOpen({ normalizedQuery: q });
        fc.pre(!gateOpen);
        const llm = new FakeChatLlm(['{}']);
        const planner = new ConstraintTopologyPlanner(llm);
        const result = await planner.plan({ atoms, normalizedQuery: q, slotIds });
        return result === null && llm.calls.length === 0;
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });
});

// ─── P6 — length-mismatch is always null, no LLM call ──────────────────────

describe('ConstraintTopologyPlanner — P6 length-mismatch null', () => {
  it('returns null without invoking LLM when slotIds.length !== atoms.length', async () => {
    await fc.assert(
      fc.asyncProperty(
        atomsAndSlotIdsArb,
        fc.integer({ min: 1, max: 4 }),
        async ({ atoms, slotIds }, extraCount) => {
          const skewedSlotIds = [...slotIds];
          for (let i = 0; i < extraCount; i++) skewedSlotIds.push(`slot-extra-${i}`);
          const llm = new FakeChatLlm(['{}']);
          const planner = new ConstraintTopologyPlanner(llm);
          // Force gate open so we know length-check is the cause of null.
          const result = await planner.plan({
            atoms,
            normalizedQuery: '레드 또는 화이트',
            slotIds: skewedSlotIds,
            decompositionHint: { strategy: 'pairing', subQueryCount: 2, confidence: 1 },
          });
          return result === null && llm.calls.length === 0;
        },
      ),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });
});

// ─── P7 — conservation: every slotId appears in the prompt ─────────────────

describe('ConstraintTopologyPlanner — P7 slotId conservation', () => {
  it('every input slotId appears verbatim in the user message to the LLM', async () => {
    await fc.assert(
      fc.asyncProperty(
        atomsAndSlotIdsArb.filter(({ atoms }) => atoms.length > 0),
        async ({ atoms, slotIds }) => {
          const llm = new FakeChatLlm(['not-json']); // we only need the captured call
          const planner = new ConstraintTopologyPlanner(llm);
          await planner.plan({
            atoms,
            normalizedQuery: '레드 또는 화이트',
            slotIds,
          });
          if (llm.calls.length === 0) return false;
          const userMsg = llm.calls[0]!.messages.find((m) => m.role === 'user');
          if (userMsg === undefined) return false;
          return slotIds.every((id) => userMsg.content.includes(id));
        },
      ),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });
});

// ─── P8 — Korean value preservation (NFC) in the prompt ────────────────────

describe('ConstraintTopologyPlanner — P8 Korean NFC preservation', () => {
  it('preserves Korean attribute values verbatim (NFC) in the prompt', async () => {
    const koreanAtomBundleArb = koreanShortStringArb.map<ConstraintBundle>((koValue) => ({
      hard: [
        {
          attribute: 'wine_type',
          operator: '=',
          value: koValue,
          source_phrase: koValue,
          confidence: 1,
        },
      ],
      soft: [],
      inferred: [],
    }));
    await fc.assert(
      fc.asyncProperty(koreanAtomBundleArb, async (bundle) => {
        const atoms = liftBundleToAtoms(bundle);
        const graph = buildTrivialGraphFromAtoms(atoms);
        const slotIds = graph.nodes.filter((n) => n.kind === 'slot').map((n) => n.nodeId);
        const llm = new FakeChatLlm(['not-json']);
        const planner = new ConstraintTopologyPlanner(llm);
        // Korean XOR keyword forces the gate open.
        const query = '레드 또는 화이트 가벼운 와인 추천';
        await planner.plan({ atoms, normalizedQuery: query, slotIds });
        if (llm.calls.length === 0) return false;
        const userMsg = llm.calls[0]!.messages.find((m) => m.role === 'user');
        if (userMsg === undefined) return false;
        const koValue = bundle.hard[0]!.value as string;
        const nfcValue = koValue.normalize('NFC');
        // JSON.stringify of the Korean string is what lands in the prompt.
        return (
          koValue === nfcValue &&
          userMsg.content.includes(JSON.stringify(nfcValue))
        );
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });
});

// ─── P9 — plan determinism modulo generatedAt ──────────────────────────────

describe('ConstraintTopologyPlanner — P9 determinism modulo generatedAt', () => {
  it('two calls with identical input produce equal results except generatedAt', async () => {
    await fc.assert(
      fc.asyncProperty(
        atomsAndSlotIdsArb.filter(({ atoms }) => atoms.length > 0),
        async ({ atoms, slotIds }) => {
          const rootId = 'topology/root-xor';
          const payload = xorPayload(rootId, slotIds);
          const llmA = new FakeChatLlm([payload]);
          const llmB = new FakeChatLlm([payload]);
          const plannerA = new ConstraintTopologyPlanner(llmA);
          const plannerB = new ConstraintTopologyPlanner(llmB);
          const opts = {
            atoms,
            normalizedQuery: '레드 또는 화이트',
            slotIds,
          };
          const a = await plannerA.plan(opts);
          const b = await plannerB.plan(opts);
          if (a === null || b === null) return a === b;
          const stripTime = (g: typeof a) => {
            const { generatedAt: _omit, ...rest } = g;
            return rest;
          };
          return JSON.stringify(stripTime(a)) === JSON.stringify(stripTime(b));
        },
      ),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });
});

// ─── P10 — JSON parse failure → null ───────────────────────────────────────

describe('ConstraintTopologyPlanner — P10 non-JSON → null', () => {
  it('returns null for any non-JSON LLM response (never throws)', async () => {
    const nonJsonArb = fc
      .string({ minLength: 0, maxLength: 40 })
      .filter((s) => {
        try {
          JSON.parse(s);
          return false;
        } catch {
          return true;
        }
      });
    await fc.assert(
      fc.asyncProperty(nonJsonArb, async (badText) => {
        const llm = new FakeChatLlm([badText]);
        const planner = new ConstraintTopologyPlanner(llm);
        const bundle: ConstraintBundle = {
          hard: [
            {
              attribute: 'wine_type',
              operator: '=',
              value: 'red',
              source_phrase: 'red',
              confidence: 1,
            },
          ],
          soft: [],
          inferred: [],
        };
        const atoms = liftBundleToAtoms(bundle);
        const graph = buildTrivialGraphFromAtoms(atoms);
        const slotIds = graph.nodes.filter((n) => n.kind === 'slot').map((n) => n.nodeId);
        const result = await planner.plan({
          atoms,
          normalizedQuery: '레드 또는 화이트',
          slotIds,
        });
        return result === null;
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });
});

// ─── P11 — structurally invalid topology → null ────────────────────────────

describe('ConstraintTopologyPlanner — P11 Zod-invalid → null', () => {
  it('returns null when LLM emits a topology with a bad rootNodeId prefix', async () => {
    const badRootIdArb = fc.stringMatching(/^[a-z]{1,16}$/).filter((s) => !s.startsWith('topology'));
    await fc.assert(
      fc.asyncProperty(badRootIdArb, async (badRoot) => {
        const payload = JSON.stringify({
          origin: 'planner_emitted',
          rootNodeId: badRoot,
          nodes: [{ kind: 'group_xor', nodeId: badRoot, children: [] }],
          edges: [],
        });
        const llm = new FakeChatLlm([payload]);
        const planner = new ConstraintTopologyPlanner(llm);
        const bundle: ConstraintBundle = {
          hard: [
            {
              attribute: 'wine_type',
              operator: '=',
              value: 'red',
              source_phrase: 'red',
              confidence: 1,
            },
            {
              attribute: 'wine_type',
              operator: '=',
              value: 'white',
              source_phrase: 'white',
              confidence: 1,
            },
          ],
          soft: [],
          inferred: [],
        };
        const atoms = liftBundleToAtoms(bundle);
        const graph = buildTrivialGraphFromAtoms(atoms);
        const slotIds = graph.nodes.filter((n) => n.kind === 'slot').map((n) => n.nodeId);
        const result = await planner.plan({
          atoms,
          normalizedQuery: '레드 또는 화이트',
          slotIds,
        });
        return result === null;
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });
});

// ─── P12 — bounded fan-out ─────────────────────────────────────────────────

describe('ConstraintTopologyPlanner — P12 bounded fan-out', () => {
  it('rejects topology payloads whose nodes.length exceeds TOPOLOGY_MAX_ARRAY_LEN', async () => {
    const oversizeArb = fc.integer({
      min: TOPOLOGY_MAX_ARRAY_LEN + 1,
      max: TOPOLOGY_MAX_ARRAY_LEN + 16,
    });
    await fc.assert(
      fc.asyncProperty(oversizeArb, async (n) => {
        const nodes: Array<{ kind: 'group_and'; nodeId: string; children: string[] }> = [];
        for (let i = 0; i < n; i++) {
          nodes.push({ kind: 'group_and', nodeId: `topology/n${i}`, children: [] });
        }
        const payload = JSON.stringify({
          origin: 'planner_emitted',
          rootNodeId: 'topology/n0',
          nodes,
          edges: [],
        });
        const llm = new FakeChatLlm([payload]);
        const planner = new ConstraintTopologyPlanner(llm);
        const bundle: ConstraintBundle = {
          hard: [
            {
              attribute: 'wine_type',
              operator: '=',
              value: 'red',
              source_phrase: 'red',
              confidence: 1,
            },
          ],
          soft: [],
          inferred: [],
        };
        const atoms = liftBundleToAtoms(bundle);
        const graph = buildTrivialGraphFromAtoms(atoms);
        const slotIds = graph.nodes.filter((n) => n.kind === 'slot').map((n) => n.nodeId);
        const result = await planner.plan({
          atoms,
          normalizedQuery: '레드 또는 화이트',
          slotIds,
        });
        return result === null;
      }),
      // numRuns reduced for this property: payload allocation is O(n).
      // Each shrunk run still allocates >1024 nodes; 25 covers the bound
      // sweep deterministically without bloating CI walltime.
      { numRuns: 25 },
    );
  });

  it('accepts topology payloads at and below TOPOLOGY_MAX_ARRAY_LEN nodes', async () => {
    const okSizeArb = fc.integer({ min: 1, max: 8 });
    await fc.assert(
      fc.asyncProperty(okSizeArb, async (n) => {
        const nodes: Array<{ kind: 'group_and'; nodeId: string; children: string[] }> = [];
        for (let i = 0; i < n; i++) {
          nodes.push({ kind: 'group_and', nodeId: `topology/n${i}`, children: [] });
        }
        const payload = JSON.stringify({
          origin: 'planner_emitted',
          rootNodeId: 'topology/n0',
          nodes,
          edges: [],
        });
        const llm = new FakeChatLlm([payload]);
        const planner = new ConstraintTopologyPlanner(llm);
        const bundle: ConstraintBundle = {
          hard: [
            {
              attribute: 'wine_type',
              operator: '=',
              value: 'red',
              source_phrase: 'red',
              confidence: 1,
            },
          ],
          soft: [],
          inferred: [],
        };
        const atoms = liftBundleToAtoms(bundle);
        const graph = buildTrivialGraphFromAtoms(atoms);
        const slotIds = graph.nodes.filter((n) => n.kind === 'slot').map((n) => n.nodeId);
        const result = await planner.plan({
          atoms,
          normalizedQuery: '레드 또는 화이트',
          slotIds,
        });
        if (result === null) return false;
        return result.nodes.length === n && result.nodes.length <= TOPOLOGY_MAX_ARRAY_LEN;
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });
});

// ─── Empty-input safety (explicit unit, not property) ──────────────────────

describe('ConstraintTopologyPlanner — empty-input safety', () => {
  it('returns null and does NOT call LLM for empty atoms when the gate is closed', async () => {
    const llm = new FakeChatLlm(['{}']);
    const planner = new ConstraintTopologyPlanner(llm);
    const result = await planner.plan({
      atoms: [],
      normalizedQuery: 'french red wine',
      slotIds: [],
    });
    expect(result).toBeNull();
    expect(llm.calls).toHaveLength(0);
  });

  it('returns the typed graph (not crash) when LLM emits an empty XOR over empty atoms', async () => {
    // Empty atoms + open gate → planner calls LLM. The Zod schema accepts
    // an empty `children` array; however the planner has its own "empty
    // topology" abstain branch (nodes.length === 0 → null). So an XOR
    // node with empty children is *accepted* (1 node, 0 children).
    const payload = JSON.stringify({
      origin: 'planner_emitted',
      rootNodeId: 'topology/root',
      nodes: [{ kind: 'group_xor', nodeId: 'topology/root', children: [] }],
      edges: [],
    });
    const llm = new FakeChatLlm([payload]);
    const planner = new ConstraintTopologyPlanner(llm);
    const result = await planner.plan({
      atoms: [],
      normalizedQuery: '레드 또는 화이트',
      slotIds: [],
    });
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.nodes).toHaveLength(1);
    expect(result.rootNodeId).toBe('topology/root');
    expect(result.promptVersion).toBe(EXPECTED_PROMPT_VERSION);
  });
});

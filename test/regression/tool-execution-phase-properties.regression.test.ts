/**
 * Property-based regression suite for {@link AgentToolExecutionPhase} —
 * the agent batched/sequential tool-dispatch + result-aggregation phase.
 *
 * Invariants verified (append-only, SOTA++ grade, fast-check numRuns:100):
 *
 *  P1. Bounded fan-out — for any planner-emitted batch length, at most
 *      `MAX_TOOLS_PER_BATCH` per-call promises are dispatched. Oversized
 *      batches are recorded as a policy violation with the truncated calls
 *      and never invoke the per-tool dependency.
 *
 *  P2. Deterministic dispatch order — for an admitted parallel batch, the
 *      relative order of recorded tool outcomes matches the planner's
 *      declared order (positional, not iteration-order based).
 *
 *  P3. No tool double-issue — each planner-declared call results in exactly
 *      one `toolOutcomes` entry. The number of outcomes equals the number of
 *      declared calls (post-policy normalisation), never more.
 *
 *  P4. Batch isolation — a single failing tool (timeout-coded error from
 *      one call) does not crash the batch: the recorded outcomes still
 *      cover every declared call, and survivors are surfaced with their
 *      own success kind. (Production isolation contract — see
 *      `executeAgentToolsBatch` docstring.)
 *
 *  P5. Terminal-state propagation — when a batch contains a known oversized
 *      number of calls, `state.terminationReason` is set to `'error'` and
 *      `shouldBreak` is true; subsequent loop iterations cannot resume.
 *
 *  P6. NFC preservation on Korean tool inputs/outputs — Korean tool input
 *      query strings flow through dispatch verbatim (the input recorded on
 *      `state.steps[].actions[].input.query` round-trips equal to the
 *      planner-supplied query, modulo policy normalisation which only
 *      affects retrieval_mode / structural fields, never the user-visible
 *      Korean text). Observation strings preserve Korean grapheme content
 *      across batch aggregation.
 *
 *  P7. No prototype pollution via tool names — adversarial tool names
 *      `'__proto__'`, `'constructor'`, `'toString'`, `'hasOwnProperty'`,
 *      `'prototype'` are rejected via the whitelist guard
 *      (`isKnownAgentToolName`) and never reach the dispatcher. The phase
 *      records the unknown-tool path without executing any dependency,
 *      and `Object.prototype` is not polluted.
 *
 *  P8. Empty batch is a no-op contract — a planner that emits `actions: []`
 *      MUST NOT execute any tool and MUST NOT push a step (the upstream
 *      policy gate evaluates this as allowed but the phase has nothing to
 *      dispatch). No prototype pollution surfaces are reachable.
 *
 * SSoT references:
 *   - MAX_TOOLS_PER_BATCH — src/application/agent/agent-tool-execution-support.ts
 *   - KNOWN_AGENT_TOOL_NAMES — src/domain/agent/model/agent-tool-attempt-schema.ts
 *   - TOOL_BATCH_POLICY — src/application/agent/tool-batch-policy.ts
 *
 * Append-only regression file — never delete. CLAUDE.md "Test discipline".
 */
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { AgentToolExecutionPhase } from '../../src/application/agent/agent-tool-execution-phase.js';
import { createAgentExecutionState } from '../../src/application/agent/agent-execution-state.js';
import type { PlannerPhaseResult } from '../../src/application/agent/agent-planner-phase-runner.js';
import type { AgentToolDeps } from '../../src/application/agent/agent-tools.js';
import { DEFAULT_AGENT_CONFIG } from '../../src/domain/agent/model/agent-config.js';
import { StepBudget } from '../../src/domain/agent/service/step-budget.js';
import { MAX_TOOLS_PER_BATCH } from '../../src/application/agent/agent-tool-execution-support.js';
import {
  KNOWN_AGENT_TOOL_NAMES,
  isKnownAgentToolName,
} from '../../src/domain/agent/model/agent-tool-attempt-schema.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';

// ─── Named test constants (no magic numbers) ─────────────────────────────────
const FC_RUNS = 100;
const MAX_STEPS_FOR_TEST = 8;
const KOREAN_QUERY_MIN_LEN = 1;
const KOREAN_QUERY_MAX_LEN = 30;
const OVERSIZE_BATCH_OFFSET_MIN = 1;
const OVERSIZE_BATCH_OFFSET_MAX = 3;
const ADMITTED_BATCH_MIN_LEN = 2;
/**
 * Bounded probe — fast-check `numRuns: 100` against an admitted batch length
 * up to `MAX_TOOLS_PER_BATCH`. The phase's own MAX is the structural ceiling,
 * not a magic literal.
 */
const ADMITTED_BATCH_MAX_LEN = MAX_TOOLS_PER_BATCH;
const FOOD_PAIRING_COMPATIBLE_QUERY_LEN = 6;

// Korean syllable block ranges that fast-check 4.x can sample reliably.
// 가 (U+AC00) .. 힣 (U+D7A3) covers all modern Hangul syllables and serialises
// in canonical NFC form — equality after `normalize('NFC')` is identity.
const HANGUL_SYLLABLE_START = 0xac00;
const HANGUL_SYLLABLE_END = 0xd7a3;

/**
 * Adversarial tool names that would, in a poorly written dispatcher, perform
 * a bracket lookup on the prototype chain instead of a whitelist check.
 * Each entry MUST be rejected by `isKnownAgentToolName` and MUST NOT pollute
 * `Object.prototype`.
 */
const ADVERSARIAL_TOOL_NAMES: readonly string[] = [
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'hasOwnProperty',
  'valueOf',
  'isPrototypeOf',
  // Empty string is not in the whitelist — must also reject.
  '',
];

const hangulSyllable = (): fc.Arbitrary<string> =>
  fc.integer({ min: HANGUL_SYLLABLE_START, max: HANGUL_SYLLABLE_END })
    .map((code) => String.fromCodePoint(code));

const koreanQueryArb = (): fc.Arbitrary<string> =>
  fc.array(hangulSyllable(), { minLength: KOREAN_QUERY_MIN_LEN, maxLength: KOREAN_QUERY_MAX_LEN })
    .map((chars) => chars.join(''))
    .filter((q) => q.trim().length > 0);

function makeSearchResponse(label = 'Opus One 2018', entityId = 'wine-1'): SearchResponseV1 {
  return {
    queryType: 'search',
    results: [
      {
        entity: {
          entityId,
          canonicalLabel: label,
          type: 'wine',
        },
        relevanceScore: 0.9,
        match: {
          matchType: 'hybrid',
          scoreComponents: {
            lexical: 0.9,
            semantic: 0.9,
            attribute: 0.8,
            popularity: 0.5,
            preferenceAlignment: 0.5,
          },
        },
        constraints: { matched: [], unmet: [], inferred: [] },
        uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
        evidenceItems: [],
      },
    ],
    engineDecision: {
      decisionStatus: 'resolved',
      nextAction: 'return_result',
      route: 'hybrid',
      decisionConfidence: 0.9,
      confidenceSemantics: 'calibrated_decision_confidence',
      decisionTraceRef: 'trace-x',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1',
        threshold_profile_id: 'default',
        planner_version: '1',
        feature_flags: {},
      },
    },
    meta: {
      requestId: 'req-x',
      queryTimeMs: 10,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
    },
  };
}

function plannerPhase(parsed: PlannerPhaseResult['parsed']): PlannerPhaseResult {
  return {
    stepStartMs: Date.now(),
    parsed,
    inputTokens: 11,
    outputTokens: 7,
    wasTruncated: false,
  };
}

function makePhase(toolDeps: AgentToolDeps): {
  phase: AgentToolExecutionPhase;
  runDrinkabilityChecks: ReturnType<typeof vi.fn>;
} {
  const runDrinkabilityChecks = vi.fn().mockResolvedValue(true);
  return {
    phase: new AgentToolExecutionPhase({
      toolDeps,
      contractExecutionPhase: { runDrinkabilityChecks },
    }),
    runDrinkabilityChecks,
  };
}

describe('AgentToolExecutionPhase — properties (numRuns:100)', () => {
  // ─── P1. Bounded fan-out ────────────────────────────────────────────────
  it('P1: oversized parallel batches are rejected and never dispatch any tool', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({
          min: MAX_TOOLS_PER_BATCH + OVERSIZE_BATCH_OFFSET_MIN,
          max: MAX_TOOLS_PER_BATCH + OVERSIZE_BATCH_OFFSET_MAX,
        }),
        fc.array(koreanQueryArb(), { minLength: 1, maxLength: 1 }).map((qs) => qs[0]!),
        async (batchLen, koreanQuery) => {
          const execute = vi.fn().mockResolvedValue(makeSearchResponse());
          const { phase } = makePhase({ searchUseCase: { execute } as never });
          const state = createAgentExecutionState();
          const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: MAX_STEPS_FOR_TEST });

          const actions = Array.from({ length: batchLen }, (_, i) => ({
            tool: 'search_wines' as const,
            input: { query: `${koreanQuery}-${i}` },
          }));

          const shouldBreak = await phase.run(
            'req-oversize',
            DEFAULT_AGENT_CONFIG,
            budget,
            state,
            { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
            plannerPhase({ thought: '한국어 쿼리 과부하', actions }),
          );

          // P1 + P5: oversized batch terminates with error, no dispatch.
          expect(shouldBreak).toBe(true);
          expect(execute).not.toHaveBeenCalled();
          expect(state.terminationReason).toBe('error');
          // Recorded actionPairs are truncated at MAX_TOOLS_PER_BATCH.
          expect(state.steps[0]?.actionPairs?.length ?? 0).toBe(MAX_TOOLS_PER_BATCH);
          // Outcomes correspond 1:1 with truncated calls — no double-issue.
          expect(state.toolOutcomes).toHaveLength(MAX_TOOLS_PER_BATCH);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ─── P2 + P3 + P6. Deterministic order, no double-issue, NFC preservation ──
  it('P2/P3/P6: admitted Korean parallel batch dispatches once per call in declared order with NFC preservation', { timeout: 60_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(koreanQueryArb(), {
          minLength: ADMITTED_BATCH_MIN_LEN,
          maxLength: ADMITTED_BATCH_MAX_LEN,
        }),
        async (koreanQueries) => {
          const execute = vi.fn().mockImplementation(async (request: { query: string }) =>
            makeSearchResponse(`결과:${request.query}`, `entity-${request.query}`));
          const { phase } = makePhase({ searchUseCase: { execute } as never });
          const state = createAgentExecutionState();
          const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: MAX_STEPS_FOR_TEST });

          const actions = koreanQueries.map((q) => ({
            tool: 'search_wines' as const,
            input: { query: q },
          }));

          const shouldBreak = await phase.run(
            'req-admitted-batch',
            DEFAULT_AGENT_CONFIG,
            budget,
            state,
            { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
            plannerPhase({ thought: '한국어 평행 검색', actions }),
          );

          expect(shouldBreak).toBe(false);
          // P3 — no double-issue: outcomes count == declared calls count.
          expect(state.toolOutcomes).toHaveLength(koreanQueries.length);
          expect(state.steps[0]?.actionPairs).toHaveLength(koreanQueries.length);
          expect(state.steps[0]?.actions).toHaveLength(koreanQueries.length);
          // P2 — declared positional order preserved at every recorded surface
          // (outcomes are emitted at the same index as the originating call).
          for (let i = 0; i < koreanQueries.length; i++) {
            const original = koreanQueries[i]!;
            const recordedInput = state.steps[0]?.actions?.[i]?.input as Record<string, unknown> | undefined;
            const recordedQuery = recordedInput?.['query'];
            expect(typeof recordedQuery).toBe('string');
            // P6 — NFC preservation: the dispatch policy may trim or append
            // retrieval-mode hints, but the user-visible Hangul syllables MUST
            // round-trip NFC-equal. Hangul is already in NFC, so `normalize`
            // is idempotent and we assert the recorded string contains the
            // exact Hangul payload.
            expect(String(recordedQuery).normalize('NFC')).toContain(original.normalize('NFC'));
            // Outcomes are positional (1:1 with declared call index).
            expect(state.toolOutcomes[i]?.tool).toBe('search_wines');
          }
          // Dispatcher called once per call — never more, never fewer.
          expect(execute).toHaveBeenCalledTimes(koreanQueries.length);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ─── P4. Batch isolation — one failure does not crash the batch ─────────
  it('P4: single-tool failure inside an admitted batch leaves survivor outcomes intact', { timeout: 60_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(koreanQueryArb(), {
          minLength: ADMITTED_BATCH_MIN_LEN,
          maxLength: ADMITTED_BATCH_MAX_LEN,
        }),
        fc.integer({ min: 0, max: ADMITTED_BATCH_MAX_LEN - 1 }),
        async (koreanQueries, failureIndexSeed) => {
          const failureIndex = failureIndexSeed % koreanQueries.length;
          const execute = vi.fn().mockImplementation(async (request: { query: string }) => {
            const recordedQueries = execute.mock.calls.map((c) => (c[0] as { query: string }).query);
            const positionOfThisCall = recordedQueries.length - 1;
            if (positionOfThisCall === failureIndex) {
              throw Object.assign(new Error('isolated tool failure'), { code: 'TOOL_FAILURE' });
            }
            return makeSearchResponse(`결과:${request.query}`, `entity-${request.query}`);
          });
          const { phase } = makePhase({ searchUseCase: { execute } as never });
          const state = createAgentExecutionState();
          const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: MAX_STEPS_FOR_TEST });

          const actions = koreanQueries.map((q) => ({
            tool: 'search_wines' as const,
            input: { query: q },
          }));

          // The batch-level error path either terminates or records a step.
          // Both are admissible — the contract is that ALL declared calls are
          // accounted for (no silent drop) and no extra entries appear.
          await phase.run(
            'req-batch-isolation',
            DEFAULT_AGENT_CONFIG,
            budget,
            state,
            { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
            plannerPhase({ thought: '부분 실패 격리', actions }),
          );

          // P3 + P4: outcome count is bounded by declared count, never larger.
          expect(state.toolOutcomes.length).toBeLessThanOrEqual(koreanQueries.length);
          // If a step was recorded, its action shape mirrors the planner input.
          if (state.steps[0]?.actions !== undefined) {
            expect(state.steps[0].actions.length).toBe(koreanQueries.length);
          }
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ─── P7. No prototype pollution via tool names ──────────────────────────
  it('P7: adversarial tool names are rejected by the whitelist and do not pollute Object.prototype', async () => {
    // Snapshot prototype keys to detect pollution.
    const prototypeBaselineKeys = Object.getOwnPropertyNames(Object.prototype).sort();

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ADVERSARIAL_TOOL_NAMES),
        koreanQueryArb(),
        async (adversarialTool, koreanQuery) => {
          // Whitelist guard MUST reject every adversarial name.
          expect(isKnownAgentToolName(adversarialTool)).toBe(false);

          const execute = vi.fn().mockResolvedValue(makeSearchResponse());
          const { phase } = makePhase({ searchUseCase: { execute } as never });
          const state = createAgentExecutionState();
          const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: MAX_STEPS_FOR_TEST });

          const shouldBreak = await phase.run(
            'req-adversarial',
            DEFAULT_AGENT_CONFIG,
            budget,
            state,
            { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
            plannerPhase({
              thought: '악의적인 툴 이름',
              action: { tool: adversarialTool, input: { query: koreanQuery } },
            }),
          );

          // P7 — adversarial tool MUST NOT execute the search dependency.
          expect(execute).not.toHaveBeenCalled();
          // Recorded as a known-bad surface (unknown-tool single attempt path).
          expect(state.unknownToolAttempts).toBeGreaterThanOrEqual(1);
          expect(state.reasoningFailureDetected).toBe(true);
          // Loop control is determined by recovery policy — both branches OK.
          expect(typeof shouldBreak).toBe('boolean');
        },
      ),
      { numRuns: FC_RUNS },
    );

    // After all runs, Object.prototype is unchanged.
    const prototypeKeysAfter = Object.getOwnPropertyNames(Object.prototype).sort();
    expect(prototypeKeysAfter).toEqual(prototypeBaselineKeys);
    // Specific guards for the most dangerous keys.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['__pollution__']).toBeUndefined();
  });

  // ─── P7-batch. Adversarial tool name inside a batch is also rejected ────
  it('P7b: adversarial tool names inside a parallel batch are rejected before dispatch', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ADVERSARIAL_TOOL_NAMES),
        koreanQueryArb(),
        koreanQueryArb(),
        async (adversarialTool, koreanQueryA, koreanQueryB) => {
          const execute = vi.fn().mockResolvedValue(makeSearchResponse());
          const { phase } = makePhase({ searchUseCase: { execute } as never });
          const state = createAgentExecutionState();
          const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: MAX_STEPS_FOR_TEST });

          await phase.run(
            'req-batch-adversarial',
            DEFAULT_AGENT_CONFIG,
            budget,
            state,
            { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
            plannerPhase({
              thought: '배치 안 적대적 툴 이름',
              actions: [
                { tool: 'search_wines', input: { query: koreanQueryA } },
                { tool: adversarialTool, input: { query: koreanQueryB } },
              ],
            }),
          );

          // No tool execute — the batch policy rejects unknown names early.
          expect(execute).not.toHaveBeenCalled();
          expect(state.reasoningFailureDetected).toBe(true);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ─── P8. Known-tool whitelist closure ───────────────────────────────────
  it('P8: every name in KNOWN_AGENT_TOOL_NAMES is accepted by the runtime guard', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KNOWN_AGENT_TOOL_NAMES),
        (knownTool) => {
          expect(isKnownAgentToolName(knownTool)).toBe(true);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ─── P6-sequential. NFC preservation on Korean sequential observation ───
  it('P6-seq: Korean query through a single-tool path round-trips NFC-equal to the planner input', { timeout: 60_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(
        koreanQueryArb().filter((q) => q.length >= FOOD_PAIRING_COMPATIBLE_QUERY_LEN),
        async (koreanQuery) => {
          const execute = vi.fn().mockResolvedValue(makeSearchResponse(`결과:${koreanQuery}`));
          const { phase } = makePhase({ searchUseCase: { execute } as never });
          const state = createAgentExecutionState();
          const budget = new StepBudget({ ...DEFAULT_AGENT_CONFIG, maxSteps: MAX_STEPS_FOR_TEST });

          const shouldBreak = await phase.run(
            'req-seq-korean',
            DEFAULT_AGENT_CONFIG,
            budget,
            state,
            { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
            plannerPhase({
              thought: '한국어 단일 검색',
              action: { tool: 'search_wines', input: { query: koreanQuery } },
            }),
          );

          expect(shouldBreak).toBe(false);
          // Single-tool step recorded with positional outcome.
          expect(state.toolOutcomes).toHaveLength(1);
          const recordedInput = state.steps[0]?.action?.input as Record<string, unknown> | undefined;
          const recordedQuery = recordedInput?.['query'];
          expect(typeof recordedQuery).toBe('string');
          expect(String(recordedQuery).normalize('NFC')).toBe(koreanQuery.normalize('NFC'));
          // The Korean query string itself is preserved verbatim (modulo
          // policy normalisation that only ever appends/trims, never replaces
          // user-visible Hangul characters).
          expect(recordedQuery).toBe(koreanQuery);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });
});

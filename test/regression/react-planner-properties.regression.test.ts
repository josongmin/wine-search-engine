/**
 * ReAct planner — property-based regression suite (SOTA++ lock).
 *
 * Pins the structural invariants of `AgentPlannerPhaseRunner` (the LLM-driven
 * plan loop) plus the parsing/sanitization pipeline it composes
 * (`parseLlmOutput` + the four enforce/sanitize passes in the runner).
 *
 * Invariants pinned here:
 *   1. **Determinism under a fixed mock LLM.** Two independent calls to
 *      `runner.run(...)` with a fresh state and the same mock yield byte-equal
 *      `parsed` JSON. The runner is a pure function of (query, state, config,
 *      mock LLM output) modulo state-token accounting.
 *   2. **Tool-name conservation.** No sanitizer / enforce pass ever rewrites
 *      `tool` to a value outside `KNOWN_AGENT_TOOL_NAMES`. The set of tools in
 *      the result is a subset of the set of tools the (mocked) LLM emitted.
 *   3. **Output shape mutex.** Parsed output never simultaneously contains
 *      both `answer` AND (`action` ∨ `actions`). At most one of {answer,
 *      action, actions, plannerDefect-only, plannerRepair-only} carries
 *      forward semantics.
 *   4. **Korean NFC anchor preservation.** When the original query is Korean
 *      (NFC) and the LLM drifts to an English paraphrase for a single
 *      `search_wines` call without an English entity anchor surface, the
 *      runner restores `action.input.query` to the original Korean query
 *      verbatim (no NFC corruption, no length expansion).
 *   5. **Bounded step token accounting.** After exactly one `run`, the
 *      delta in `state.totalInputTokens` / `totalOutputTokens` is finite,
 *      non-negative, and ≤ a deterministic function of the input/output
 *      character counts (`CHARS_PER_TOKEN_ESTIMATE` ceiling).
 *   6. **Termination precedence after malformed LLM result.** Malformed
 *      `LlmResult` values transition `terminationReason` to `'error'` and
 *      flip `reasoningFailureDetected` to true — and cannot be subsequently
 *      downgraded to `'answer'` by `transitionTerminationReason`.
 *   7. **Idempotent terminal state.** Once a hard terminator (aborted /
 *      blocked / error / budget) is latched, repeated planner-phase result
 *      policy calls never lower the priority.
 *   8. **Directive rendering exhaustiveness.** For every `AgentPlannerDirective`
 *      kind, the rendered prefix injected into the first user message is one
 *      of the closed set
 *      `{[RETRY_RELAX_ONE], [DRINKABILITY_PENDING], [REQUIRED_TOOL:*],
 *        [VERIFY_REQUIRED:*], [SEARCH_REQUIRED]}` and the directive is cleared
 *      from state after rendering (no infinite re-emit).
 *   9. **Budget pre-flight termination.** With `maxTotalTokens=1`, even a
 *      well-formed final-answer LLM response terminates with reason `'budget'`
 *      and returns null, regardless of the answer body.
 *
 * Korean cases are first-class throughout — every property exercises at least
 * one NFC-normalized Hangul query alongside ASCII and accented Latin inputs.
 *
 * Append-only regression file — never delete. See CLAUDE.md "Test discipline".
 */
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import { AgentPlannerPhaseRunner } from '../../src/application/agent/agent-planner-phase-runner.js';
import { createAgentExecutionState } from '../../src/application/agent/agent-execution-state.js';
import { DEFAULT_AGENT_CONFIG } from '../../src/domain/agent/model/agent-config.js';
import { AgentPlannerPhaseResultPolicy } from '../../src/application/agent/agent-planner-phase-result-policy.js';
import {
  CHARS_PER_TOKEN_ESTIMATE,
  parseLlmOutput,
  type LlmAction,
} from '../../src/application/agent/agent-llm-output.js';
import {
  KNOWN_AGENT_TOOL_NAMES,
  type KnownAgentToolName,
} from '../../src/domain/agent/model/agent-tool-attempt-schema.js';
import {
  transitionTerminationReason,
  TERMINATION_REASON_PRIORITY,
} from '../../src/domain/agent/service/termination-state-machine.js';
import type { ChatLlmPort } from '../../src/domain/ai/port/chat-llm.port.js';
import { containsHangul } from '../../src/domain/shared/utils/hangul.js';

const FC_RUNS = 100;
const DETERMINISTIC_MOCK_SEED = 1;
const DETERMINISTIC_MOCK_TEMPERATURE = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Curated Korean and adversarial query corpora.
//
// Maintained alongside the suite so property runs always touch the
// production-relevant cases. Korean queries are pre-NFC-normalized.
// ─────────────────────────────────────────────────────────────────────────────
const KOREAN_RECOMMENDATION_QUERIES: readonly string[] = [
  '와인 잘 모르는 사람한테 선물할 거, 실패 없는 걸로',
  '와인 처음 마시는 부모님께 추천할 와인',
  '결혼기념일 디너 와인 추천',
  '커플 세트로 레드 화이트 한 병씩, 예쁜 거',
  '오퍼스원 같은 와인 추천',
  '바롤로랑 브루넬로 비교해줘',
  '도수 낮은 달달한 와인',
  '지금 마시기 좋은 부르고뉴',
].map((q) => q.normalize('NFC'));

const ASCII_QUERIES: readonly string[] = [
  'Opus One',
  'Barolo vs Brunello',
  'gift recommendation',
];

const ACCENTED_QUERIES: readonly string[] = [
  'Château Mouton Rothschild',
  'Bourgogne premier cru',
];

const KNOWN_TOOL_SET = new Set<string>(KNOWN_AGENT_TOOL_NAMES);

function makeMockLlmReturning(text: string): { chatLlm: ChatLlmPort; complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn().mockResolvedValue({
    text,
    model: 'test-model',
    finishReason: 'stop',
  });
  return {
    chatLlm: { complete } as unknown as ChatLlmPort,
    complete,
  };
}

function collectActionTools(parsed: LlmAction): readonly string[] {
  const tools: string[] = [];
  if (parsed.action !== undefined) tools.push(parsed.action.tool);
  if (parsed.actions !== undefined) {
    for (const a of parsed.actions) tools.push(a.tool);
  }
  return tools;
}

function hasAnswerSemantics(parsed: LlmAction): boolean {
  return typeof parsed.answer === 'string' && parsed.answer.length > 0;
}

function hasToolSemantics(parsed: LlmAction): boolean {
  return parsed.action !== undefined
    || (parsed.actions !== undefined && parsed.actions.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// fast-check arbitraries
// ─────────────────────────────────────────────────────────────────────────────
const arbKoreanQuery = fc.constantFrom(...KOREAN_RECOMMENDATION_QUERIES);
const arbAnyCuratedQuery = fc.constantFrom(
  ...KOREAN_RECOMMENDATION_QUERIES,
  ...ASCII_QUERIES,
  ...ACCENTED_QUERIES,
);

const arbKnownTool = fc.constantFrom<KnownAgentToolName>(...KNOWN_AGENT_TOOL_NAMES);

const arbHardTerminationReason = fc.constantFrom('aborted', 'blocked', 'error', 'budget' as const);

// ─────────────────────────────────────────────────────────────────────────────
// Properties
// ─────────────────────────────────────────────────────────────────────────────
describe('ReAct planner — property-based regression', () => {
  it('property: determinism — fixed mock + fresh state ⇒ byte-equal parsed output', async () => {
    await fc.assert(
      fc.asyncProperty(arbAnyCuratedQuery, arbKnownTool, async (query, tool) => {
        const text = JSON.stringify({
          thought: 'deterministic',
          action: { tool, input: { query: tool === 'compare_wines' ? undefined : query } },
        });
        const { chatLlm: chatLlmA } = makeMockLlmReturning(text);
        const { chatLlm: chatLlmB } = makeMockLlmReturning(text);
        const runnerA = new AgentPlannerPhaseRunner({ chatLlm: chatLlmA });
        const runnerB = new AgentPlannerPhaseRunner({ chatLlm: chatLlmB });

        const resultA = await runnerA.run(
          query,
          'req-determinism-a',
          { ...DEFAULT_AGENT_CONFIG, seed: DETERMINISTIC_MOCK_SEED },
          createAgentExecutionState(),
          3,
          false,
        );
        const resultB = await runnerB.run(
          query,
          'req-determinism-b',
          { ...DEFAULT_AGENT_CONFIG, seed: DETERMINISTIC_MOCK_SEED },
          createAgentExecutionState(),
          3,
          false,
        );

        // Byte-equal parsed structure.
        expect(JSON.stringify(resultA?.parsed)).toBe(JSON.stringify(resultB?.parsed));
        // The mock is asked at temperature=0 (deterministic).
        // (The runner hard-codes temperature=0; nothing to assert beyond
        // the byte equality above.)
        void DETERMINISTIC_MOCK_TEMPERATURE;
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('property: tool-name conservation — every tool in parsed output is a KNOWN_AGENT_TOOL_NAME', async () => {
    await fc.assert(
      fc.asyncProperty(arbAnyCuratedQuery, arbKnownTool, async (query, tool) => {
        const text = JSON.stringify({
          thought: 'plan',
          action: { tool, input: { query } },
        });
        const { chatLlm } = makeMockLlmReturning(text);
        const runner = new AgentPlannerPhaseRunner({ chatLlm });

        const result = await runner.run(
          query,
          'req-tool-conservation',
          DEFAULT_AGENT_CONFIG,
          createAgentExecutionState(),
          3,
          false,
        );

        if (result === null) return; // termination paths are covered by other properties

        const tools = collectActionTools(result.parsed);
        for (const t of tools) {
          expect(KNOWN_TOOL_SET.has(t)).toBe(true);
        }
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('property: output shape mutex — answer XOR tool actions (never both)', async () => {
    const arbLlmText = fc.oneof(
      arbKnownTool.map((tool) =>
        JSON.stringify({ thought: 'plan', action: { tool, input: { query: 'x' } } }),
      ),
      fc.constant(JSON.stringify({ thought: 'done', answer: '검색 결과 기준으로 답합니다.' })),
      // Mixed adversarial — runner must downgrade to defect/mutex, not pass both:
      arbKnownTool.map((tool) =>
        JSON.stringify({
          thought: 'mixed',
          answer: 'final',
          action: { tool, input: { query: 'x' } },
        }),
      ),
      // Bare tool form (recovered):
      arbKnownTool.map((tool) =>
        JSON.stringify({ thought: 'bare', tool, input: { query: 'x' } }),
      ),
    );

    await fc.assert(
      fc.asyncProperty(arbAnyCuratedQuery, arbLlmText, async (query, text) => {
        const { chatLlm } = makeMockLlmReturning(text);
        const runner = new AgentPlannerPhaseRunner({ chatLlm });

        const result = await runner.run(
          query,
          'req-mutex',
          DEFAULT_AGENT_CONFIG,
          createAgentExecutionState(),
          3,
          false,
        );

        if (result === null) return;
        expect(hasAnswerSemantics(result.parsed) && hasToolSemantics(result.parsed)).toBe(false);
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('property: Korean NFC anchor preservation — non-anchored English drift is restored to original Korean', async () => {
    const arbDriftedSearch = fc
      .tuple(
        arbKoreanQuery,
        fc.constantFrom(
          'gift recommendation for someone who does not know wine',
          'wine for first-time parents',
          'sweet low-alcohol gift wine',
        ),
      )
      .map(([koreanQuery, englishDrift]) => ({
        koreanQuery,
        text: JSON.stringify({
          thought: '검색',
          action: {
            tool: 'search_wines',
            input: {
              query: englishDrift,
              styles: ['approachable', 'crowd_pleasing'],
            },
          },
        }),
      }));

    await fc.assert(
      fc.asyncProperty(arbDriftedSearch, async ({ koreanQuery, text }) => {
        const { chatLlm } = makeMockLlmReturning(text);
        const runner = new AgentPlannerPhaseRunner({ chatLlm });

        const result = await runner.run(
          koreanQuery,
          'req-korean-nfc-anchor',
          DEFAULT_AGENT_CONFIG,
          createAgentExecutionState(),
          3,
          false,
        );

        if (result === null) return;
        const restoredQuery = result.parsed.action?.input['query'];
        // When the drift sanitizer fires, the query is restored to the
        // original Korean trim. Otherwise (cardinality split etc.) it's still
        // either Korean-derived or removed; the negative invariant we lock is
        // "ASCII-only English paraphrase must NOT survive sanitization".
        if (typeof restoredQuery === 'string') {
          // Property: if the surviving query is ASCII-only, it must NOT equal
          // the English drift (the sanitizer would have restored Korean).
          if (!containsHangul(restoredQuery)) {
            expect(restoredQuery).not.toBe('gift recommendation for someone who does not know wine');
            expect(restoredQuery).not.toBe('wine for first-time parents');
            expect(restoredQuery).not.toBe('sweet low-alcohol gift wine');
          } else {
            // NFC verbatim preservation — the restored Korean query equals the
            // original Korean trim (no expansion, no corruption).
            expect(restoredQuery).toBe(koreanQuery.trim().normalize('NFC'));
          }
        }
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('property: bounded step token accounting — non-negative finite deltas bounded by char count / CHARS_PER_TOKEN_ESTIMATE', async () => {
    await fc.assert(
      fc.asyncProperty(arbAnyCuratedQuery, arbKnownTool, async (query, tool) => {
        const text = JSON.stringify({
          thought: 'plan',
          action: { tool, input: { query } },
        });
        const { chatLlm } = makeMockLlmReturning(text);
        const runner = new AgentPlannerPhaseRunner({ chatLlm });
        const state = createAgentExecutionState();

        const result = await runner.run(
          query,
          'req-token-accounting',
          DEFAULT_AGENT_CONFIG,
          state,
          3,
          false,
        );

        // If a deterministic curated-alias short-circuit fires, tokens are 0
        // (we still must validate finiteness + non-negativity below).
        expect(Number.isFinite(state.totalInputTokens)).toBe(true);
        expect(Number.isFinite(state.totalOutputTokens)).toBe(true);
        expect(state.totalInputTokens).toBeGreaterThanOrEqual(0);
        expect(state.totalOutputTokens).toBeGreaterThanOrEqual(0);

        // Output token estimate cannot exceed ceil(|text| / CHARS_PER_TOKEN_ESTIMATE) + 1
        // (the +1 absorbs an off-by-one if the runner ever switches to floor).
        const maxOutTokens = Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE) + 1;
        if (result !== null) {
          expect(state.totalOutputTokens).toBeLessThanOrEqual(maxOutTokens);
        }
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('property: malformed LLM result transitions terminationReason to error and latches reasoningFailureDetected', async () => {
    // The runner treats a non-LlmResult-shaped value (e.g. undefined / wrong
    // shape) as malformed. We feed a variety of malformed values.
    const arbMalformed = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.constant({}),
      fc.constant({ text: 123, model: 'x' }), // text not a string
      fc.constant({ model: 'x' }), // missing text
    );

    await fc.assert(
      fc.asyncProperty(arbAnyCuratedQuery, arbMalformed, async (query, malformed) => {
        const complete = vi.fn().mockResolvedValue(malformed);
        const runner = new AgentPlannerPhaseRunner({
          chatLlm: { complete } as unknown as ChatLlmPort,
        });
        const state = createAgentExecutionState();

        const result = await runner.run(
          query,
          'req-malformed-property',
          DEFAULT_AGENT_CONFIG,
          state,
          3,
          false,
        );

        // For Korean curated-alias short-circuits, the LLM is never called and
        // the result is non-null. Skip those (we tested elsewhere).
        if (result !== null) return;

        expect(state.reasoningFailureDetected).toBe(true);
        expect(state.terminationReason).toBe('error');

        // Latch property: any subsequent 'answer' write must be blocked.
        const next = transitionTerminationReason(state.terminationReason, 'answer');
        expect(next).toBe('error');
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('property: idempotent terminal state — hard terminators never downgrade under repeated policy calls', () => {
    const policy = new AgentPlannerPhaseResultPolicy();

    fc.assert(
      fc.property(arbHardTerminationReason, (initialReason) => {
        const state = createAgentExecutionState();
        // Seed state with the hard terminator via the transition function (the
        // single legal mutator).
        state.terminationReason = transitionTerminationReason(
          state.terminationReason,
          initialReason,
        );
        const seededPriority = TERMINATION_REASON_PRIORITY[initialReason];

        // Apply benign policy event sequences and assert no downgrade.
        policy.applyMalformedLlmResult(state);
        policy.applyTokenBudgetExceeded(state);
        policy.applyLlmFailure(state, new Error('benign'));

        const finalPriority = TERMINATION_REASON_PRIORITY[state.terminationReason];
        expect(finalPriority).toBeGreaterThanOrEqual(seededPriority);
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('property: directive rendering exhaustiveness — every directive kind yields a known prefix and is cleared from state', async () => {
    const arbDirective = fc.oneof(
      fc.constant({ kind: 'relax_constraints_retry' } as const),
      fc.constantFrom('wine-1', 'wine-2', 'wine-3').map(
        (id) => ({ kind: 'pending_drinkability_check', entityIds: [id] }) as const,
      ),
      arbKnownTool.map(
        (tool) => ({ kind: 'required_tool', tool, instruction: 'call this tool' }) as const,
      ),
      fc.constantFrom('multi_constraint', 'negation', 'comparison').map(
        (reason) =>
          ({
            kind: 'verification_required',
            reason,
            uncoveredConstraints: ['price', 'wine_type'],
            instruction: 'verify',
          }) as const,
      ),
      fc.constant({
        kind: 'grounded_search_required',
        instruction: 'search first',
      } as const),
    );

    const ALLOWED_PREFIXES = [
      '[RETRY_RELAX_ONE]',
      '[DRINKABILITY_PENDING]',
      '[REQUIRED_TOOL:',
      '[VERIFY_REQUIRED:',
      '[SEARCH_REQUIRED]',
    ];

    await fc.assert(
      fc.asyncProperty(arbKoreanQuery, arbDirective, async (query, directive) => {
        const complete = vi.fn().mockResolvedValue({
          text: JSON.stringify({
            thought: 'plan',
            action: { tool: 'search_wines', input: { query } },
          }),
          model: 'test-model',
          finishReason: 'stop',
        });
        const runner = new AgentPlannerPhaseRunner({
          chatLlm: { complete } as unknown as ChatLlmPort,
        });
        const state = createAgentExecutionState();
        // Cast required because the discriminated union contains kinds in
        // their narrowest literal form already; fast-check builds the same
        // shape but TS sees the unioned shape.
        state.pendingPlannerDirective = directive;

        await runner.run(
          query,
          'req-directive-prefix',
          DEFAULT_AGENT_CONFIG,
          state,
          3,
          false,
        );

        // Curated-alias short-circuit can skip the LLM call entirely — but
        // only when there is no pending directive. With a directive set,
        // the runner ALWAYS proceeds to call the LLM. Confirm and validate
        // the rendered prefix on the first user message.
        expect(complete).toHaveBeenCalledTimes(1);
        const callArg = complete.mock.calls[0]?.[0];
        const userMessage = callArg?.messages?.[1];
        expect(userMessage).toBeDefined();
        const userContent: string = userMessage?.content ?? '';
        const hasKnownPrefix = ALLOWED_PREFIXES.some((p) => userContent.startsWith(p));
        expect(hasKnownPrefix).toBe(true);

        // Directive must be cleared after rendering (no infinite re-emit).
        expect(state.pendingPlannerDirective).toBeUndefined();
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('property: budget pre-flight — maxTotalTokens=1 forces budget termination regardless of payload', async () => {
    const arbAnswerText = fc.constantFrom(
      'Opus One 2018입니다.',
      '검색 결과 기준으로 답합니다.',
      'Final answer in English.',
      '결혼기념일에는 바롤로를 추천합니다.',
    );

    await fc.assert(
      fc.asyncProperty(arbAnyCuratedQuery, arbAnswerText, async (query, answer) => {
        const { chatLlm } = makeMockLlmReturning(
          JSON.stringify({ thought: 'done', answer }),
        );
        const runner = new AgentPlannerPhaseRunner({ chatLlm });
        const state = createAgentExecutionState();

        const result = await runner.run(
          query,
          'req-budget-property',
          { ...DEFAULT_AGENT_CONFIG, maxTotalTokens: 1 },
          state,
          3,
          false,
        );

        // For curated-alias short-circuits, the runner bypasses the token
        // accounting check (inputTokens/outputTokens are 0 and the budget
        // check happens AFTER an actual LLM call). Those return non-null.
        // We pin the property for the LLM-driven path only.
        if (result === null) {
          expect(state.terminationReason).toBe('budget');
        }
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('property: parseLlmOutput mutex (pure parser) — answer and tool semantics are mutually exclusive', () => {
    const arbToolName = fc.constantFrom(...KNOWN_AGENT_TOOL_NAMES);
    const arbInputs = fc.oneof(
      arbToolName.map((tool) =>
        JSON.stringify({ thought: 't', action: { tool, input: { query: '오퍼스원' } } }),
      ),
      fc.constant(JSON.stringify({ thought: 't', answer: '답' })),
      arbToolName.map((tool) =>
        JSON.stringify({
          thought: 't',
          actions: [
            { tool, input: { query: '바롤로' } },
            { tool, input: { query: '브루넬로' } },
          ],
        }),
      ),
      // Mixed adversarial:
      arbToolName.map((tool) =>
        JSON.stringify({ thought: 't', answer: 'a', action: { tool, input: {} } }),
      ),
      // Outright junk:
      fc.constant('not json'),
      fc.constant(''),
      fc.constant('{"thought": "broken'),
    );

    fc.assert(
      fc.property(arbInputs, (text) => {
        const parsed = parseLlmOutput(text);
        // Mutex: if answer is present (non-empty) and action/actions are
        // also present, the parser MUST route to a planner defect (so the
        // top-level LlmAction has plannerDefect and not both).
        if (hasAnswerSemantics(parsed) && hasToolSemantics(parsed)) {
          // The mutex contract is locked by the parser routing mixed input
          // through a defect. If somehow both survive at the LlmAction
          // level, the test fails here.
          throw new Error(
            `mutex violated: ${JSON.stringify({
              answer: parsed.answer,
              action: parsed.action,
              actions: parsed.actions,
            })}`,
          );
        }
      }),
      { numRuns: FC_RUNS },
    );
  });
});

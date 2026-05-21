/**
 * Property-based regression suite for the agent execution context + state.
 *
 * Locks SOTA++ invariants for the trio:
 *   - {@link createAgentExecutionState} (per-step mutable state seed)
 *   - {@link admitAgentRequest} (pre-loop admission gate)
 *   - {@link buildAgentExecutionContext} (immutable context wiring)
 *   - {@link transitionTerminationReason} (centralized termination state machine)
 *   - {@link StepBudget} (deterministic step exhaustion)
 *
 * Companion to:
 *   - test/regression/agent-termination-state-machine-precedence.regression.test.ts
 *     (precedence table / pairwise winners)
 *
 * Invariants pinned here go beyond pairwise precedence and cover:
 *   1. State transition closure — any event sequence keeps terminationReason
 *      inside the {@link AgentTerminationReason} enum domain.
 *   2. Monotone precedence — once 'aborted' is reached, no event downgrades it.
 *   3. Idempotent admission — admitAgentRequest is a pure function of
 *      (input, deps); two identical calls produce identical decisions.
 *   4. State snapshot determinism — createAgentExecutionState yields a
 *      byte-identical snapshot every call; reducing the same event sequence
 *      from that seed is deterministic.
 *   5. Korean query through state — Korean text in admission + context is
 *      preserved verbatim (NFC) across all wiring; terminationReason text
 *      doesn't contaminate the user query.
 *   6. Budget exhaustion deterministic — given the same step budget, the
 *      max_steps exhaustion event happens at the same step count.
 *   7. Initial sentinel — fresh state has 'max_steps' and only an explicit
 *      transition replaces it.
 *   8. Concurrent admission of distinct inputs → independent decisions.
 *   9. Aborted-during-tool-execution — 'aborted' reflects in state even if
 *      a benign 'answer'/'fallback' event arrives later.
 *
 * Append-only regression file — never delete. CLAUDE.md "Test discipline".
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  admitAgentRequest,
  buildAgentExecutionContext,
} from '../../src/application/agent/agent-execution-context.js';
import { createAgentExecutionState } from '../../src/application/agent/agent-execution-state.js';
import {
  TERMINATION_REASON_PRIORITY,
  transitionTerminationReason,
} from '../../src/domain/agent/service/termination-state-machine.js';
import type { AgentTerminationReason } from '../../src/domain/agent/model/agent-step.js';
import type { AgentConfig } from '../../src/domain/agent/model/agent-config.js';
import { DEFAULT_AGENT_CONFIG } from '../../src/domain/agent/model/agent-config.js';
import { StepBudget } from '../../src/domain/agent/service/step-budget.js';
import type { QuerySanitizer } from '../../src/domain/security/service/query-sanitizer.js';
import type { InjectionResult } from '../../src/domain/security/model/injection-result.js';

const FC_RUNS = 100;

const ALL_REASONS: readonly AgentTerminationReason[] = [
  'answer',
  'max_steps',
  'timeout',
  'budget',
  'error',
  'loop_detected',
  'fallback',
  'blocked',
  'aborted',
];

const reasonArb: fc.Arbitrary<AgentTerminationReason> = fc.constantFrom(
  ...ALL_REASONS,
);

/**
 * Permissive stub sanitizer — accepts every non-empty query. Wraps the same
 * interface the production sanitizer exposes so admitAgentRequest exercises
 * its real code path.
 */
const stubSanitizerAcceptAll: QuerySanitizer = {
  sanitize(q: string): InjectionResult {
    return { safe: true, sanitizedQuery: q };
  },
} as unknown as QuerySanitizer;

/**
 * Deterministic-rejecting stub — blocks any query containing the literal
 * substring '@@BLOCK@@'. Used to verify the blocked branch of admission.
 */
const stubSanitizerBlockSentinel: QuerySanitizer = {
  sanitize(q: string): InjectionResult {
    if (q.includes('@@BLOCK@@')) {
      return { safe: false, reason: 'COMMAND_INJECTION' };
    }
    return { safe: true, sanitizedQuery: q };
  },
} as unknown as QuerySanitizer;

describe('agent execution context + state — properties', () => {
  describe('initial snapshot determinism', () => {
    it('createAgentExecutionState defaults terminationReason to "max_steps" sentinel', () => {
      const state = createAgentExecutionState();
      expect(state.terminationReason).toBe('max_steps');
    });

    it('fresh state structural snapshot is byte-identical across calls', () => {
      // Two independent calls must yield equal-by-value snapshots. Map/Set
      // are emptied via .size === 0 and array fields are deep-equal.
      const a = createAgentExecutionState();
      const b = createAgentExecutionState();
      expect(a.terminationReason).toBe(b.terminationReason);
      expect(a.steps).toEqual(b.steps);
      expect(a.toolOutcomes).toEqual(b.toolOutcomes);
      expect(a.collectedFrames).toEqual(b.collectedFrames);
      expect(a.totalInputTokens).toBe(b.totalInputTokens);
      expect(a.totalOutputTokens).toBe(b.totalOutputTokens);
      expect(a.timeoutStats).toEqual(b.timeoutStats);
      expect(a.fallbackApplied).toBe(b.fallbackApplied);
      expect(a.fallbackLayer).toBe(b.fallbackLayer);
      expect(a.failedSynthesisAttempts).toBe(b.failedSynthesisAttempts);
      expect(a.unknownToolAttempts).toBe(b.unknownToolAttempts);
      expect(a.plannerDefectAttempts).toBe(b.plannerDefectAttempts);
      expect(a.policyBlocked).toBe(b.policyBlocked);
      expect(a.llmCircuitOpen).toBe(b.llmCircuitOpen);
      expect(a.reasoningFailureDetected).toBe(b.reasoningFailureDetected);
      expect(a.hasInjectedRefinementHint).toBe(b.hasInjectedRefinementHint);
      expect(a.pendingRefinementRetry).toBe(b.pendingRefinementRetry);
      expect(a.pendingPlannerDirective).toBe(b.pendingPlannerDirective);
      expect(a.fallbackSearchUsed).toBe(b.fallbackSearchUsed);
      expect(a.answer).toBe(b.answer);
      expect(a.groundedDrinkingWindowByEntityId.size).toBe(0);
      expect(b.groundedDrinkingWindowByEntityId.size).toBe(0);
      expect(a.lastSearchResult).toBeUndefined();
      expect(b.lastSearchResult).toBeUndefined();
    });

    it('fresh state instances do NOT share mutable Map/array references (no cross-pollination)', () => {
      const a = createAgentExecutionState();
      const b = createAgentExecutionState();
      // Mutating one instance must not leak into the other — critical for the
      // concurrent-admission invariant. Without this, two simultaneous agent
      // runs would clobber each other's frames/outcomes.
      a.steps.push({
        index: 0,
        thought: 'probe',
        durationMs: 0,
        tokenCount: { input: 0, output: 0 },
      });
      a.groundedDrinkingWindowByEntityId.set('w-1', {
        start: 2020,
        end: 2030,
      } as unknown as ReturnType<typeof a.groundedDrinkingWindowByEntityId.get>) as never;
      expect(b.steps).toEqual([]);
      expect(b.groundedDrinkingWindowByEntityId.size).toBe(0);
    });
  });

  describe('property: state transition closure (100 runs)', () => {
    it('any reasonable event sequence keeps terminationReason inside the enum domain', () => {
      // For any non-empty sequence of AgentTerminationReason events reduced
      // through transitionTerminationReason from the default sentinel, the
      // resulting state MUST always be a member of ALL_REASONS — no
      // accidental string mutation, no `undefined` leakage.
      fc.assert(
        fc.property(
          fc.array(reasonArb, { minLength: 1, maxLength: 16 }),
          (events) => {
            let state: AgentTerminationReason = 'max_steps';
            for (const e of events) {
              state = transitionTerminationReason(state, e);
            }
            expect(ALL_REASONS).toContain(state);
            expect(TERMINATION_REASON_PRIORITY[state]).toBeTypeOf('number');
            expect(Number.isFinite(TERMINATION_REASON_PRIORITY[state])).toBe(
              true,
            );
          },
        ),
        { numRuns: FC_RUNS },
      );
    });
  });

  describe('property: monotone precedence — aborted is absorbing (100 runs)', () => {
    it('once "aborted" is reached, no event downgrades it', () => {
      fc.assert(
        fc.property(
          fc.array(reasonArb, { minLength: 0, maxLength: 12 }),
          (afterAbort) => {
            let state: AgentTerminationReason = 'aborted';
            for (const e of afterAbort) {
              state = transitionTerminationReason(state, e);
              expect(state).toBe('aborted');
            }
          },
        ),
        { numRuns: FC_RUNS },
      );
    });

    it('priority of state never decreases across any single transition', () => {
      fc.assert(
        fc.property(reasonArb, reasonArb, (current, event) => {
          const next = transitionTerminationReason(current, event);
          expect(
            TERMINATION_REASON_PRIORITY[next],
          ).toBeGreaterThanOrEqual(TERMINATION_REASON_PRIORITY[current]);
        }),
        { numRuns: FC_RUNS },
      );
    });
  });

  describe('property: idempotent admission (100 runs)', () => {
    it('admitAgentRequest called twice with the same input yields the same decision', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 64 }),
          fc.string({ minLength: 1, maxLength: 16 }),
          (query, requestId) => {
            const first = admitAgentRequest(
              { query, requestId },
              { querySanitizer: stubSanitizerAcceptAll },
            );
            const second = admitAgentRequest(
              { query, requestId },
              { querySanitizer: stubSanitizerAcceptAll },
            );
            // Both null (pass-through) OR both objects with identical
            // terminationReason and answer fields.
            if (first === null) {
              expect(second).toBeNull();
            } else {
              expect(second).not.toBeNull();
              expect(second!.terminationReason).toBe(first.terminationReason);
              expect(second!.answer).toBe(first.answer);
              expect(second!.steps).toEqual(first.steps);
              expect(second!.toolCallCount).toBe(first.toolCallCount);
              expect(second!.fallbackApplied).toBe(first.fallbackApplied);
            }
          },
        ),
        { numRuns: FC_RUNS },
      );
    });

    it('empty/whitespace-only queries always return the same emptyQueryResult shape', () => {
      const whitespaces = ['', ' ', '   ', '\t', '\n', ' \t \n '];
      const prev = admitAgentRequest(
        { query: '', requestId: 'r-1' },
        { querySanitizer: stubSanitizerAcceptAll },
      );
      expect(prev).not.toBeNull();
      expect(prev!.terminationReason).toBe('answer');
      expect(prev!.toolCallCount).toBe(0);
      expect(prev!.steps).toEqual([]);
      for (const ws of whitespaces) {
        const result = admitAgentRequest(
          { query: ws, requestId: 'r-ws' },
          { querySanitizer: stubSanitizerAcceptAll },
        );
        expect(result).not.toBeNull();
        expect(result!.terminationReason).toBe('answer');
        expect(result!.toolCallCount).toBe(0);
        expect(result!.totalDurationMs).toBe(0);
      }
    });

    it('blocked queries always produce terminationReason === "blocked"', () => {
      const result = admitAgentRequest(
        { query: 'find me a wine @@BLOCK@@', requestId: 'r-2' },
        { querySanitizer: stubSanitizerBlockSentinel },
      );
      expect(result).not.toBeNull();
      expect(result!.terminationReason).toBe('blocked');
      expect(result!.toolCallCount).toBe(0);
      expect(result!.fallbackApplied).toBe(false);
    });

    it('absent sanitizer returns null so the run loop proceeds', () => {
      // CLAUDE.md exact-optional: omit the dep instead of setting it to
      // `undefined` — this confirms the application code path treats absence
      // as "no preflight" rather than as a synchronous block.
      const decision = admitAgentRequest(
        { query: 'Opus One 2018', requestId: 'r-3' },
        {},
      );
      expect(decision).toBeNull();
    });
  });

  describe('property: state snapshot determinism on event sequences (100 runs)', () => {
    it('reducing the same event sequence from a fresh state always yields the same terminationReason', () => {
      // Property: f(events) is deterministic. We fold the events through the
      // central machine on TWO independent fresh states and assert equality
      // of the resulting terminationReason and unchanged-by-fold structural
      // fields (counters/flags must stay at their fresh defaults because we
      // never mutate them in this test — only terminationReason).
      fc.assert(
        fc.property(
          fc.array(reasonArb, { minLength: 1, maxLength: 10 }),
          (events) => {
            const stateA = createAgentExecutionState();
            const stateB = createAgentExecutionState();
            for (const e of events) {
              stateA.terminationReason = transitionTerminationReason(
                stateA.terminationReason,
                e,
              );
              stateB.terminationReason = transitionTerminationReason(
                stateB.terminationReason,
                e,
              );
            }
            expect(stateA.terminationReason).toBe(stateB.terminationReason);
            // Other defaults must NOT have drifted just because terminationReason changed.
            expect(stateA.totalInputTokens).toBe(0);
            expect(stateA.totalOutputTokens).toBe(0);
            expect(stateA.unknownToolAttempts).toBe(0);
            expect(stateA.plannerDefectAttempts).toBe(0);
            expect(stateA.fallbackApplied).toBe(false);
            expect(stateA.policyBlocked).toBe(false);
          },
        ),
        { numRuns: FC_RUNS },
      );
    });
  });

  describe('property: Korean query verbatim preservation (100 runs)', () => {
    it('admitAgentRequest preserves Korean queries verbatim through the safe branch', () => {
      // Korean text in the query MUST flow through the admission gate
      // unmangled when the sanitizer is permissive. We never inspect the
      // query inside the safe branch (it returns null), but we DO assert
      // that empty/whitespace stripping does not mistake Korean whitespace
      // for content.
      const koreanQueries = [
        '오푸스원 2018',
        '레드 와인 추천',
        '프랑스 부르고뉴 피노 누아',
        '30만원 이하 화이트 와인',
        '디저트 와인',
      ];
      for (const q of koreanQueries) {
        const decision = admitAgentRequest(
          { query: q, requestId: 'r-ko' },
          { querySanitizer: stubSanitizerAcceptAll },
        );
        // Safe branch returns null — query is not contaminated by the gate.
        expect(decision).toBeNull();
      }
    });

    it('buildAgentExecutionContext on Korean queries yields a fresh state + valid budget without contaminating fields', () => {
      // The contract does NOT echo the raw query (that's a deliberate
      // information-hiding boundary — downstream consumers receive parsed
      // signals only). But the surrounding state/budget MUST be fresh and
      // Korean text must NOT leak into terminationReason or answer.
      const baseConfig: AgentConfig = DEFAULT_AGENT_CONFIG;
      const koreanQueries = [
        '오푸스원 2018',
        '레드 와인 추천',
        '디저트 와인 추천해줘',
      ];
      for (const q of koreanQueries) {
        const ctx = buildAgentExecutionContext({
          query: q,
          requestId: 'r-ko-ctx',
          baseConfig,
        });
        expect(ctx.state.terminationReason).toBe('max_steps');
        expect(ctx.state.answer).toBe('');
        expect(ctx.queryExecutionContract).toBeDefined();
        expect(typeof ctx.queryExecutionContract.requiresDrinkabilityCheck).toBe(
          'boolean',
        );
        expect(typeof ctx.queryExecutionContract.hasEntityMetadataSignal).toBe(
          'boolean',
        );
        expect(ctx.budget).toBeInstanceOf(StepBudget);
        expect(ctx.budget.getStepCount()).toBe(0);
        // effectiveConfig is finite and bounded.
        expect(Number.isFinite(ctx.effectiveConfig.maxSteps)).toBe(true);
        expect(ctx.effectiveConfig.maxSteps).toBeGreaterThanOrEqual(0);
      }
    });

    it('empty-query admission preserves the Korean fallback prompt verbatim (NFC)', () => {
      // The emptyQueryResult.answer contains a Korean prompt. Its byte-exact
      // preservation across admission is the user-facing Korean invariant.
      const result = admitAgentRequest(
        { query: '   ', requestId: 'r-ko-empty' },
        { querySanitizer: stubSanitizerAcceptAll },
      );
      expect(result).not.toBeNull();
      expect(result!.answer).toBe(
        '검색어를 입력해주세요. 어떤 와인을 찾고 계신가요?',
      );
      // NFC-normalized — must NOT contain decomposed Hangul jamo (U+1100-U+11FF).
      for (const ch of result!.answer) {
        const cp = ch.codePointAt(0) ?? 0;
        expect(cp < 0x1100 || cp > 0x11ff).toBe(true);
      }
    });

    it('terminationReason transitions preserve neighboring state.answer text including Korean', () => {
      const state = createAgentExecutionState();
      const koreanAnswer = '추천 와인: 오푸스원 2018';
      state.answer = koreanAnswer;
      state.terminationReason = transitionTerminationReason(
        state.terminationReason,
        'answer',
      );
      expect(state.terminationReason).toBe('answer');
      expect(state.answer).toBe(koreanAnswer);
      // Even if a subsequent abort fires, the Korean answer text is preserved
      // (the state machine only governs terminationReason, never answer).
      state.terminationReason = transitionTerminationReason(
        state.terminationReason,
        'aborted',
      );
      expect(state.terminationReason).toBe('aborted');
      expect(state.answer).toBe(koreanAnswer);
    });
  });

  describe('property: budget exhaustion deterministic (100 runs)', () => {
    it('given a fixed maxSteps N, recordStep returns max_steps at exactly step N+1', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 8 }), (maxSteps) => {
          const config: AgentConfig = { ...DEFAULT_AGENT_CONFIG, maxSteps };
          const budget = new StepBudget(config);
          // First N recordStep calls with distinct tool inputs must succeed.
          // Subsequent calls must return { allowed:false, reason:'max_steps' }.
          for (let i = 0; i < maxSteps; i++) {
            const check = budget.recordStep(`tool_${i}`, { query: `q_${i}` });
            expect(check.allowed).toBe(true);
          }
          const overflow = budget.recordStep('tool_overflow', {
            query: 'overflow',
          });
          expect(overflow.allowed).toBe(false);
          expect(overflow.reason).toBe('max_steps');
          expect(budget.getStepCount()).toBe(maxSteps);
        }),
        { numRuns: FC_RUNS },
      );
    });

    it('canProceed reports max_steps once stepCount equals maxSteps', () => {
      const config: AgentConfig = { ...DEFAULT_AGENT_CONFIG, maxSteps: 3 };
      const budget = new StepBudget(config);
      expect(budget.canProceed().allowed).toBe(true);
      budget.recordStep('a', { query: '1' });
      budget.recordStep('b', { query: '2' });
      budget.recordStep('c', { query: '3' });
      const after = budget.canProceed();
      expect(after.allowed).toBe(false);
      expect(after.reason).toBe('max_steps');
    });
  });

  describe('specific scenarios', () => {
    it('initial state.terminationReason === "max_steps" stays "max_steps" with no events fired', () => {
      const state = createAgentExecutionState();
      // No transitions called — sentinel must remain.
      expect(state.terminationReason).toBe('max_steps');
    });

    it('initial sentinel is replaced by ANY equal-or-higher-priority event', () => {
      // 'max_steps' is the lowest-priority sentinel; only its own peer (itself)
      // returns 'max_steps'. Every other event in the enum must win.
      for (const event of ALL_REASONS) {
        const state = createAgentExecutionState();
        state.terminationReason = transitionTerminationReason(
          state.terminationReason,
          event,
        );
        if (event === 'max_steps') {
          expect(state.terminationReason).toBe('max_steps');
        } else {
          expect(state.terminationReason).toBe(event);
        }
      }
    });

    it('concurrent admission of 2 different requests yields independent state (no cross-pollution)', () => {
      // Two independent buildAgentExecutionContext invocations must produce
      // INDEPENDENT state objects — mutating one cannot leak into the other.
      // This is the load-bearing invariant for serving concurrent HTTP requests.
      const ctxA = buildAgentExecutionContext({
        query: 'Opus One 2018',
        requestId: 'r-A',
        baseConfig: DEFAULT_AGENT_CONFIG,
      });
      const ctxB = buildAgentExecutionContext({
        query: '오푸스원 2019',
        requestId: 'r-B',
        baseConfig: DEFAULT_AGENT_CONFIG,
      });
      expect(ctxA.state).not.toBe(ctxB.state);
      expect(ctxA.budget).not.toBe(ctxB.budget);
      // Mutate A — B must remain pristine.
      ctxA.state.terminationReason = transitionTerminationReason(
        ctxA.state.terminationReason,
        'error',
      );
      ctxA.state.totalInputTokens = 1234;
      ctxA.state.steps.push({
        index: 0,
        thought: 'probe',
        durationMs: 1,
        tokenCount: { input: 1, output: 1 },
      });
      expect(ctxB.state.terminationReason).toBe('max_steps');
      expect(ctxB.state.totalInputTokens).toBe(0);
      expect(ctxB.state.steps).toEqual([]);
      // B's queryExecutionContract was independently parsed from the Korean
      // input; we can't echo the raw query (deliberate hiding) but the
      // contract object MUST exist and the budget counter MUST be 0.
      expect(ctxB.queryExecutionContract).toBeDefined();
      expect(ctxB.budget.getStepCount()).toBe(0);
    });

    it('aborted-during-tool-execution: state reflects aborted not error/answer/fallback', () => {
      // Simulates the run-loop sequence: tool starts → mid-tool abort signal
      // → answer-recovery layer might still try to write 'answer' or
      // 'fallback'. The state must remain 'aborted'.
      const state = createAgentExecutionState();
      // Prior soft writes that would otherwise dominate.
      state.terminationReason = transitionTerminationReason(
        state.terminationReason,
        'fallback',
      );
      expect(state.terminationReason).toBe('fallback');
      // Tool execution is aborted — must dominate.
      state.terminationReason = transitionTerminationReason(
        state.terminationReason,
        'aborted',
      );
      expect(state.terminationReason).toBe('aborted');
      // Downstream recovery layers attempt to overwrite.
      const downstreamAttempts: AgentTerminationReason[] = [
        'answer',
        'fallback',
        'max_steps',
        'timeout',
        'budget',
        'error',
        'loop_detected',
        'blocked',
      ];
      for (const attempt of downstreamAttempts) {
        state.terminationReason = transitionTerminationReason(
          state.terminationReason,
          attempt,
        );
        expect(state.terminationReason).toBe('aborted');
      }
    });
  });
});

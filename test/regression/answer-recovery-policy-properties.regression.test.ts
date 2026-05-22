/**
 * Property-based regression tests for `AgentAnswerRecoveryPolicy` (SOTA++).
 *
 * The 4-layer answer recovery ladder (L1 synthesis observation → L2 single-shot
 * fallback search → L3 grounding preview → L4 absolute Korean template) is the
 * terminal stage of the agent ReAct loop. It is invoked from
 * `react-orchestrator` whenever the synthesis LLM did not commit an answer.
 *
 * The properties below pin the SOTA++ contract on top of the existing
 * scenario-style unit tests:
 *
 *   P1  Determinism — same inputs (query / state shape / search behavior)
 *       produce the same answer text and the same fallback layer.
 *   P2  Idempotence — `recover(recover(x)) === recover(x)`. Once recovery has
 *       written a non-empty answer, applying recovery again preserves both the
 *       answer text and the recorded fallback layer.
 *   P3  Non-empty guarantee — for any non-aborted, non-blocked query, the
 *       returned answer is never empty (Layer 4 is the absolute floor).
 *   P4  Bounded output — for any synthesized layer-3 raw-slice answer, the
 *       result is bounded by the documented 300-char observation slice plus
 *       the localized header.
 *   P5  Korean NFC stability — for the layered Korean templates the policy
 *       can emit, the bytes are NFC-stable (idempotent under NFC).
 *   P6  Policy-block dominance — when `state.policyBlocked === true`, the
 *       firm blocked-template is the ONLY answer the policy returns. No
 *       situational redirect (OOD alcohol / weather) and no observation
 *       fabrication is allowed to overwrite it. This is the "no silent
 *       success-fabrication from errors" rule from CLAUDE.md.
 *   P7  Abort dominance — when the caller's `AbortSignal` is already aborted
 *       OR `state.terminationReason === 'aborted'`, the policy must not
 *       fabricate a non-empty answer from situational redirects. Aborted
 *       runs return the empty string (or whatever `state.answer` already
 *       held). This is the same "no silent success-fabrication" rule.
 *   P8  Fallback-search skipped when guards fire — the injected
 *       `searchUseCase.execute` is NEVER called when ANY of:
 *       `policyBlocked`, `terminationReason === 'answer'`, `observedToolOutput`,
 *       `abortSignal.aborted` is true.
 *   P9  Termination-priority preservation — `applyFallbackAnswer` never
 *       overwrites a higher-priority termination reason (e.g. `aborted`,
 *       `blocked`) with a lower one (`fallback`, `answer`).
 *   P10 GROUNDING_JSON marker is NEVER leaked into the user-visible answer.
 *       Even when the parsed grounding payload is empty/malformed, the
 *       answer must not contain the raw `GROUNDING_JSON:` substring.
 *
 * Touch policy: regression-only / append-only. The test file MUST NOT modify
 * `agent-answer-recovery-policy.ts` directly — failing properties get fixed
 * in the policy source. fast-check `numRuns: 100` per property (industry
 * standard for invariant coverage; CLAUDE.md test discipline rule).
 *
 * Korean inputs are explicitly exercised via `fc.constantFrom` arbitraries
 * over realistic Korean query phrases. Per CLAUDE.md rule 8 the regex
 * boundaries inside the policy use `[\p{L}\p{N}]` Unicode classes — these
 * tests deliberately include Korean substrings to lock that behavior.
 */
import { describe, it, vi } from 'vitest';
import fc from 'fast-check';
import {
  AgentAnswerRecoveryPolicy,
} from '../../src/application/agent/agent-answer-recovery-policy.js';
import { createAgentExecutionState } from '../../src/application/agent/agent-execution-state.js';
import type { AgentExecutionState } from '../../src/application/agent/agent-execution-state.js';
import type { AgentTerminationReason } from '../../src/domain/agent/model/agent-step.js';
import { TERMINATION_REASON_PRIORITY } from '../../src/domain/agent/service/termination-state-machine.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';

// ────────────────────────────────────────────────────────────────────────────
// Named constants — CLAUDE.md rule 15 (no magic numbers in test fixtures).
// ────────────────────────────────────────────────────────────────────────────

/** fast-check runs per property — industry standard invariant coverage. */
const RUNS = 100;

/** The documented Layer-3 observation slice ceiling. Mirrors policy constant. */
const LAYER3_OBSERVATION_SLICE_CHARS = 300;

/** The two non-empty Korean header strings Layer 3 can prepend on a raw slice. */
const LAYER3_KO_HEADER = '검색 결과 요약: ';
const LAYER3_EN_HEADER = 'Search result summary: ';
/** Maximum Layer-3 answer length when the raw-slice path fires. */
const LAYER3_MAX_LENGTH = Math.max(LAYER3_KO_HEADER.length, LAYER3_EN_HEADER.length) + LAYER3_OBSERVATION_SLICE_CHARS;

/** Layer-4 absolute fallback template — pinned for NFC + literal checks. */
const _LAYER4_KO_TEMPLATE = '요청하신 와인 정보를 현재 처리하지 못했습니다. 검색어를 바꿔서 다시 시도해주세요.';
/** Policy-blocked firm template — pinned for dominance checks. */
const BLOCKED_KO_TEMPLATE = '이 요청은 처리할 수 없습니다. 와인 검색과 관련된 질문을 해주세요.';

// ────────────────────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────────────────────

function makeSearchResponse(overrideLabel?: string): SearchResponseV1 {
  return {
    queryType: 'search',
    results: [
      {
        entity: {
          entityId: 'wine-1',
          canonicalLabel: overrideLabel ?? 'Opus One 2018',
          type: 'wine',
          producer: 'Opus One',
          region: 'Napa Valley',
        },
        relevanceScore: 0.99,
        match: {
          matchType: 'hybrid',
          scoreComponents: {
            lexical: 0.9,
            semantic: 0.9,
            attribute: 0.8,
            popularity: 0.4,
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
      decisionConfidence: 0.92,
      confidenceSemantics: 'calibrated_decision_confidence',
      decisionTraceRef: 'trace-1',
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
      requestId: 'req-1',
      queryTimeMs: 11,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
    },
  };
}

function makePolicy(executeFn?: ReturnType<typeof vi.fn>): {
  policy: AgentAnswerRecoveryPolicy;
  execute: ReturnType<typeof vi.fn>;
  logger: { error: ReturnType<typeof vi.fn> };
} {
  const execute = executeFn ?? vi.fn().mockResolvedValue(makeSearchResponse());
  const logger = { error: vi.fn() };
  const policy = new AgentAnswerRecoveryPolicy({
    toolDeps: { searchUseCase: { execute } as never },
    logger,
  });
  return { policy, execute, logger };
}

/** Realistic Korean queries — includes pure Hangul, mixed, and known cue words. */
const KOREAN_QUERY_ARB: fc.Arbitrary<string> = fc.constantFrom(
  '오퍼스 원 추천',
  '선물용 와인',
  '저렴한 레드와인',
  '디저트와 어울리는 와인',
  '한식과 페어링',
  '여름에 마시기 좋은 화이트',
  '바롤로 알려줘',
  '입문자에게 추천하는 와인',
);

/** Latin/English queries with no special policy hooks. */
const LATIN_QUERY_ARB: fc.Arbitrary<string> = fc.constantFrom(
  'opus one 2018',
  'best red wine under 50000',
  'pairing for steak',
  'barolo vintage 2019',
  'organic biodynamic',
);

/** OOD-alcohol queries (beer / soju / whisky variants). */
const OOD_ALCOHOL_QUERY_ARB: fc.Arbitrary<string> = fc.constantFrom(
  '맥주 추천',
  'beer recommendation',
  '소주 안주',
  'whisky for beginners',
);

/** Weather/external-info queries. */
const WEATHER_QUERY_ARB: fc.Arbitrary<string> = fc.constantFrom(
  '오늘 날씨 어때',
  'tomorrow weather in seoul',
  '서울 기온 알려줘',
);

const NEUTRAL_QUERY_ARB: fc.Arbitrary<string> = fc.oneof(
  KOREAN_QUERY_ARB,
  LATIN_QUERY_ARB,
);

// All terminal-style termination reasons used in state seeding.
const _TERMINATION_REASON_ARB: fc.Arbitrary<AgentTerminationReason> = fc.constantFrom(
  'answer',
  'max_steps',
  'timeout',
  'budget',
  'error',
  'loop_detected',
  'fallback',
  'blocked',
  'aborted',
);

/** Build a fresh, well-formed AgentExecutionState seeded with optional fields. */
function buildState(opts: {
  readonly answer?: string;
  readonly policyBlocked?: boolean;
  readonly terminationReason?: AgentTerminationReason;
  readonly withSearchStep?: boolean;
  readonly observation?: string;
}): AgentExecutionState {
  const state = createAgentExecutionState();
  if (opts.answer !== undefined) state.answer = opts.answer;
  if (opts.policyBlocked === true) state.policyBlocked = true;
  if (opts.terminationReason !== undefined) state.terminationReason = opts.terminationReason;
  if (opts.withSearchStep === true) {
    state.steps.push({
      index: 0,
      thought: 'searched',
      action: { tool: 'search_wines', input: { query: 'seed' } },
      observation: opts.observation ?? '오퍼스 원 2018은 현재 마시기 좋습니다.',
      durationMs: 1,
      tokenCount: { input: 1, output: 1 },
    });
  } else if (opts.observation !== undefined) {
    state.steps.push({
      index: 0,
      thought: 'searched',
      observation: opts.observation,
      durationMs: 1,
      tokenCount: { input: 1, output: 1 },
    });
  }
  return state;
}

// ────────────────────────────────────────────────────────────────────────────
// P1 — Determinism
// ────────────────────────────────────────────────────────────────────────────

describe('AgentAnswerRecoveryPolicy property — P1 determinism', () => {
  it('returns the same answer for the same inputs (no nondeterminism)', async () => {
    await fc.assert(
      fc.asyncProperty(NEUTRAL_QUERY_ARB, async (query) => {
        const responseA = makeSearchResponse();
        const responseB = makeSearchResponse();
        const { policy: a } = makePolicy(vi.fn().mockResolvedValue(responseA));
        const { policy: b } = makePolicy(vi.fn().mockResolvedValue(responseB));
        const stateA = buildState({ withSearchStep: false });
        const stateB = buildState({ withSearchStep: false });
        const ans1 = await a.recoverAnswer(query, 'req-d-1', stateA, false);
        const ans2 = await b.recoverAnswer(query, 'req-d-1', stateB, false);
        return ans1 === ans2;
      }),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P2 — Idempotence
// ────────────────────────────────────────────────────────────────────────────

describe('AgentAnswerRecoveryPolicy property — P2 idempotence', () => {
  it('recover(recover(x)) preserves the non-empty answer and fallback layer', async () => {
    await fc.assert(
      fc.asyncProperty(NEUTRAL_QUERY_ARB, async (query) => {
        const { policy } = makePolicy();
        const state = buildState({});
        const first = await policy.recoverAnswer(query, 'req-idem', state, false);
        const firstLayer = state.fallbackLayer;
        const second = await policy.recoverAnswer(query, 'req-idem', state, false);
        return first === second && state.fallbackLayer === firstLayer;
      }),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P3 — Non-empty guarantee (Layer 4 floor)
// ────────────────────────────────────────────────────────────────────────────

describe('AgentAnswerRecoveryPolicy property — P3 non-empty guarantee', () => {
  it('returns a non-empty answer for any non-aborted, non-blocked query', async () => {
    await fc.assert(
      fc.asyncProperty(NEUTRAL_QUERY_ARB, async (query) => {
        const { policy } = makePolicy(vi.fn().mockRejectedValue(new Error('backend down')));
        const state = buildState({});
        const answer = await policy.recoverAnswer(query, 'req-nonempty', state, false);
        return answer.length > 0;
      }),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P4 — Bounded output (Layer 3 raw slice)
// ────────────────────────────────────────────────────────────────────────────

describe('AgentAnswerRecoveryPolicy property — P4 bounded output', () => {
  it('Layer-3 raw-slice answers respect the 300-char observation cap', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 305, max: 5_000 }),
        fc.constantFrom('가', 'A', 'é'),
        async (len, ch) => {
          const observation = ch.repeat(len); // no GROUNDING_JSON marker → raw slice path
          const { policy } = makePolicy();
          const state = buildState({ observation });
          const answer = await policy.recoverAnswer('오퍼스 원', 'req-bound', state, true);
          return answer.length <= LAYER3_MAX_LENGTH;
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P5 — Korean NFC stability
// ────────────────────────────────────────────────────────────────────────────

describe('AgentAnswerRecoveryPolicy property — P5 Korean NFC stability', () => {
  it('every emitted Korean template is NFC-stable', async () => {
    await fc.assert(
      fc.asyncProperty(KOREAN_QUERY_ARB, async (query) => {
        const { policy } = makePolicy(vi.fn().mockRejectedValue(new Error('backend down')));
        const state = buildState({});
        const answer = await policy.recoverAnswer(query, 'req-nfc', state, false);
        return answer === answer.normalize('NFC');
      }),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P6 — Policy-block dominance
// ────────────────────────────────────────────────────────────────────────────

describe('AgentAnswerRecoveryPolicy property — P6 policy-block dominance', () => {
  it('blocked queries return the firm template regardless of OOD/weather hooks', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(NEUTRAL_QUERY_ARB, OOD_ALCOHOL_QUERY_ARB, WEATHER_QUERY_ARB),
        fc.boolean(),
        async (query, observedToolOutput) => {
          const { policy, execute } = makePolicy();
          const state = buildState({ policyBlocked: true });
          const answer = await policy.recoverAnswer(query, 'req-blocked', state, observedToolOutput);
          // No fallback search may run; the firm template dominates.
          if (execute.mock.calls.length !== 0) return false;
          return answer === BLOCKED_KO_TEMPLATE;
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P7 — Abort dominance (no silent success-fabrication)
// ────────────────────────────────────────────────────────────────────────────

describe('AgentAnswerRecoveryPolicy property — P7 abort dominance', () => {
  it('aborted queries never fabricate a non-empty answer via situational redirects', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(NEUTRAL_QUERY_ARB, OOD_ALCOHOL_QUERY_ARB, WEATHER_QUERY_ARB),
        async (query) => {
          const { policy, execute } = makePolicy();
          const state = buildState({ terminationReason: 'error' });
          const abortController = new AbortController();
          abortController.abort();
          const answer = await policy.recoverAnswer(
            query,
            'req-aborted',
            state,
            false,
            abortController.signal,
          );
          if (execute.mock.calls.length !== 0) return false;
          // The state.answer started empty; aborted contract requires no fabrication.
          return answer === '';
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P8 — Fallback-search skipped when guards fire
// ────────────────────────────────────────────────────────────────────────────

describe('AgentAnswerRecoveryPolicy property — P8 fallback-search guard', () => {
  it('skips searchUseCase.execute when ANY guard would forbid it', async () => {
    await fc.assert(
      fc.asyncProperty(
        NEUTRAL_QUERY_ARB,
        fc.boolean(), // policyBlocked
        fc.constantFrom<AgentTerminationReason>('answer', 'aborted', 'blocked'),
        fc.boolean(), // observedToolOutput
        async (query, policyBlocked, terminationReason, observedToolOutput) => {
          const { policy, execute } = makePolicy();
          const state = buildState({
            policyBlocked,
            terminationReason,
          });
          await policy.recoverAnswer(query, 'req-guard', state, observedToolOutput);
          return execute.mock.calls.length === 0;
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P9 — Termination-priority preservation
// ────────────────────────────────────────────────────────────────────────────

describe('AgentAnswerRecoveryPolicy property — P9 termination priority preserved', () => {
  it('higher-priority termination reasons are never downgraded by recovery', async () => {
    // We only assert non-downgrade for reasons strictly ABOVE 'fallback' (the
    // highest reason recovery is allowed to write). Equal-priority transitions
    // are allowed by the state machine. The set is DERIVED from the FSM's SSoT
    // priority map so it can never drift from the source ranking — this is the
    // hard-failure class (aborted/blocked/error/loop_detected). Resource limits
    // (budget/timeout) rank BELOW completions by design (termination-state-
    // machine.ts Class 2 > Class 3): a fallback answer that "came through
    // anyway" legitimately supersedes them, so they are NOT in this set.
    const fallbackPriority = TERMINATION_REASON_PRIORITY['fallback'];
    const HIGH_PRIORITY: readonly AgentTerminationReason[] = (
      Object.keys(TERMINATION_REASON_PRIORITY) as AgentTerminationReason[]
    ).filter((reason) => TERMINATION_REASON_PRIORITY[reason] > fallbackPriority);
    await fc.assert(
      fc.asyncProperty(
        NEUTRAL_QUERY_ARB,
        fc.constantFrom<AgentTerminationReason>(...HIGH_PRIORITY),
        async (query, seedReason) => {
          const { policy } = makePolicy(vi.fn().mockRejectedValue(new Error('down')));
          const state = buildState({ terminationReason: seedReason });
          await policy.recoverAnswer(query, 'req-prio', state, false);
          // Recovery may write 'fallback' or 'answer' — never above seedReason.
          return state.terminationReason === seedReason;
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P10 — GROUNDING_JSON marker never leaks
// ────────────────────────────────────────────────────────────────────────────

describe('AgentAnswerRecoveryPolicy property — P10 GROUNDING_JSON never leaks', () => {
  it('the GROUNDING_JSON marker never appears in user-visible answers', async () => {
    // Three shapes: (a) well-formed JSON with wines, (b) empty wines array,
    // (c) malformed JSON after the marker. The policy must NOT echo the
    // marker substring in any of these cases.
    const payloadArb = fc.constantFrom(
      'Found 1\nGROUNDING_JSON: {"wines":[{"canonical_label":"Opus One 2018","region":"Napa Valley","grapes":["Cabernet"],"price":"420000원"}]}',
      'Found 0\nGROUNDING_JSON: {"wines":[]}',
      'Found 0\nGROUNDING_JSON: {not-json}',
      'Found 0\nGROUNDING_JSON: ',
    );
    await fc.assert(
      fc.asyncProperty(KOREAN_QUERY_ARB, payloadArb, async (query, observation) => {
        const { policy } = makePolicy();
        const state = buildState({ observation });
        const answer = await policy.recoverAnswer(query, 'req-marker', state, true);
        return !answer.includes('GROUNDING_JSON');
      }),
      { numRuns: RUNS },
    );
  });
});

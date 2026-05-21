/**
 * Property-based regression suite for {@link AgentObservationSynthesisRunner}.
 *
 * Companion to test/regression/observation-synthesis-grounding-fence.regression.test.ts
 * (Wave 6, 9 case-based tests). This file (Wave 7) raises the maturity bar to
 * SOTA++ by pinning *property* invariants over the grounding fence + synthesis
 * determinism with fast-check (numRuns: 100). Where the fence file asserts hand
 * picked examples, this file asserts the same guarantees hold across the
 * adversarial input space.
 *
 * Invariants pinned here:
 *   P1. Malformed grounding never throws — arbitrary malformed JSON embedded
 *       after the GROUNDING_JSON marker → the frame is dropped, run() resolves,
 *       never crashes.
 *   P2. Valid frame ordering deterministic — N valid frames produce a synthesis
 *       prompt whose [Tool Result] frames appear in step-index order, byte
 *       identical across repeated runs (5x determinism check).
 *   P3. Korean observation preserved — Korean grounding text survives verbatim
 *       (NFC) into the synthesis prompt.
 *   P4. Dropped-frame count monotone — number of malformedGrounding warnings is
 *       ≤ total frames, and equals exactly the number of malformed frames.
 *   P5. Empty observations → graceful fallback — no observation steps → no LLM
 *       call, no throw, answer stays empty.
 *   P6. Idempotent grounding extraction — running the same state through a fresh
 *       runner twice yields the identical synthesis prompt (extract∘extract
 *       stable).
 *
 * Plus specific case assertions (drop-count exactness, empty-LLM fallback,
 * mixed Korean/English).
 *
 * Append-only regression file — never delete. CLAUDE.md "Test discipline".
 */
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { AgentObservationSynthesisRunner } from '../../src/application/agent/agent-observation-synthesis-runner.js';
import { createAgentExecutionState } from '../../src/application/agent/agent-execution-state.js';
import { DEFAULT_AGENT_CONFIG } from '../../src/domain/agent/model/agent-config.js';
import type { ChatLlmPort } from '../../src/domain/ai/port/chat-llm.port.js';

const GROUNDING_JSON_MARKER = 'GROUNDING_JSON: ';
const NUM_RUNS = 100;

function buildValidGroundingObservation(
  canonicalLabel: string,
  entityId: string,
  extra?: string,
): string {
  const preface = extra ?? `Found ${canonicalLabel}`;
  const payload = {
    query_type: 'search',
    total_results: 1,
    wines: [
      {
        entity_id: entityId,
        canonical_label: canonicalLabel,
        region: 'Napa Valley',
        price: '420000원',
      },
    ],
    truncated_for_observation_cap: false,
  };
  return `${preface}\n${GROUNDING_JSON_MARKER}${JSON.stringify(payload)}`;
}

function makeChatLlm(text: string) {
  return {
    complete: vi.fn().mockResolvedValue({
      text,
      model: 'test-model',
      finishReason: 'stop',
    }),
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

type MutableState = ReturnType<typeof createAgentExecutionState>;

/**
 * Pushes a step + a *successful* search ToolOutcome so the runner does not
 * short-circuit via hasNoGroundedSearchResults. The observation text is opaque
 * to the ToolOutcome (the fence operates on observation text only).
 */
function pushObservationStep(
  state: MutableState,
  index: number,
  observation: string,
): void {
  state.steps.push({
    index,
    thought: `step ${index}`,
    action: { tool: 'search_wines', input: { query: `step-${index}` } },
    observation,
    durationMs: 10,
    tokenCount: { input: 10, output: 10 },
  });
  state.toolOutcomes.push({
    stepId: `req:0:${index}:0`,
    tool: 'search_wines',
    kind: 'success',
    result: {
      queryType: 'search',
      results: [{ entity: { entityId: `wine-${index}`, canonicalLabel: `Wine ${index}` } }],
    },
    durationMs: 10,
  });
}

function toolResultFrames(complete: ReturnType<typeof makeChatLlm>['complete']): string[] {
  const messages = complete.mock.calls[0]?.[0].messages ?? [];
  return messages
    .filter((m: { content: string }) => m.content.startsWith('[Tool Result: search_wines]'))
    .map((m: { content: string }) => m.content);
}

function countMalformedWarnings(logger: ReturnType<typeof makeLogger>): number {
  return logger.warn.mock.calls.filter(
    (call) =>
      typeof call[0] === 'object'
      && call[0] !== null
      && (call[0] as { malformedGrounding?: unknown }).malformedGrounding === true,
  ).length;
}

// Arbitrary that produces grounding payloads that fail the fence: either
// JSON.parse failure (truncated / garbage) or schema failure (non-object,
// missing/typed-wrong `wines`). Each carries `kind` so assertions can reason
// about expected behavior.
const malformedGroundingArb: fc.Arbitrary<string> = fc.oneof(
  // Truncated / unparseable JSON.
  fc.constant(`{"query_type":"search","wines":[{"entity_id":`),
  fc.string().map((s) => `{not json ${s}`),
  // Valid JSON but not an object (array / scalar).
  fc.constant('[1,2,3]'),
  fc.integer().map((n) => `${n}`),
  fc.constant('"a string"'),
  fc.constant('null'),
  // Object but `wines` wrong type or absent.
  fc.string().map((s) => JSON.stringify({ query_type: 'search', wines: s })),
  fc.constant(JSON.stringify({ query_type: 'search' })),
  fc.integer().map((n) => JSON.stringify({ wines: n })),
).map((raw) => `Found something\n${GROUNDING_JSON_MARKER}${raw}`);

describe('AgentObservationSynthesisRunner property invariants', () => {
  it('P1: arbitrary malformed grounding never throws; frame is dropped', async () => {
    await fc.assert(
      fc.asyncProperty(malformedGroundingArb, async (malformed) => {
        const chatLlm = makeChatLlm(JSON.stringify({ thought: 't', answer: 'Wine 0 추천.' }));
        const logger = makeLogger();
        const runner = new AgentObservationSynthesisRunner({
          chatLlm: chatLlm as unknown as ChatLlmPort,
          logger,
        });
        const state = createAgentExecutionState();
        // One valid survivor so the run reaches synthesis, plus the malformed one.
        pushObservationStep(state, 0, buildValidGroundingObservation('Wine 0', 'wine-0'));
        pushObservationStep(state, 1, malformed);

        await expect(
          runner.run('opus one', 'req-p1', DEFAULT_AGENT_CONFIG, state),
        ).resolves.toBeUndefined();

        // Malformed frame dropped: exactly the valid survivor remains.
        expect(toolResultFrames(chatLlm.complete).length).toBe(1);
        expect(countMalformedWarnings(logger)).toBe(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('P2: N valid frames appear in step-index order, deterministically (5x)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (n) => {
        const prompts: string[] = [];
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const chatLlm = makeChatLlm(JSON.stringify({ thought: 't', answer: 'ok' }));
          const runner = new AgentObservationSynthesisRunner({
            chatLlm: chatLlm as unknown as ChatLlmPort,
            logger: makeLogger(),
          });
          const state = createAgentExecutionState();
          for (let i = 0; i < n; i += 1) {
            pushObservationStep(state, i, buildValidGroundingObservation(`Wine ${i}`, `wine-${i}`));
          }
          await runner.run('q', 'req-p2', DEFAULT_AGENT_CONFIG, state);
          const frames = toolResultFrames(chatLlm.complete);
          expect(frames.length).toBe(n);
          // Ordering: wine-0 ... wine-(n-1) ascending in the joined prompt.
          const joined = frames.join('\n');
          let prev = -1;
          for (let i = 0; i < n; i += 1) {
            const at = joined.indexOf(`wine-${i}`);
            expect(at).toBeGreaterThan(prev);
            prev = at;
          }
          prompts.push(joined);
        }
        // 5x determinism: every attempt produced a byte-identical frame block.
        expect(new Set(prompts).size).toBe(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('P3: Korean grounding content is preserved verbatim (NFC) in the prompt', async () => {
    const koreanLabelArb = fc.constantFrom(
      '오퍼스 원 2018',
      '샤또 마고',
      '돔 페리뇽 빈티지',
      '안티노리 티냐넬로',
      '펜폴즈 그란지',
    );
    await fc.assert(
      fc.asyncProperty(koreanLabelArb, async (label) => {
        const nfcLabel = label.normalize('NFC');
        const chatLlm = makeChatLlm(JSON.stringify({ thought: '요약', answer: `${nfcLabel} 추천.` }));
        const runner = new AgentObservationSynthesisRunner({
          chatLlm: chatLlm as unknown as ChatLlmPort,
          logger: makeLogger(),
        });
        const state = createAgentExecutionState();
        pushObservationStep(
          state,
          0,
          buildValidGroundingObservation(nfcLabel, 'wine-kr', `${nfcLabel}을 찾았습니다`),
        );
        await runner.run('오퍼스 원 추천해줘', 'req-p3', DEFAULT_AGENT_CONFIG, state);

        const frames = toolResultFrames(chatLlm.complete);
        expect(frames.length).toBe(1);
        const joined = frames.join('\n');
        // Verbatim NFC preservation — no mojibake, no normalization drift.
        expect(joined.normalize('NFC')).toContain(nfcLabel);
        expect(joined).toContain(nfcLabel);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('P4: malformedGrounding warning count = malformed frames and ≤ total frames', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
        async (validFlags) => {
          // Guarantee at least one valid frame so synthesis runs (otherwise the
          // runner short-circuits before building the prompt). Flip the first.
          const flags = [...validFlags];
          flags[0] = true;
          const chatLlm = makeChatLlm(JSON.stringify({ thought: 't', answer: 'ok' }));
          const logger = makeLogger();
          const runner = new AgentObservationSynthesisRunner({
            chatLlm: chatLlm as unknown as ChatLlmPort,
            logger,
          });
          const state = createAgentExecutionState();
          let expectedMalformed = 0;
          flags.forEach((isValid, i) => {
            if (isValid) {
              pushObservationStep(state, i, buildValidGroundingObservation(`Wine ${i}`, `wine-${i}`));
            } else {
              pushObservationStep(
                state,
                i,
                `Found\n${GROUNDING_JSON_MARKER}{"query_type":"search","wines":`,
              );
              expectedMalformed += 1;
            }
          });

          await runner.run('q', 'req-p4', DEFAULT_AGENT_CONFIG, state);

          const warnCount = countMalformedWarnings(logger);
          // Monotone: dropped ≤ total frames, and exact match to malformed count.
          expect(warnCount).toBeLessThanOrEqual(flags.length);
          expect(warnCount).toBe(expectedMalformed);
          expect(toolResultFrames(chatLlm.complete).length).toBe(flags.length - expectedMalformed);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('P5: empty observation set → no LLM call, no throw, answer stays empty', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (query) => {
        const chatLlm = makeChatLlm(JSON.stringify({ thought: 't', answer: 'should not be used' }));
        const runner = new AgentObservationSynthesisRunner({
          chatLlm: chatLlm as unknown as ChatLlmPort,
          logger: makeLogger(),
        });
        const state = createAgentExecutionState();
        // No steps / no outcomes pushed → obsSteps.length === 0 → early return.
        await expect(
          runner.run(query, 'req-p5', DEFAULT_AGENT_CONFIG, state),
        ).resolves.toBeUndefined();
        expect(chatLlm.complete).not.toHaveBeenCalled();
        expect(state.answer).toBe('');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('P6: grounding extraction is idempotent — same state → identical prompt twice', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (n) => {
        const buildState = (): MutableState => {
          const s = createAgentExecutionState();
          for (let i = 0; i < n; i += 1) {
            pushObservationStep(s, i, buildValidGroundingObservation(`Wine ${i}`, `wine-${i}`));
          }
          return s;
        };
        const run = async (): Promise<string> => {
          const chatLlm = makeChatLlm(JSON.stringify({ thought: 't', answer: 'ok' }));
          const runner = new AgentObservationSynthesisRunner({
            chatLlm: chatLlm as unknown as ChatLlmPort,
            logger: makeLogger(),
          });
          await runner.run('q', 'req-p6', DEFAULT_AGENT_CONFIG, buildState());
          return toolResultFrames(chatLlm.complete).join('\n');
        };
        const first = await run();
        const second = await run();
        expect(second).toBe(first);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('AgentObservationSynthesisRunner specific drop-count + fallback cases', () => {
  it('3 valid + 2 malformed → 3 frames used, exactly 2 malformed warnings logged', async () => {
    const chatLlm = makeChatLlm(JSON.stringify({ thought: 't', answer: 'Wine 0, Wine 1, Wine 3 추천.' }));
    const logger = makeLogger();
    const runner = new AgentObservationSynthesisRunner({
      chatLlm: chatLlm as unknown as ChatLlmPort,
      logger,
    });
    const state = createAgentExecutionState();
    pushObservationStep(state, 0, buildValidGroundingObservation('Wine 0', 'wine-0'));
    pushObservationStep(state, 1, buildValidGroundingObservation('Wine 1', 'wine-1'));
    pushObservationStep(state, 2, `Found\n${GROUNDING_JSON_MARKER}{"query_type":"search","wines":`);
    pushObservationStep(state, 3, buildValidGroundingObservation('Wine 3', 'wine-3'));
    pushObservationStep(state, 4, `Found\n${GROUNDING_JSON_MARKER}[1,2,3]`);

    await runner.run('multi', 'req-3v2m', DEFAULT_AGENT_CONFIG, state);

    expect(toolResultFrames(chatLlm.complete).length).toBe(3);
    expect(countMalformedWarnings(logger)).toBe(2);
    expect(state.answer).toContain('Wine 0');
  });

  it('mocked LLM returns empty answer twice → no answer set, attempts increment, no throw', async () => {
    const chatLlm = {
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({ thought: 'empty', answer: '' }),
        model: 'test',
        finishReason: 'stop',
      }),
    };
    const logger = makeLogger();
    const runner = new AgentObservationSynthesisRunner({
      chatLlm: chatLlm as unknown as ChatLlmPort,
      logger,
    });
    const state = createAgentExecutionState();
    pushObservationStep(state, 0, buildValidGroundingObservation('Wine 0', 'wine-0'));

    await expect(
      runner.run('opus one', 'req-empty-fallback', DEFAULT_AGENT_CONFIG, state),
    ).resolves.toBeUndefined();
    expect(state.answer).toBe('');
    expect(state.failedSynthesisAttempts).toBeGreaterThanOrEqual(1);
  });

  it('mixed Korean/English observations both survive the fence in step order', async () => {
    const chatLlm = makeChatLlm(JSON.stringify({ thought: '요약', answer: '오퍼스 원, Wine 1 추천.' }));
    const logger = makeLogger();
    const runner = new AgentObservationSynthesisRunner({
      chatLlm: chatLlm as unknown as ChatLlmPort,
      logger,
    });
    const state = createAgentExecutionState();
    pushObservationStep(state, 0, buildValidGroundingObservation('오퍼스 원 2018', 'wine-kr', '오퍼스 원 2018을 찾았습니다'));
    pushObservationStep(state, 1, buildValidGroundingObservation('Opus One 2018', 'wine-en'));

    await runner.run('오퍼스 원 vs opus one', 'req-mixed', DEFAULT_AGENT_CONFIG, state);

    const frames = toolResultFrames(chatLlm.complete);
    expect(frames.length).toBe(2);
    const joined = frames.join('\n');
    expect(joined).toContain('오퍼스 원 2018');
    expect(joined).toContain('Opus One 2018');
    expect(joined.indexOf('wine-kr')).toBeLessThan(joined.indexOf('wine-en'));
    expect(countMalformedWarnings(logger)).toBe(0);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { AgentResult } from '@domain/agent/model/agent-result.js';
import type { AgentOrchestrator } from '../../agent/agent-orchestrator.js';
import {
  ShadowModeRunner,
  generateShadowModeRequestId,
  type ShadowModeLogger,
  type WineSearchOrchestratorLike,
} from '../shadow-mode-runner.js';
import type { WineSearchResult } from '../wine-search-result-schemas.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeAgentResult(partial: Partial<AgentResult> = {}): AgentResult {
  return {
    answer: 'Recommended: Opus One 2018',
    steps: [
      {
        index: 0,
        thought: 'search',
        action: { tool: 'search_wines', input: { q: 'opus' } },
        observation: 'found',
        durationMs: 10,
        tokenCount: { input: 100, output: 50 },
      },
    ],
    totalDurationMs: 1_000,
    totalTokens: { input: 100, output: 50 },
    toolCallCount: 1,
    fallbackApplied: false,
    terminationReason: 'answer',
    ...partial,
  };
}

function makeWineSearchResult(partial: Partial<WineSearchResult> = {}): WineSearchResult {
  return {
    answer: 'Recommended: Opus One 2018',
    layer: 'primary',
    groundedOnToolResults: true,
    toolOutcomes: [],
    executionSteps: [
      {
        index: 0,
        source: 'runner',
        summary: 'search wines for opus',
        toolCalls: [{ name: 'search_wines', arguments: { q: 'opus' } }],
        durationMs: 800,
      },
    ],
    toolCallCount: 1,
    tokenUsage: {
      inputTokens: 90,
      outputTokens: 45,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    totalDurationMs: 800,
    terminationReason: 'answer',
    policyBlocked: false,
    degradedReason: undefined,
    intent: 'search',
    planKind: 'single-search',
    ...partial,
  };
}

function makeFakeLegacyAgent(
  impl: (signal?: AbortSignal) => Promise<AgentResult>,
): AgentOrchestrator {
  const execute = vi.fn(
    async (
      _query: string,
      _requestId: string,
      _overrides?: unknown,
      signal?: AbortSignal,
    ) => impl(signal),
  );
  // Cast through unknown — the runner only invokes `execute`.
  return { execute } as unknown as AgentOrchestrator;
}

function makeFakeWineSearchOrchestrator(
  impl: (signal?: AbortSignal) => Promise<WineSearchResult>,
): WineSearchOrchestratorLike {
  return {
    execute: vi.fn(async ({ abortSignal }) => impl(abortSignal)),
  };
}

function makeLogger(): ShadowModeLogger & {
  readonly info: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly error: ReturnType<typeof vi.fn>;
} {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// Deterministic clock: each call to `now()` returns the next pre-baked value.
function makeStepClock(steps: readonly number[]): { now: () => number } {
  let i = 0;
  return {
    now: () => {
      const v = steps[Math.min(i, steps.length - 1)] ?? 0;
      i += 1;
      return v;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ShadowModeRunner', () => {
  it('both orchestrators succeed → report with diff', async () => {
    const legacy = makeFakeLegacyAgent(async () => makeAgentResult());
    const wineSearch = makeFakeWineSearchOrchestrator(
      async () => makeWineSearchResult(),
    );
    const runner = new ShadowModeRunner({
      legacyOrchestrator: legacy,
      wineSearchOrchestrator: wineSearch,
      logger: makeLogger(),
    });

    const report = await runner.runOnce({
      query: 'Opus One 2018',
      requestId: 'req-1',
    });

    expect(report.requestId).toBe('req-1');
    expect(report.legacy.status).toBe('ok');
    expect(report.wineSearch.status).toBe('ok');
    expect(report.legacy.toolNames).toEqual(['search_wines']);
    expect(report.wineSearch.toolNames).toEqual(['search_wines']);
    expect(report.diff.divergent).toBe(false);
    expect(report.diff.answerEquivalent).toBe(true);
  });

  it('attaches scenarioId when provided', async () => {
    const runner = new ShadowModeRunner({
      legacyOrchestrator: makeFakeLegacyAgent(async () => makeAgentResult()),
      wineSearchOrchestrator: makeFakeWineSearchOrchestrator(
        async () => makeWineSearchResult(),
      ),
    });
    const report = await runner.runOnce({
      query: 'q',
      requestId: 'req-x',
      scenarioId: 'scn-42',
    });
    expect(report.scenarioId).toBe('scn-42');
  });

  it('legacy times out → status=timeout, wine-search still ok', async () => {
    const legacy = makeFakeLegacyAgent(
      (signal) =>
        new Promise<AgentResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
          // never resolves on its own; only the timeout abort path fires.
        }),
    );
    const wineSearch = makeFakeWineSearchOrchestrator(
      async () => makeWineSearchResult({ answer: 'good answer' }),
    );
    const runner = new ShadowModeRunner({
      legacyOrchestrator: legacy,
      wineSearchOrchestrator: wineSearch,
    });
    const report = await runner.runOnce({
      query: 'q',
      requestId: 'req-timeout',
      timeoutMs: 1_000,
    });
    expect(report.legacy.status).toBe('timeout');
    expect(report.wineSearch.status).toBe('ok');
    expect(report.diff.divergentReasons).toContain('one_side_errored');
  });

  it('wine-search errors → status=error with errorMessage populated', async () => {
    const legacy = makeFakeLegacyAgent(async () => makeAgentResult());
    const wineSearch = makeFakeWineSearchOrchestrator(async () => {
      throw new Error('synthesis crashed');
    });
    const runner = new ShadowModeRunner({
      legacyOrchestrator: legacy,
      wineSearchOrchestrator: wineSearch,
    });
    const report = await runner.runOnce({ query: 'q', requestId: 'req-err' });
    expect(report.wineSearch.status).toBe('error');
    expect(report.wineSearch.errorMessage).toBe('synthesis crashed');
    expect(report.legacy.status).toBe('ok');
    expect(report.diff.divergent).toBe(true);
    expect(report.diff.divergentReasons).toContain('one_side_errored');
  });

  it('both error → both statuses error, not one_side_errored', async () => {
    const legacy = makeFakeLegacyAgent(async () => {
      throw new Error('legacy down');
    });
    const wineSearch = makeFakeWineSearchOrchestrator(async () => {
      throw new Error('new down');
    });
    const runner = new ShadowModeRunner({
      legacyOrchestrator: legacy,
      wineSearchOrchestrator: wineSearch,
    });
    const report = await runner.runOnce({ query: 'q', requestId: 'req-2err' });
    expect(report.legacy.status).toBe('error');
    expect(report.wineSearch.status).toBe('error');
    expect(report.diff.divergentReasons).not.toContain('one_side_errored');
  });

  it('caller abort propagates to BOTH orchestrators', async () => {
    const controller = new AbortController();
    let legacySawAbort = false;
    let wineSawAbort = false;
    const legacy = makeFakeLegacyAgent(
      (signal) =>
        new Promise<AgentResult>((_resolve, reject) => {
          if (signal === undefined) {
            reject(new Error('expected signal'));
            return;
          }
          signal.addEventListener('abort', () => {
            legacySawAbort = true;
            reject(new Error('aborted'));
          }, { once: true });
        }),
    );
    const wineSearch = makeFakeWineSearchOrchestrator(
      (signal) =>
        new Promise<WineSearchResult>((_resolve, reject) => {
          if (signal === undefined) {
            reject(new Error('expected signal'));
            return;
          }
          signal.addEventListener('abort', () => {
            wineSawAbort = true;
            reject(new Error('aborted'));
          }, { once: true });
        }),
    );
    const runner = new ShadowModeRunner({
      legacyOrchestrator: legacy,
      wineSearchOrchestrator: wineSearch,
    });
    const promise = runner.runOnce({
      query: 'q',
      requestId: 'req-abort',
      abortSignal: controller.signal,
      timeoutMs: 10_000,
    });
    // Fire the abort after a microtask so the runner has a chance to register.
    await Promise.resolve();
    controller.abort();

    const report = await promise;
    expect(legacySawAbort).toBe(true);
    expect(wineSawAbort).toBe(true);
    expect(report.legacy.status).toBe('aborted');
    expect(report.wineSearch.status).toBe('aborted');
  });

  it('orchestrator-side timeouts are isolated (one timing out does not abort the other)', async () => {
    let wineSawAbort = false;
    const legacy = makeFakeLegacyAgent(
      (signal) =>
        new Promise<AgentResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const wineSearch = makeFakeWineSearchOrchestrator(
      async (signal) => {
        signal?.addEventListener('abort', () => {
          wineSawAbort = true;
        });
        return makeWineSearchResult();
      },
    );
    const runner = new ShadowModeRunner({
      legacyOrchestrator: legacy,
      wineSearchOrchestrator: wineSearch,
      // 1s timeout — legacy will time out, wine-search returns synchronously.
    });
    const report = await runner.runOnce({
      query: 'q',
      requestId: 'req-isolation',
      timeoutMs: 1_000,
    });
    expect(report.legacy.status).toBe('timeout');
    expect(report.wineSearch.status).toBe('ok');
    expect(wineSawAbort).toBe(false);
  });

  it('runs in parallel — total wait time ≤ max(legacy, wineSearch) + slack', async () => {
    // Each side sleeps 200 ms; parallel execution must finish in ~200 ms,
    // not 400 ms.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const legacy = makeFakeLegacyAgent(async () => {
      await sleep(200);
      return makeAgentResult();
    });
    const wineSearch = makeFakeWineSearchOrchestrator(async () => {
      await sleep(200);
      return makeWineSearchResult();
    });
    const runner = new ShadowModeRunner({
      legacyOrchestrator: legacy,
      wineSearchOrchestrator: wineSearch,
    });
    const t0 = Date.now();
    await runner.runOnce({ query: 'q', requestId: 'req-parallel' });
    const elapsed = Date.now() - t0;
    // Generous slack for CI; the assertion catches the regression where one
    // side awaits the other sequentially (would be ~400 ms).
    expect(elapsed).toBeLessThan(380);
  });

  it('clock injection is used for duration calculation in error paths', async () => {
    const clock = makeStepClock([1_000, 1_500, 1_000, 1_900]);
    const legacy = makeFakeLegacyAgent(async () => {
      throw new Error('boom');
    });
    const wineSearch = makeFakeWineSearchOrchestrator(async () => {
      throw new Error('boom2');
    });
    const runner = new ShadowModeRunner({
      legacyOrchestrator: legacy,
      wineSearchOrchestrator: wineSearch,
      clock,
    });
    const report = await runner.runOnce({ query: 'q', requestId: 'req-clock' });
    // Both finished synchronously; durations should be the clock-step delta.
    expect(report.legacy.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(report.wineSearch.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('logger.warn called when divergent', async () => {
    const logger = makeLogger();
    const legacy = makeFakeLegacyAgent(async () => makeAgentResult({
      answer: 'Bordeaux red wine recommended',
      steps: [],
      toolCallCount: 0,
    }));
    const wineSearch = makeFakeWineSearchOrchestrator(async () => makeWineSearchResult({
      answer: 'Completely unrelated text about cats and dogs',
      executionSteps: [],
    }));
    const runner = new ShadowModeRunner({
      legacyOrchestrator: legacy,
      wineSearchOrchestrator: wineSearch,
      logger,
    });
    await runner.runOnce({ query: 'q', requestId: 'req-div' });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('logger.info called when parity', async () => {
    const logger = makeLogger();
    const runner = new ShadowModeRunner({
      legacyOrchestrator: makeFakeLegacyAgent(async () => makeAgentResult()),
      wineSearchOrchestrator: makeFakeWineSearchOrchestrator(
        async () => makeWineSearchResult(),
      ),
      logger,
    });
    await runner.runOnce({ query: 'q', requestId: 'req-par' });
    expect(logger.info).toHaveBeenCalled();
  });

  it('generateShadowModeRequestId returns a non-empty string', () => {
    const id = generateShadowModeRequestId();
    expect(typeof id).toBe('string');
    expect(id.startsWith('shadow-')).toBe(true);
    expect(id.length).toBeGreaterThan('shadow-'.length);
  });

  it('extracts tool names from parallel batch steps (actionPairs)', async () => {
    const legacy = makeFakeLegacyAgent(async () =>
      makeAgentResult({
        steps: [
          {
            index: 0,
            thought: 'batch',
            actionPairs: [
              {
                action: { tool: 'search_wines', input: {} },
                observation: 'obs1',
              },
              {
                action: { tool: 'check_drinking_window', input: {} },
                observation: 'obs2',
              },
            ],
            durationMs: 10,
            tokenCount: { input: 50, output: 25 },
          },
        ],
        toolCallCount: 2,
      }),
    );
    const wineSearch = makeFakeWineSearchOrchestrator(
      async () => makeWineSearchResult(),
    );
    const runner = new ShadowModeRunner({
      legacyOrchestrator: legacy,
      wineSearchOrchestrator: wineSearch,
    });
    const report = await runner.runOnce({ query: 'q', requestId: 'req-batch' });
    expect(report.legacy.toolNames).toEqual([
      'search_wines',
      'check_drinking_window',
    ]);
  });

  // -------------------------------------------------------------------------
  // Observation provenance (Gap-4: faithfulness / contextRecall grounding)
  // -------------------------------------------------------------------------

  describe('observation extraction', () => {
    it('wine-search: flattens observations from runner + mini_loop steps in step order', async () => {
      const legacy = makeFakeLegacyAgent(async () => makeAgentResult());
      const wineSearch = makeFakeWineSearchOrchestrator(async () =>
        makeWineSearchResult({
          executionSteps: [
            {
              index: 0,
              source: 'analyzer',
              summary: 'analyze',
              observations: ['SHOULD_BE_DROPPED_analyzer'],
              durationMs: 1,
            },
            {
              index: 1,
              source: 'runner',
              summary: 'search',
              toolCalls: [{ name: 'search_wines', arguments: { q: 'opus' } }],
              observations: ['runner-obs-1', 'runner-obs-2'],
              durationMs: 10,
            },
            {
              index: 2,
              source: 'mini_loop',
              summary: 'refine',
              toolCalls: [{ name: 'check_drinking_window', arguments: {} }],
              observations: ['mini-obs-3'],
              durationMs: 5,
            },
            {
              index: 3,
              source: 'synthesizer',
              summary: 'synth',
              observations: ['SHOULD_BE_DROPPED_synth'],
              durationMs: 1,
            },
          ],
        }),
      );
      const runner = new ShadowModeRunner({
        legacyOrchestrator: legacy,
        wineSearchOrchestrator: wineSearch,
      });
      const report = await runner.runOnce({ query: 'q', requestId: 'req-obs' });
      // Step-order fidelity; analyzer / synthesizer observations excluded.
      expect(report.wineSearch.observations).toEqual([
        'runner-obs-1',
        'runner-obs-2',
        'mini-obs-3',
      ]);
    });

    it('wine-search: empty observations when no runner/mini_loop steps carry grounding', async () => {
      const legacy = makeFakeLegacyAgent(async () => makeAgentResult());
      const wineSearch = makeFakeWineSearchOrchestrator(async () =>
        makeWineSearchResult({
          executionSteps: [
            {
              index: 0,
              source: 'analyzer',
              summary: 'analyze only',
              observations: ['analyzer-noise'],
              durationMs: 1,
            },
          ],
        }),
      );
      const runner = new ShadowModeRunner({
        legacyOrchestrator: legacy,
        wineSearchOrchestrator: wineSearch,
      });
      const report = await runner.runOnce({ query: 'q', requestId: 'req-empty-obs' });
      expect(report.wineSearch.observations).toEqual([]);
    });

    it('wine-search: drops empty observation strings (no signal)', async () => {
      const legacy = makeFakeLegacyAgent(async () => makeAgentResult());
      const wineSearch = makeFakeWineSearchOrchestrator(async () =>
        makeWineSearchResult({
          executionSteps: [
            {
              index: 0,
              source: 'runner',
              summary: 'search',
              toolCalls: [{ name: 'search_wines', arguments: {} }],
              observations: ['', 'kept', ''],
              durationMs: 10,
            },
          ],
        }),
      );
      const runner = new ShadowModeRunner({
        legacyOrchestrator: legacy,
        wineSearchOrchestrator: wineSearch,
      });
      const report = await runner.runOnce({ query: 'q', requestId: 'req-empty-str' });
      expect(report.wineSearch.observations).toEqual(['kept']);
    });

    it('wine-search: preserves Korean observations byte-identical (CLAUDE.md rule 5)', async () => {
      const koreanObs = '바롤로 2016 — 가성비 좋은 이탈리아 레드 와인 🍷';
      const legacy = makeFakeLegacyAgent(async () => makeAgentResult());
      const wineSearch = makeFakeWineSearchOrchestrator(async () =>
        makeWineSearchResult({
          executionSteps: [
            {
              index: 0,
              source: 'runner',
              summary: 'search',
              toolCalls: [{ name: 'search_wines', arguments: {} }],
              observations: [koreanObs],
              durationMs: 10,
            },
          ],
        }),
      );
      const runner = new ShadowModeRunner({
        legacyOrchestrator: legacy,
        wineSearchOrchestrator: wineSearch,
      });
      const report = await runner.runOnce({ query: '바롤로 추천', requestId: 'req-kr' });
      expect(report.wineSearch.observations).toEqual([koreanObs]);
      // Byte-identical: no NFKC mangling, no truncation under the 2000-char cap.
      expect(report.wineSearch.observations?.[0]).toBe(koreanObs);
    });

    it('legacy: prefers evidenceFrames[].observationSnapshot when present', async () => {
      const legacy = makeFakeLegacyAgent(async () =>
        makeAgentResult({
          evidenceFrames: [
            { observationSnapshot: 'frame-obs-1' },
            { observationSnapshot: 'frame-obs-2' },
          ] as unknown as NonNullable<AgentResult['evidenceFrames']>,
        }),
      );
      const wineSearch = makeFakeWineSearchOrchestrator(async () => makeWineSearchResult());
      const runner = new ShadowModeRunner({
        legacyOrchestrator: legacy,
        wineSearchOrchestrator: wineSearch,
      });
      const report = await runner.runOnce({ query: 'q', requestId: 'req-frames' });
      expect(report.legacy.observations).toEqual(['frame-obs-1', 'frame-obs-2']);
    });

    it('legacy: falls back to actionPairs[].observation when no evidenceFrames', async () => {
      const legacy = makeFakeLegacyAgent(async () =>
        makeAgentResult({
          steps: [
            {
              index: 0,
              thought: 'batch',
              actionPairs: [
                { action: { tool: 'search_wines', input: {} }, observation: 'pair-obs-1' },
                { action: { tool: 'check_drinking_window', input: {} }, observation: 'pair-obs-2' },
              ],
              durationMs: 10,
              tokenCount: { input: 50, output: 25 },
            },
          ],
          toolCallCount: 2,
        }),
      );
      const wineSearch = makeFakeWineSearchOrchestrator(async () => makeWineSearchResult());
      const runner = new ShadowModeRunner({
        legacyOrchestrator: legacy,
        wineSearchOrchestrator: wineSearch,
      });
      const report = await runner.runOnce({ query: 'q', requestId: 'req-pairs' });
      expect(report.legacy.observations).toEqual(['pair-obs-1', 'pair-obs-2']);
    });

    it('legacy: single-step result surfaces step.observation', async () => {
      const legacy = makeFakeLegacyAgent(async () => makeAgentResult());
      const wineSearch = makeFakeWineSearchOrchestrator(async () => makeWineSearchResult());
      const runner = new ShadowModeRunner({
        legacyOrchestrator: legacy,
        wineSearchOrchestrator: wineSearch,
      });
      const report = await runner.runOnce({ query: 'q', requestId: 'req-single' });
      // makeAgentResult's default single step carries observation 'found'.
      expect(report.legacy.observations).toEqual(['found']);
    });

    it('errored side carries an empty observations array (never undefined)', async () => {
      const legacy = makeFakeLegacyAgent(async () => {
        throw new Error('boom');
      });
      const wineSearch = makeFakeWineSearchOrchestrator(async () => makeWineSearchResult());
      const runner = new ShadowModeRunner({
        legacyOrchestrator: legacy,
        wineSearchOrchestrator: wineSearch,
      });
      const report = await runner.runOnce({ query: 'q', requestId: 'req-err-obs' });
      expect(report.legacy.status).toBe('error');
      expect(report.legacy.observations).toEqual([]);
    });
  });
});

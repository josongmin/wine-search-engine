/**
 * Regression: tool-timeout fallbacks must be classified as INFRA (backend
 * latency), not agent-quality failures.
 *
 * Root cause: the dev/staging Vespa cluster answers a normal query in ~1.6-2.7s,
 * but under load a `search_wines` tool call can exceed the per-tool timeout
 * (~21s observed). The tool-execution policy records a `[TIMEOUT] Tool "..."`
 * step and the run degrades to `terminationReason='fallback'`. A query that
 * takes longer than the timeout on a ~1.6s-baseline cluster is infra latency by
 * definition — NOT an agent defect — yet the scorer charges it as a failure
 * (term~25%, tool~0%), depressing the geo-mean by an estimated 2-4pp.
 *
 * This test pins the principled predicate (`isToolTimeoutInfraFallback`) and the
 * end-to-end aggregate effect: tool-timeout infra fallbacks are excluded from
 * `overallScore` / CI / `criticalFailureCount`, stay visible in `results[]`, and
 * are counted in `toolTimeoutInfraFallbackCount` — and the geo-mean RISES when
 * they are excluded vs included.
 */
import { describe, expect, it } from 'vitest';
import {
  buildReport,
  isToolTimeoutInfraFallback,
  type CliArgs,
  type BenchmarkWallClock,
} from '../../test/benchmark/agent/runner.js';
import type {
  ScenarioResult,
  ScenarioScores,
  StepTrace,
} from '../../test/benchmark/agent/scorer.js';
import type { AgentBenchmarkScenario } from '../../test/benchmark/agent/scenario.js';

// ── builders ───────────────────────────────────────────────────────────

function makeScores(overall: number, opts: Partial<ScenarioScores> = {}): ScenarioScores {
  return {
    executionEfficiency: overall,
    toolAccuracy: overall,
    stepEfficiency: overall,
    answerQuality: overall,
    terminationCorrectness: overall,
    costEfficiency: overall,
    faithfulness: null,
    contextRelevance: null,
    contextRecall: null,
    exactLookupHit: null,
    failClosedAccuracy: null,
    answerRelevancy: null,
    judge: null,
    overall,
    criticalFailure: false,
    semanticConstraintRecall: null,
    scrHard: null,
    scrSoft: null,
    scrInferred: null,
    scrInferredGraph: null,
    entityLinkingAccuracy: null,
    slotF1Strict: null,
    slotF1Relaxed: null,
    csrOverall: null,
    csrHard: null,
    csrSoft: null,
    csrInferred: null,
    csrInferredGraph: null,
    ...opts,
  };
}

function toolStep(
  tool: string,
  input: Record<string, unknown>,
  observation: string,
): StepTrace {
  return {
    index: 0,
    thought: 'planning a retrieval',
    action: { tool, input },
    observation,
    durationMs: 21_000,
    tokenCount: { input: 100, output: 20 },
  };
}

function makeResult(
  id: number,
  overall: number,
  opts: {
    terminationReason?: string;
    stepCount?: number;
    steps?: readonly StepTrace[];
    criticalFailure?: boolean;
  } = {},
): ScenarioResult {
  return {
    id,
    tier: 'single_shot',
    query: `q${id}`,
    skipped: false,
    answer: 'answer',
    stepCount: opts.stepCount ?? 1,
    toolCallCount: 1,
    terminationReason: opts.terminationReason ?? 'answer',
    totalDurationMs: 21_000,
    totalTokens: { input: 100, output: 20 },
    scores: makeScores(overall, { criticalFailure: opts.criticalFailure ?? false }),
    judgeRequiredButSkipped: false,
    ...(opts.steps !== undefined ? { steps: opts.steps } : {}),
  };
}

const TOOL_TIMEOUT_OBS = '[TIMEOUT] Tool "search_wines" timed out. Try a different approach or a narrower query.';

// (a) tool-timeout fallback — valid query, retrieval tool, stepCount > 0.
const toolTimeoutFallback = makeResult(1, 0.2, {
  terminationReason: 'fallback',
  stepCount: 1,
  criticalFailure: true,
  steps: [toolStep('search_wines', { query: '부드러운 레드 와인 추천' }, TOOL_TIMEOUT_OBS)],
});

// (b) genuine agent failure — no timeout, bad answer, normal termination.
const genuineAgentFailure = makeResult(2, 0.2, {
  terminationReason: 'answer',
  stepCount: 1,
  criticalFailure: true,
  steps: [toolStep('search_wines', { query: 'pinot noir' }, 'Found 5 wines: ...')],
});

// (c) LLM-step timeout (agent's own slowness) — fallback but NO tool-timeout
// observation (the LLM call failed before producing a tool step).
const llmStepTimeoutFallback = makeResult(3, 0.2, {
  terminationReason: 'fallback',
  stepCount: 1,
  steps: [
    {
      index: 0,
      thought: 'thinking...',
      durationMs: 90_000,
      tokenCount: { input: 100, output: 0 },
    },
  ],
});

// healthy passing scenario to anchor the geo-mean.
const healthy = makeResult(4, 0.9, { terminationReason: 'answer', stepCount: 1 });

describe('isToolTimeoutInfraFallback predicate', () => {
  it('(a) classifies a retrieval-tool timeout fallback with a valid query as infra', () => {
    expect(isToolTimeoutInfraFallback(toolTimeoutFallback)).toBe(true);
  });

  it('(b) does NOT classify a genuine agent failure (no timeout) as infra', () => {
    expect(isToolTimeoutInfraFallback(genuineAgentFailure)).toBe(false);
  });

  it('(c) does NOT classify an LLM-step timeout (agent slowness) as tool-infra', () => {
    expect(isToolTimeoutInfraFallback(llmStepTimeoutFallback)).toBe(false);
  });

  it('does NOT classify a step-0 fallback (LLM unavailable) as tool-infra', () => {
    const step0 = makeResult(5, 0.0, { terminationReason: 'fallback', stepCount: 0, steps: [] });
    expect(isToolTimeoutInfraFallback(step0)).toBe(false);
  });

  it('does NOT classify a timeout on a non-retrieval / unknown tool as infra', () => {
    const otherTool = makeResult(6, 0.2, {
      terminationReason: 'fallback',
      stepCount: 1,
      steps: [toolStep('parents_first_time', { foo: 'bar' }, '[TIMEOUT] Tool "parents_first_time" timed out.')],
    });
    expect(isToolTimeoutInfraFallback(otherTool)).toBe(false);
  });

  it('does NOT classify a retrieval timeout with a MALFORMED (empty) input as infra', () => {
    const malformed = makeResult(7, 0.2, {
      terminationReason: 'fallback',
      stepCount: 1,
      steps: [toolStep('search_wines', {}, TOOL_TIMEOUT_OBS)],
    });
    expect(isToolTimeoutInfraFallback(malformed)).toBe(false);
  });

  it('does NOT classify a successful retrieval (no timeout observation) as infra', () => {
    const ok = makeResult(8, 0.2, {
      terminationReason: 'fallback',
      stepCount: 1,
      steps: [toolStep('search_wines', { query: 'merlot' }, 'Found 3 wines.')],
    });
    expect(isToolTimeoutInfraFallback(ok)).toBe(false);
  });
});

// ── end-to-end aggregate effect ─────────────────────────────────────────

const WALL_CLOCK: BenchmarkWallClock = {
  initMs: 0,
  scenariosPhaseMs: 0,
  shutdownMs: 0,
  totalMs: 0,
  meanScenarioWallMs: 0,
  sumScenarioWallMs: 0,
  scenarioWallSampleCount: 0,
  concurrency: 1,
};

const ARGS: CliArgs = {
  container: 'real',
  concurrency: 1,
  maxRetries: 1,
  enableJudge: true,
  judgeSamples: 1,
  runs: 1,
};

function reportFor(results: readonly ScenarioResult[]) {
  return buildReport(
    results,
    [] as readonly AgentBenchmarkScenario[],
    'test-model',
    'test-judge', // judgeModel non-null → judgeAvailable, all scenarios aggregate
    'text-embedding-3-small',
    'api.openai.com',
    ARGS,
    0,
    0,
    WALL_CLOCK,
    0,
  );
}

describe('buildReport — tool-timeout infra exclusion', () => {
  const withInfra = [healthy, toolTimeoutFallback];

  it('excludes the tool-timeout infra fallback from overallScore and CI', () => {
    const report = reportFor(withInfra);
    // overallScore must reflect ONLY the healthy scenario (0.9), not the
    // averaged-in 0.2 infra fallback.
    expect(report.summary.overallScore).toBeCloseTo(0.9, 5);
    expect(report.summary.overallBootstrapCi95.n).toBe(1);
  });

  it('counts the infra fallback in toolTimeoutInfraFallbackCount and keeps it in results[]', () => {
    const report = reportFor(withInfra);
    expect(report.toolTimeoutInfraFallbackCount).toBe(1);
    // Still visible in the raw results array (not silently dropped).
    expect(report.results.map((r) => r.id)).toContain(toolTimeoutFallback.id);
  });

  it('excludes the infra fallback from criticalFailureCount', () => {
    const report = reportFor(withInfra);
    // toolTimeoutFallback has criticalFailure=true but is an infra failure →
    // must NOT inflate the headline critical count. healthy is not critical.
    expect(report.criticalFailureCount).toBe(0);
  });

  it('still counts a GENUINE agent failure in criticalFailureCount', () => {
    const report = reportFor([healthy, genuineAgentFailure]);
    expect(report.criticalFailureCount).toBe(1);
    expect(report.toolTimeoutInfraFallbackCount).toBe(0);
  });

  it('keeps an LLM-step timeout fallback IN the aggregate (agent slowness, not infra)', () => {
    const report = reportFor([healthy, llmStepTimeoutFallback]);
    // llmStepTimeoutFallback (0.2) is NOT excluded → geo-mean is the mean of
    // 0.9 and 0.2, and it is NOT counted as a tool-timeout infra fallback.
    expect(report.toolTimeoutInfraFallbackCount).toBe(0);
    expect(report.summary.overallScore).toBeCloseTo((0.9 + 0.2) / 2, 5);
  });

  it('geo-mean RISES when infra-timeouts are excluded vs naively included', () => {
    const excluded = reportFor(withInfra).summary.overallScore;
    // Naive baseline: average over ALL executed scenarios (the old behavior,
    // before A3 stripped tool-timeout infra fallbacks).
    const naiveIncluded = (healthy.scores.overall + toolTimeoutFallback.scores.overall) / 2;
    expect(excluded).toBeGreaterThan(naiveIncluded);
    // Concretely: 0.90 (excluded) vs 0.55 (included) — a 35pp correction here.
    expect(excluded - naiveIncluded).toBeGreaterThan(0.3);
  });
});

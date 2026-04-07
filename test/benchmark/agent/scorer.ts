/**
 * Benchmark scorer — evaluates agent execution against expected outcomes.
 */

import type { AgentBenchmarkScenario, ScenarioExpectation } from './scenario.js';

export interface ScenarioResult {
  readonly id: number;
  readonly tier: string;
  readonly query: string;
  readonly skipped: boolean;
  readonly skipReason?: string;

  // Execution data (undefined if skipped or errored)
  readonly answer?: string;
  readonly stepCount?: number;
  readonly toolCallCount?: number;
  readonly toolsUsed?: readonly string[];
  readonly terminationReason?: string;
  readonly totalDurationMs?: number;
  readonly totalTokens?: { input: number; output: number };
  readonly error?: string;

  // Scores (0-1 each)
  readonly scores: {
    readonly toolAccuracy: number;
    readonly stepEfficiency: number;
    readonly answerQuality: number;
    readonly terminationCorrectness: number;
    readonly overall: number;
  };
}

export function scoreScenario(
  scenario: AgentBenchmarkScenario,
  execution: {
    readonly answer: string;
    readonly stepCount: number;
    readonly toolCallCount: number;
    readonly toolsUsed: readonly string[];
    readonly terminationReason: string;
    readonly totalDurationMs: number;
    readonly totalTokens: { input: number; output: number };
  } | null,
  error?: string,
): ScenarioResult {
  if (scenario.skip !== undefined) {
    return {
      id: scenario.id,
      tier: scenario.tier,
      query: scenario.query,
      skipped: true,
      skipReason: scenario.skip,
      scores: { toolAccuracy: 0, stepEfficiency: 0, answerQuality: 0, terminationCorrectness: 0, overall: 0 },
    };
  }

  if (execution === null || error !== undefined) {
    return {
      id: scenario.id,
      tier: scenario.tier,
      query: scenario.query,
      skipped: false,
      error: error ?? 'execution returned null',
      scores: { toolAccuracy: 0, stepEfficiency: 0, answerQuality: 0, terminationCorrectness: 0, overall: 0 },
    };
  }

  const exp = scenario.expectation;
  const toolAccuracy = scoreToolAccuracy(exp, execution.toolsUsed);
  const stepEfficiency = scoreStepEfficiency(exp, execution.stepCount);
  const answerQuality = scoreAnswerQuality(exp, execution.answer);
  const terminationCorrectness = scoreTermination(exp, execution.terminationReason);
  const overall = (toolAccuracy + stepEfficiency + answerQuality + terminationCorrectness) / 4;

  return {
    id: scenario.id,
    tier: scenario.tier,
    query: scenario.query,
    skipped: false,
    answer: execution.answer,
    stepCount: execution.stepCount,
    toolCallCount: execution.toolCallCount,
    toolsUsed: execution.toolsUsed,
    terminationReason: execution.terminationReason,
    totalDurationMs: execution.totalDurationMs,
    totalTokens: execution.totalTokens,
    scores: { toolAccuracy, stepEfficiency, answerQuality, terminationCorrectness, overall },
  };
}

function scoreToolAccuracy(exp: ScenarioExpectation, toolsUsed: readonly string[]): number {
  if (exp.tools === undefined || exp.tools.length === 0) return 1;
  const expected = exp.tools.map((t) => t.tool);
  const matched = expected.filter((t) => toolsUsed.includes(t));
  return matched.length / expected.length;
}

function scoreStepEfficiency(exp: ScenarioExpectation, stepCount: number): number {
  if (stepCount <= exp.maxSteps) return 1;
  // Penalize proportionally for exceeding
  return Math.max(0, 1 - (stepCount - exp.maxSteps) / exp.maxSteps);
}

function scoreAnswerQuality(exp: ScenarioExpectation, answer: string): number {
  const lower = answer.toLowerCase();
  let score = 1;

  if (exp.answerContains !== undefined && exp.answerContains.length > 0) {
    const matched = exp.answerContains.filter((kw) => lower.includes(kw.toLowerCase()));
    score *= matched.length / exp.answerContains.length;
  }

  if (exp.answerExcludes !== undefined) {
    const violated = exp.answerExcludes.filter((kw) => lower.includes(kw.toLowerCase()));
    if (violated.length > 0) {
      score *= 0.5; // Penalty for including excluded terms
    }
  }

  // Empty answer is always bad
  if (answer.trim().length === 0) score = 0;

  return score;
}

function scoreTermination(exp: ScenarioExpectation, reason: string): number {
  if (exp.terminationReason === undefined) return reason === 'answer' ? 1 : 0.5;
  return reason === exp.terminationReason ? 1 : 0;
}

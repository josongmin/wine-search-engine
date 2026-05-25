/**
 * Shared fixtures for benchmark scorer tests.
 * Extracted from scorer.test.ts during the 2026-05-26 test decomposition.
 */

import type { AgentBenchmarkScenario, ScenarioExpectation } from '../../scenario.js';
import type { ScenarioExecution, ToolCallTrace } from '../../scorer.js';
import type { ToolCallEvidenceFrame } from '../../../../../src/domain/agent/model/tool-call-evidence-frame.js';

export function makeScenario(
  expectation: ScenarioExpectation,
  overrides: Partial<AgentBenchmarkScenario> = {},
): AgentBenchmarkScenario {
  return {
    id: 1,
    tier: 'single_shot',
    query: 'test query',
    description: 'test',
    expectation,
    ...overrides,
  };
}

export function makeExecution(overrides: Partial<ScenarioExecution> = {}): ScenarioExecution {
  return {
    answer: 'a wine answer for your query',
    stepCount: 2,
    toolCallCount: 1,
    toolsUsed: [{ tool: 'search_wines', input: '{"query":"test"}' }],
    observations: ['Found 3 results: Wine A (Benchmark Winery), Wine B, Wine C'],
    terminationReason: 'answer',
    totalDurationMs: 1_000,
    totalTokens: { input: 500, output: 200 },
    ...overrides,
  };
}

export function makeEvidenceFrame(overrides: Partial<ToolCallEvidenceFrame>): ToolCallEvidenceFrame {
  return {
    frameSchemaVersion: 'tool_evidence_v1',
    toolCallId: 'tc-1',
    toolName: 'search_wines',
    invokedAt: '2026-04-15T00:00:00Z',
    requestId: 'req-1',
    request: { toolName: 'search_wines', input: {} },
    structuredOutput: { kind: 'no_op', reason: 'stub' },
    observationSnapshot: '',
    observationHash: 'a'.repeat(64),
    durationMs: 5,
    ...overrides,
  };
}

export const tool = (name: string, input?: string): ToolCallTrace =>
  input !== undefined ? { tool: name, input } : { tool: name };

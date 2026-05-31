import { describe, expect, it } from 'vitest';
import { evaluateScenarioClaims } from '../../benchmark/agent/claim-evaluator-adapter.js';
import type { AgentBenchmarkScenario } from '../../benchmark/agent/scenario.js';
import type { ScenarioExecution } from '../../benchmark/agent/scorer.js';
import type { ToolCallEvidenceFrame } from '../../../src/domain/agent/model/tool-call-evidence-frame.js';

function makeScenario(): AgentBenchmarkScenario {
  return {
    id: 1,
    tier: 'single_shot',
    query: '오퍼스 원 추천',
    description: 'adapter regression',
    expectation: {
      maxSteps: 3,
    },
  };
}

function makeNoEvidenceFrame(): ToolCallEvidenceFrame {
  return {
    frameSchemaVersion: 'tool_evidence_v1',
    toolCallId: 'req-1-s0',
    toolName: 'search_hybrid',
    invokedAt: '2026-04-22T00:00:00Z',
    requestId: 'req-1',
    request: {
      toolName: 'search_hybrid',
      input: { query: 'opus one' },
    },
    structuredOutput: {
      kind: 'no_op',
      reason: 'no structured evidence',
    },
    observationSnapshot: '',
    observationHash: 'a'.repeat(64),
    durationMs: 5,
  };
}

function makeExecution(): ScenarioExecution {
  return {
    answer: 'Opus One 2018',
    stepCount: 1,
    toolCallCount: 1,
    toolsUsed: [{ tool: 'search_hybrid', input: '{"query":"opus one"}' }],
    observations: ['Found 1 result: Opus One 2018 | producer: Opus One Winery | vintage: 2018'],
    evidenceFrames: [makeNoEvidenceFrame()],
    terminationReason: 'answer',
    totalDurationMs: 1000,
    totalTokens: { input: 100, output: 50 },
  };
}

describe('claim-evaluator-adapter', () => {
  it('does not fall back to regex observations when evidence frames are present but empty', async () => {
    const diagnostics = await evaluateScenarioClaims(
      makeScenario(),
      makeExecution(),
      null,
    );

    expect(diagnostics.provenanceCoverage).toBe(0);
    expect(diagnostics.verifications.some((verification) => verification.verdict === 'entailed')).toBe(false);
  });
});

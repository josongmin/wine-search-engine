import { describe, expect, it } from 'vitest';

import {
  createJudgeLlmFromConfig,
  evaluateAnswerPatterns,
  evaluateExpectedToolSequence,
  normalizeAgentFixtureCase,
} from '../../../scripts/eval/agent-fixture-runner-common.ts';
import { buildToolUseFixtureReport } from '../../../scripts/eval/run-agentic-tool-use-fixture-eval.ts';
import { buildAnswerQualityFixtureReport } from '../../../scripts/eval/run-agentic-answer-quality-fixture-eval.ts';

describe('agent fixture runners', () => {
  it('normalizes nested external fixture evaluation fields into runner inputs', () => {
    const normalized = normalizeAgentFixtureCase({
      id: 'atu-001',
      query: '스테이크에 어울리는 와인',
      language: 'ko',
      difficulty: 'medium',
      evaluation: {
        expected_tools: [{ tool: 'get_food_pairings', optional: true }],
        answer_must_match: ['(스테이크|steak)'],
        answer_must_not_match: ['화이트'],
        rubric: 'Must pair with steak.',
        max_steps: 2,
      },
    });

    expect(normalized).toEqual({
      id: 'atu-001',
      query: '스테이크에 어울리는 와인',
      language: 'ko',
      difficulty: 'medium',
      expected_tools: [{ tool: 'get_food_pairings', optional: true }],
      answer_must_match: ['(스테이크|steak)'],
      answer_must_not_match: ['화이트'],
      rubric: 'Must pair with steak.',
      max_steps: 2,
    });
  });

  it('wires fixture judge provider timeouts through adapter contracts', () => {
    const config = {
      openai: {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.test/v1',
        chatModel: 'gpt-5.4-mini',
        httpTimeoutMs: 12345,
      },
      anthropic: {
        apiKey: 'sk-ant-test',
      },
    };

    const openAiJudge = createJudgeLlmFromConfig(config, 'gpt-5.4-mini');
    const anthropicJudge = createJudgeLlmFromConfig(config, 'claude-haiku-test');

    expect((openAiJudge as unknown as { httpTimeoutMs: number }).httpTimeoutMs).toBe(12345);
    expect((anthropicJudge as unknown as { httpTimeoutMs: number }).httpTimeoutMs).toBe(12345);
  });

  it('fails fast when a fixture judge provider key is missing', () => {
    const config = {
      openai: {
        apiKey: undefined,
        baseUrl: 'https://api.openai.test/v1',
        chatModel: 'gpt-5.4-mini',
        httpTimeoutMs: 12345,
      },
      anthropic: {
        apiKey: undefined,
      },
    };

    expect(() => createJudgeLlmFromConfig(config, 'gpt-5.4-mini')).toThrow(/OPENAI_API_KEY/);
    expect(() => createJudgeLlmFromConfig(config, 'claude-haiku-test')).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('accepts optional tool expectations without forcing a miss', () => {
    const pass = evaluateExpectedToolSequence(
      [{ tool: 'search_wines', input: '{"query":"스테이크"}' }],
      [
        { tool: 'get_food_pairings', optional: true },
        { tool: 'search_wines' },
      ],
    );

    expect(pass).toBe(true);
  });

  it('evaluates answer pattern coverage and forbidden-pattern violations', () => {
    expect(
      evaluateAnswerPatterns(
        '보르도와 나파는 스타일 차이가 있습니다.',
        ['보르도', '나파'],
        ['죄송합니다'],
      ),
    ).toEqual({
      patternCoveragePass: true,
      forbiddenPatternViolation: false,
    });
  });

  it('builds fixture-native summary reports for tool-use and answer-quality', () => {
    const toolUse = buildToolUseFixtureReport([
      {
        id: 'atu-001',
        pass: true,
        toolSelectionPass: true,
        stepBudgetPass: true,
        patternCoveragePass: true,
        forbiddenPatternViolation: false,
        durationMs: 1200,
        toolCalls: ['search_wines'],
      },
      {
        id: 'atu-002',
        pass: false,
        toolSelectionPass: false,
        stepBudgetPass: true,
        patternCoveragePass: true,
        forbiddenPatternViolation: false,
        durationMs: 1800,
        toolCalls: ['compare_wines'],
      },
    ]);
    const answerQuality = buildAnswerQualityFixtureReport([
      {
        id: 'aaq-001',
        pass: true,
        rubricPass: true,
        patternCoveragePass: true,
        forbiddenPatternViolation: false,
        judgeScore: 1,
        durationMs: 1400,
      },
      {
        id: 'aaq-002',
        pass: false,
        rubricPass: false,
        patternCoveragePass: true,
        forbiddenPatternViolation: false,
        judgeScore: 0.5,
        durationMs: 1600,
      },
    ], 'gpt-5.4-mini', 1);

    expect(toolUse.tool_selection_accuracy).toBe(0.5);
    expect(toolUse.min_pass_rate).toBe(0.5);
    expect(answerQuality.rubric_pass_rate).toBe(0.5);
    expect(answerQuality.min_pass_rate).toBe(0.5);
  });
});

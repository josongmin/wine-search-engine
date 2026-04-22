import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentApiContractError,
  AgentApiPreflightError,
  AgentApiTransportError,
  assertAgentHttpEntrypointReady,
  callAgentApi,
  classifyAgentApiFailure,
  createJudgeLlmFromConfig,
  evaluateAnswerPatterns,
  evaluateExpectedToolSequence,
  normalizeAgentFixtureCase,
} from '../../../scripts/eval/agent-fixture-runner-common.ts';
import { buildToolUseFixtureReport } from '../../../scripts/eval/run-agentic-tool-use-fixture-eval.ts';
import { buildAnswerQualityFixtureReport } from '../../../scripts/eval/run-agentic-answer-quality-fixture-eval.ts';

describe('agent fixture runners', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it('accepts OPENAI_API_KEYS for fixture judge models', () => {
    const config = {
      openai: {
        apiKey: undefined,
        apiKeys: ['sk-a', 'sk-b'],
        baseUrl: 'https://api.openai.test/v1',
        chatModel: 'gpt-5.4-mini',
        httpTimeoutMs: 12345,
      },
      anthropic: {
        apiKey: undefined,
      },
    };

    const openAiJudge = createJudgeLlmFromConfig(config, 'gpt-5.4-mini');

    expect((openAiJudge as unknown as { httpTimeoutMs: number }).httpTimeoutMs).toBe(12345);
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
    expect(toolUse.transport).toBe('http');
    expect(toolUse.endpoint).toBe('/v1/agent');
    expect(toolUse.operation_id).toBe('agent.execute');
    expect(answerQuality.rubric_pass_rate).toBe(0.5);
    expect(answerQuality.min_pass_rate).toBe(0.5);
    expect(answerQuality.transport).toBe('http');
    expect(answerQuality.endpoint).toBe('/v1/agent');
    expect(answerQuality.operation_id).toBe('agent.execute');
  });

  it('validates agent API requests before transport', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(callAgentApi('http://localhost:3000', 'Opus One', 999)).rejects.toThrow(
      /request contract violation/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preflights the live agent HTTP entrypoint before fixture scoring', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: 'Bad Request', message: 'query is required', status_code: 400 }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(assertAgentHttpEntrypointReady('http://localhost:3000')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/v1/agent',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: '' }),
      }),
    );
  });

  it('fails preflight with an actionable error when /v1/agent is not registered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ message: 'Route POST:/v1/agent not found' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    )));

    await expect(assertAgentHttpEntrypointReady('http://127.0.0.1:3000')).rejects.toMatchObject({
      name: 'AgentApiPreflightError',
      kind: 'route_not_registered',
      message: expect.stringContaining('AGENT_ENABLED=true'),
    });
  });

  it('rejects preflight targets that do not enforce AgentRequestSchema', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ query_type: 'agent', answer: 'accepted invalid request' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    await expect(assertAgentHttpEntrypointReady('http://127.0.0.1:3000')).rejects.toBeInstanceOf(AgentApiPreflightError);
    await expect(assertAgentHttpEntrypointReady('http://127.0.0.1:3000')).rejects.toMatchObject({
      kind: 'request_contract_not_enforced',
    });
  });

  it('fails response contract violations distinctly from HTTP transport failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ query_type: 'agent', answer: 'missing required fields' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    await expect(callAgentApi('http://localhost:3000', 'Opus One', 3)).rejects.toThrow(
      /response contract violation/,
    );
  });

  it('classifies API failures for fixture reports', () => {
    expect(classifyAgentApiFailure(new AgentApiContractError('request', 'query: Required')).kind)
      .toBe('request_contract_violation');
    expect(classifyAgentApiFailure(new AgentApiContractError('response', 'meta: Required')).kind)
      .toBe('response_contract_violation');
    expect(classifyAgentApiFailure(new AgentApiTransportError('HTTP 503')).kind)
      .toBe('http_transport_failure');
  });
});

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
dotenv.config();
import { setTimeout as delay } from 'node:timers/promises';

import { loadConfig } from '../../src/config/env.js';
import { OpenAiChatLlm } from '../../src/infrastructure/ai/openai-chat-llm.js';
import { AnthropicChatLlm } from '../../src/infrastructure/ai/anthropic-chat-llm.js';
import type { ChatLlmPort } from '../../src/domain/ai/port/chat-llm.port.js';
import type { AgentBenchmarkScenario } from '../../test/benchmark/agent/scenario.js';
import { judgeAnswerN, type JudgeResult } from '../../test/benchmark/agent/judge.js';

export interface AgentFixtureExpectedTool {
  readonly tool: string;
  readonly input_contains?: readonly string[];
  readonly optional?: boolean;
}

export interface AgentFixtureCase {
  readonly id: string;
  readonly query: string;
  readonly language: 'ko' | 'en' | 'mixed';
  readonly difficulty: 'easy' | 'medium' | 'hard';
  readonly max_steps?: number;
  readonly max_duration_ms?: number;
  readonly expected_tools?: readonly AgentFixtureExpectedTool[];
  readonly answer_must_match?: readonly string[];
  readonly answer_must_not_match?: readonly string[];
  readonly rubric?: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function readRequiredString(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Fixture case is missing required string field: ${field}`);
  }
  return value;
}

function readOptionalNumber(record: Readonly<Record<string, unknown>>, field: string): number | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Fixture case field ${field} must be a finite number when present.`);
  }
  return value;
}

function readOptionalString(record: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Fixture case field ${field} must be a string when present.`);
  }
  return value;
}

function readEnumValue<T extends string>(
  record: Readonly<Record<string, unknown>>,
  field: string,
  allowed: readonly T[],
): T {
  const value = readRequiredString(record, field);
  if (!allowed.includes(value as T)) {
    throw new Error(`Fixture case field ${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function readOptionalStringArray(
  record: Readonly<Record<string, unknown>>,
  field: string,
): readonly string[] | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Fixture case field ${field} must be a string array when present.`);
  }
  return value;
}

function readExpectedTools(record: Readonly<Record<string, unknown>>): readonly AgentFixtureExpectedTool[] | undefined {
  const value = record['expected_tools'];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('Fixture case field expected_tools must be an array when present.');
  }
  return value.map((item, index): AgentFixtureExpectedTool => {
    if (!isRecord(item)) {
      throw new Error(`Fixture case expected_tools[${index}] must be an object.`);
    }
    const tool = item['tool'];
    if (typeof tool !== 'string' || tool.trim().length === 0) {
      throw new Error(`Fixture case expected_tools[${index}].tool must be a non-empty string.`);
    }
    const inputContains = item['input_contains'];
    if (
      inputContains !== undefined
      && (!Array.isArray(inputContains) || !inputContains.every((part) => typeof part === 'string'))
    ) {
      throw new Error(`Fixture case expected_tools[${index}].input_contains must be a string array when present.`);
    }
    const optional = item['optional'];
    if (optional !== undefined && typeof optional !== 'boolean') {
      throw new Error(`Fixture case expected_tools[${index}].optional must be boolean when present.`);
    }
    return {
      tool,
      ...(inputContains !== undefined ? { input_contains: inputContains } : {}),
      ...(optional !== undefined ? { optional } : {}),
    };
  });
}

function readFixtureEvaluation(raw: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const value = raw['evaluation'];
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error('Fixture case field evaluation must be an object when present.');
  }
  return value;
}

function preferEvaluationField(
  raw: Readonly<Record<string, unknown>>,
  evaluation: Readonly<Record<string, unknown>>,
  field: string,
): Readonly<Record<string, unknown>> {
  return evaluation[field] !== undefined ? evaluation : raw;
}

export function normalizeAgentFixtureCase(raw: unknown): AgentFixtureCase {
  if (!isRecord(raw)) {
    throw new Error('Fixture case must be an object.');
  }
  const evaluation = readFixtureEvaluation(raw);
  const maxStepsSource = preferEvaluationField(raw, evaluation, 'max_steps');
  const expectedToolsSource = preferEvaluationField(raw, evaluation, 'expected_tools');
  const mustMatchSource = preferEvaluationField(raw, evaluation, 'answer_must_match');
  const mustNotMatchSource = preferEvaluationField(raw, evaluation, 'answer_must_not_match');
  const rubricSource = preferEvaluationField(raw, evaluation, 'rubric');

  return {
    id: readRequiredString(raw, 'id'),
    query: readRequiredString(raw, 'query'),
    language: readEnumValue(raw, 'language', ['ko', 'en', 'mixed']),
    difficulty: readEnumValue(raw, 'difficulty', ['easy', 'medium', 'hard']),
    max_steps: readOptionalNumber(maxStepsSource, 'max_steps'),
    expected_tools: readExpectedTools(expectedToolsSource),
    answer_must_match: readOptionalStringArray(mustMatchSource, 'answer_must_match'),
    answer_must_not_match: readOptionalStringArray(mustNotMatchSource, 'answer_must_not_match'),
    rubric: readOptionalString(rubricSource, 'rubric'),
  };
}

interface AgentStepLike {
  readonly action?: { readonly tool: string; readonly input: Record<string, unknown> } | undefined;
  readonly actions?: readonly { readonly tool: string; readonly input: Record<string, unknown> }[] | undefined;
}

interface AgentResponseLike {
  readonly answer: string;
  readonly steps: readonly AgentStepLike[];
  readonly meta: {
    readonly total_duration_ms: number;
    readonly tool_call_count: number;
    readonly termination_reason: string;
  };
}

export async function callAgentApi(
  apiUrl: string,
  query: string,
  maxSteps?: number,
  timeoutMs = 90_000,
): Promise<AgentResponseLike> {
  const normalizedApiUrl = apiUrl.replace(/^http:\/\/localhost(?=[:/]|$)/u, 'http://127.0.0.1');
  const maxTransportAttempts = 5;
  let lastTransportError: unknown;
  for (let attempt = 1; attempt <= maxTransportAttempts; attempt++) {
    try {
      const response = await fetch(`${normalizedApiUrl}/v1/agent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          connection: 'close',
        },
        body: JSON.stringify({
          query,
          ...(maxSteps !== undefined ? { options: { max_steps: maxSteps } } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '(unreadable)');
        throw new Error(`HTTP ${response.status} from /v1/agent: ${body.slice(0, 400)}`);
      }

      const payload = await response.json() as AgentResponseLike;
      lastTransportError = undefined;
      return payload;
    } catch (err) {
      lastTransportError = err;
      if (attempt < maxTransportAttempts) {
        await delay(400 * attempt);
      }
    }
  }

  const message = lastTransportError instanceof Error ? lastTransportError.message : String(lastTransportError);
  throw new Error(`Fetch failed for /v1/agent query "${query.slice(0, 120)}": ${message}`);
}

export function collectToolCalls(steps: readonly AgentStepLike[]): readonly {
  readonly tool: string;
  readonly input: string;
}[] {
  const toolCalls: { readonly tool: string; readonly input: string }[] = [];
  for (const step of steps) {
    if (step.action !== undefined) {
      toolCalls.push({
        tool: step.action.tool,
        input: JSON.stringify(step.action.input),
      });
    }
    if (step.actions !== undefined) {
      for (const action of step.actions) {
        toolCalls.push({
          tool: action.tool,
          input: JSON.stringify(action.input),
        });
      }
    }
  }
  return toolCalls;
}

export function evaluateExpectedToolSequence(
  toolCalls: readonly { readonly tool: string; readonly input: string }[],
  expectedTools: readonly AgentFixtureExpectedTool[],
): boolean {
  let cursor = 0;

  for (const expectedTool of expectedTools) {
    let matchedIndex = -1;
    for (let i = cursor; i < toolCalls.length; i++) {
      const actual = toolCalls[i];
      if (actual?.tool !== expectedTool.tool) continue;
      const inputsSatisfied = (expectedTool.input_contains ?? []).every(
        (needle) => actual.input.toLowerCase().includes(needle.toLowerCase()),
      );
      if (!inputsSatisfied) continue;
      matchedIndex = i;
      break;
    }

    if (matchedIndex === -1) {
      if (expectedTool.optional === true) {
        continue;
      }
      return false;
    }

    cursor = matchedIndex + 1;
  }

  return true;
}

export function evaluateAnswerPatterns(
  answer: string,
  mustMatch: readonly string[] | undefined,
  mustNotMatch: readonly string[] | undefined,
): {
  readonly patternCoveragePass: boolean;
  readonly forbiddenPatternViolation: boolean;
} {
  const normalized = answer.normalize('NFKC');
  const patternCoveragePass = (mustMatch ?? []).every((pattern) => new RegExp(pattern, 'iu').test(normalized));
  const forbiddenPatternViolation = (mustNotMatch ?? []).some((pattern) => new RegExp(pattern, 'iu').test(normalized));
  return {
    patternCoveragePass,
    forbiddenPatternViolation,
  };
}

export interface JudgeLlmConfig {
  readonly openai: {
    readonly apiKey: string | undefined;
    readonly baseUrl: string;
    readonly chatModel: string;
    readonly httpTimeoutMs: number;
  };
  readonly anthropic: {
    readonly apiKey: string | undefined;
  };
}

export function createJudgeLlmFromConfig(config: JudgeLlmConfig, modelId?: string): ChatLlmPort {
  const judgeModelId = modelId ?? config.openai.chatModel;
  if (judgeModelId.startsWith('claude-')) {
    if (config.anthropic.apiKey === undefined) {
      throw new Error('ANTHROPIC_API_KEY required for claude-* fixture judge models.');
    }
    return new AnthropicChatLlm({
      apiKey: config.anthropic.apiKey,
      defaultModel: judgeModelId,
      httpTimeoutMs: config.openai.httpTimeoutMs,
    });
  }

  if (config.openai.apiKey === undefined) {
    throw new Error('OPENAI_API_KEY required for OpenAI fixture judge models.');
  }

  return new OpenAiChatLlm({
    apiKey: config.openai.apiKey,
    baseUrl: config.openai.baseUrl,
    defaultModel: judgeModelId,
    httpTimeoutMs: config.openai.httpTimeoutMs,
  });
}

export function createJudgeLlm(modelId?: string): ChatLlmPort {
  const config = loadConfig();
  return createJudgeLlmFromConfig(config, modelId);
}

export async function judgeFixtureAnswer(
  judgeLlm: ChatLlmPort,
  benchmarkCase: AgentFixtureCase,
  answer: string,
  samples: number,
): Promise<JudgeResult> {
  const scenario: AgentBenchmarkScenario = {
    id: -1,
    tier: 'single_shot',
    query: benchmarkCase.query,
    description: benchmarkCase.id,
    expectation: {
      maxSteps: benchmarkCase.max_steps ?? 3,
      answerMustMatch: benchmarkCase.answer_must_match,
      answerMustNotMatch: benchmarkCase.answer_must_not_match,
      rubric: benchmarkCase.rubric,
    },
  };
  return judgeAnswerN(judgeLlm, scenario, answer, samples);
}

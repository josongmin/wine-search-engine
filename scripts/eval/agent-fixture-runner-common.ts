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
import {
  AgentRequestSchema,
  AgentResponseSchema,
  type AgentResponseBody,
} from '../../src/interface/http/schemas/agent.schema.js';

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

type AgentStepLike = AgentResponseBody['steps'][number];

export class AgentApiContractError extends Error {
  constructor(
    readonly phase: 'request' | 'response',
    message: string,
  ) {
    super(`${phase} contract violation: ${message}`);
    this.name = 'AgentApiContractError';
  }
}

export class AgentApiTransportError extends Error {
  constructor(message: string) {
    super(`HTTP transport failure: ${message}`);
    this.name = 'AgentApiTransportError';
  }
}

export class AgentApiPreflightError extends Error {
  constructor(
    readonly kind: 'unreachable' | 'route_not_registered' | 'request_contract_not_enforced' | 'unexpected_status',
    message: string,
  ) {
    super(`Agent HTTP preflight failed: ${message}`);
    this.name = 'AgentApiPreflightError';
  }
}

export type AgentApiFailureKind =
  | 'http_transport_failure'
  | 'request_contract_violation'
  | 'response_contract_violation'
  | 'unexpected_failure';

export interface AgentApiFailureClassification {
  readonly kind: AgentApiFailureKind;
  readonly message: string;
}

function formatZodIssues(issues: readonly { readonly path: readonly (string | number)[]; readonly message: string }[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function isAgentApiContractError(err: unknown): err is AgentApiContractError {
  return err instanceof AgentApiContractError;
}

function normalizeAgentApiUrl(apiUrl: string): string {
  return apiUrl.replace(/^http:\/\/localhost(?=[:/]|$)/u, 'http://127.0.0.1').replace(/\/+$/u, '');
}

export function classifyAgentApiFailure(err: unknown): AgentApiFailureClassification {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof AgentApiContractError) {
    return {
      kind: err.phase === 'request' ? 'request_contract_violation' : 'response_contract_violation',
      message,
    };
  }
  if (err instanceof AgentApiTransportError) {
    return { kind: 'http_transport_failure', message };
  }
  return { kind: 'unexpected_failure', message };
}

export async function assertAgentHttpEntrypointReady(
  apiUrl: string,
  timeoutMs = 10_000,
): Promise<void> {
  const normalizedApiUrl = normalizeAgentApiUrl(apiUrl);
  let response: Response;
  try {
    response = await fetch(`${normalizedApiUrl}/v1/agent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        connection: 'close',
      },
      body: JSON.stringify({ query: '' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AgentApiPreflightError(
      'unreachable',
      `could not reach ${normalizedApiUrl}/v1/agent (${message}). Set SEARCH_API_URL or --api-url to the agent-enabled API process.`,
    );
  }

  const body = await response.text().catch(() => '(unreadable)');
  if (response.status === 400) {
    return;
  }

  if (response.status === 404) {
    throw new AgentApiPreflightError(
      'route_not_registered',
      `POST /v1/agent returned 404 from ${normalizedApiUrl}. This target is not running the production agent HTTP entrypoint. Start the API with AGENT_ENABLED=true and OPENAI_API_KEY/OPENAI_API_KEYS, or pass --api-url/SEARCH_API_URL for the agent-enabled server. Body: ${body.slice(0, 400)}`,
    );
  }

  if (response.ok) {
    throw new AgentApiPreflightError(
      'request_contract_not_enforced',
      `POST /v1/agent accepted an invalid empty query with HTTP ${response.status}. The target is not enforcing AgentRequestSchema. Body: ${body.slice(0, 400)}`,
    );
  }

  throw new AgentApiPreflightError(
    'unexpected_status',
    `POST /v1/agent returned HTTP ${response.status} from ${normalizedApiUrl}; expected HTTP 400 for the invalid-contract probe. Body: ${body.slice(0, 400)}`,
  );
}

export async function callAgentApi(
  apiUrl: string,
  query: string,
  maxSteps?: number,
  timeoutMs = 90_000,
): Promise<AgentResponseBody> {
  const normalizedApiUrl = normalizeAgentApiUrl(apiUrl);
  const requestBody = {
    query,
    ...(maxSteps !== undefined ? { options: { max_steps: maxSteps } } : {}),
  };
  const parsedRequest = AgentRequestSchema.safeParse(requestBody);
  if (!parsedRequest.success) {
    throw new AgentApiContractError('request', formatZodIssues(parsedRequest.error.issues));
  }

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
        body: JSON.stringify(parsedRequest.data),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '(unreadable)');
        throw new AgentApiTransportError(`HTTP ${response.status} from /v1/agent: ${body.slice(0, 400)}`);
      }

      let rawPayload: unknown;
      try {
        rawPayload = await response.json();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new AgentApiContractError('response', `invalid JSON from /v1/agent: ${message}`);
      }

      const parsedResponse = AgentResponseSchema.safeParse(rawPayload);
      if (!parsedResponse.success) {
        throw new AgentApiContractError('response', formatZodIssues(parsedResponse.error.issues));
      }

      lastTransportError = undefined;
      return parsedResponse.data;
    } catch (err) {
      if (isAgentApiContractError(err)) {
        throw err;
      }
      lastTransportError = err;
      if (attempt < maxTransportAttempts) {
        await delay(400 * attempt);
      }
    }
  }

  const message = lastTransportError instanceof Error ? lastTransportError.message : String(lastTransportError);
  throw new AgentApiTransportError(`fetch failed for /v1/agent query "${query.slice(0, 120)}": ${message}`);
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
    readonly apiKeys?: readonly string[] | undefined;
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

  const openAiApiKeys =
    config.openai.apiKeys !== undefined && config.openai.apiKeys.length > 0
      ? config.openai.apiKeys
      : config.openai.apiKey !== undefined
        ? [config.openai.apiKey]
        : [];
  if (openAiApiKeys.length === 0) {
    throw new Error('OPENAI_API_KEY or OPENAI_API_KEYS required for OpenAI fixture judge models.');
  }

  return new OpenAiChatLlm({
    apiKeys: openAiApiKeys,
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

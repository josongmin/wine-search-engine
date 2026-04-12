import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
dotenv.config();

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
  const response = await fetch(`${apiUrl}/v1/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

  return response.json() as Promise<AgentResponseLike>;
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

export function createJudgeLlm(modelId?: string): ChatLlmPort {
  const config = loadConfig();
  const judgeModelId = modelId ?? config.openai.chatModel;
  if (judgeModelId.startsWith('claude-')) {
    return new AnthropicChatLlm({
      apiKey: config.anthropic.apiKey,
      defaultModel: judgeModelId,
      timeoutMs: config.anthropic.timeoutMs,
      maxRetries: config.anthropic.maxRetries,
    });
  }

  return new OpenAiChatLlm({
    apiKey: config.openai.apiKey,
    baseUrl: config.openai.baseUrl,
    defaultModel: judgeModelId,
    timeoutMs: config.openai.timeoutMs,
    maxRetries: config.openai.maxRetries,
  });
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

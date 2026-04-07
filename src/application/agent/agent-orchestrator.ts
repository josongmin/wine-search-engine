/**
 * ReAct Agent Orchestrator — the core agentic loop.
 *
 * Flow:
 *   1. Build system prompt + user query
 *   2. Loop: LLM reasons → tool call OR answer
 *   3. Tool results become observations → feed back to LLM
 *   4. Terminate on: answer | max_steps | timeout | loop | error
 *   5. Fallback to single-shot search if LLM fails entirely
 *
 * All search execution uses existing use cases unchanged.
 */

import type { ChatLlmPort } from '../../domain/ai/port/chat-llm.port.js';
import type { AgentConfig } from '../../domain/agent/model/agent-config.js';
import type { AgentResult } from '../../domain/agent/model/agent-result.js';
import type { AgentStep, AgentTerminationReason } from '../../domain/agent/model/agent-step.js';
import { DEFAULT_AGENT_CONFIG } from '../../domain/agent/model/agent-config.js';
import { StepBudget } from '../../domain/agent/service/step-budget.js';
import {
  buildSystemMessage,
  buildUserMessage,
  buildStepMessages,
  truncateObservation,
} from './agent-prompt.js';
import {
  executeAgentTool,
  isKnownTool,
  type AgentToolDeps,
} from './agent-tools.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

const log = bootstrapLogger.child({ component: 'AgentOrchestrator' });

/** Parsed LLM output — either a tool call or a final answer. */
interface LlmAction {
  readonly thought: string;
  readonly action?: { readonly tool: string; readonly input: Record<string, unknown> };
  readonly answer?: string;
}

function parseLlmOutput(text: string): LlmAction {
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    const thought = typeof parsed['thought'] === 'string' ? parsed['thought'] : '';

    if (typeof parsed['answer'] === 'string') {
      return { thought, answer: parsed['answer'] };
    }

    const action = parsed['action'] as Record<string, unknown> | undefined;
    if (action !== undefined && typeof action['tool'] === 'string' && action['tool'].length > 0) {
      const input = (typeof action['input'] === 'object' && action['input'] !== null)
        ? action['input'] as Record<string, unknown>
        : {};
      return { thought, action: { tool: action['tool'], input } };
    }

    // If neither action nor answer, treat the whole text as an answer
    return { thought, answer: text };
  } catch {
    // LLM returned non-JSON — treat as direct answer
    return { thought: '', answer: text };
  }
}

export interface AgentOrchestratorDeps {
  readonly chatLlm: ChatLlmPort;
  readonly toolDeps: AgentToolDeps;
}

export class AgentOrchestrator {
  private readonly config: AgentConfig;

  constructor(
    private readonly deps: AgentOrchestratorDeps,
    config?: Partial<AgentConfig>,
  ) {
    this.config = { ...DEFAULT_AGENT_CONFIG, ...config };
  }

  async execute(query: string, requestId: string): Promise<AgentResult> {
    const budget = new StepBudget(this.config);
    const steps: AgentStep[] = [];
    let lastSearchResult: SearchResponseV1 | undefined;
    let terminationReason: AgentTerminationReason = 'max_steps';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    try {
      while (true) {
        // Budget check
        const budgetCheck = budget.canProceed();
        if (!budgetCheck.allowed) {
          terminationReason = budgetCheck.reason ?? 'max_steps';
          break;
        }

        // Build messages
        const messages = [
          buildSystemMessage(),
          buildUserMessage(query),
          ...buildStepMessages(steps),
        ];

        // LLM call with per-step timeout (clearTimeout on success to prevent leak)
        const stepStart = Date.now();
        let llmResult: { text: string; model: string };
        let stepTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
          llmResult = await Promise.race([
            this.deps.chatLlm.complete({
              messages,
              temperature: 0,
              maxOutputTokens: 1024,
            }),
            new Promise<never>((_resolve, reject) => {
              stepTimeoutHandle = setTimeout(
                () => reject(new Error('Agent LLM step timed out')),
                this.config.perStepTimeoutMs,
              );
            }),
          ]);
        } catch (err) {
          log.warn({ err, requestId, stepIndex: steps.length }, 'Agent LLM call failed');
          terminationReason = 'error';
          break;
        } finally {
          if (stepTimeoutHandle !== undefined) {
            clearTimeout(stepTimeoutHandle);
          }
        }

        // Estimate token counts (rough: 4 chars ≈ 1 token)
        const inputChars = messages.reduce((sum, m) => sum + m.content.length, 0);
        const inputTokens = Math.ceil(inputChars / 4);
        const outputTokens = Math.ceil(llmResult.text.length / 4);
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;

        // Parse LLM output
        const parsed = parseLlmOutput(llmResult.text);

        // Final answer
        if (parsed.answer !== undefined) {
          steps.push({
            index: steps.length,
            thought: parsed.thought,
            answer: parsed.answer,
            durationMs: Date.now() - stepStart,
            tokenCount: { input: inputTokens, output: outputTokens },
          });
          terminationReason = 'answer';
          break;
        }

        // Tool call
        if (parsed.action !== undefined) {
          const { tool, input } = parsed.action;

          // Loop detection
          const loopCheck = budget.recordStep(tool, input);
          if (!loopCheck.allowed) {
            terminationReason = loopCheck.reason ?? 'loop_detected';
            break;
          }

          // Unknown tool guard
          if (!isKnownTool(tool)) {
            steps.push({
              index: steps.length,
              thought: parsed.thought,
              action: { tool, input },
              observation: `Unknown tool: ${tool}. Available: search_wines, compare_wines, check_drinking_window, get_food_pairings`,
              durationMs: Date.now() - stepStart,
              tokenCount: { input: inputTokens, output: outputTokens },
            });
            continue;
          }

          // Execute tool
          let observation: string;
          let rawResult: unknown;
          try {
            const toolResult = await executeAgentTool(
              tool,
              input,
              this.deps.toolDeps,
              `${requestId}-step${steps.length}`,
            );
            observation = truncateObservation(toolResult.observation, this.config.maxContextChars);
            rawResult = toolResult.rawResult;
          } catch (toolErr) {
            observation = `Tool error: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`;
            rawResult = null;
          }

          // Track last search result for inclusion in final response
          if (
            rawResult !== null &&
            typeof rawResult === 'object' &&
            'queryType' in (rawResult as Record<string, unknown>) &&
            (rawResult as Record<string, unknown>)['queryType'] === 'search'
          ) {
            lastSearchResult = rawResult as SearchResponseV1;
          }

          steps.push({
            index: steps.length,
            thought: parsed.thought,
            action: { tool, input },
            observation,
            durationMs: Date.now() - stepStart,
            tokenCount: { input: inputTokens, output: outputTokens },
          });
        }
      }
    } catch (err) {
      log.error({ err, requestId }, 'Agent orchestrator unexpected error');
      terminationReason = 'error';
    }

    // Fallback: if no answer was produced, do a single-shot search
    let fallbackApplied = false;
    let answer = steps.find((s) => s.answer !== undefined)?.answer ?? '';

    if (answer === '' && terminationReason !== 'answer') {
      try {
        const fallbackResult = await this.deps.toolDeps.searchUseCase.execute(
          { query },
          `${requestId}-fallback`,
        );
        const topResult = fallbackResult.queryType === 'search' ? fallbackResult.results[0] : undefined;
        if (topResult !== undefined) {
          answer = `${topResult.entity.canonicalLabel} (${topResult.entity.producer ?? ''} ${topResult.entity.region ?? ''})`;
          lastSearchResult = fallbackResult.queryType === 'search' ? fallbackResult : undefined;
          fallbackApplied = true;
          terminationReason = 'fallback';
        }
      } catch {
        // Fallback also failed — return empty answer
      }
    }

    log.info(
      {
        requestId,
        steps: steps.length,
        toolCalls: steps.filter((s) => s.action !== undefined).length,
        terminationReason,
        totalDurationMs: budget.getElapsedMs(),
        fallbackApplied,
      },
      'Agent execution complete',
    );

    return {
      answer,
      steps,
      totalDurationMs: budget.getElapsedMs(),
      totalTokens: { input: totalInputTokens, output: totalOutputTokens },
      toolCallCount: steps.filter((s) => s.action !== undefined).length,
      fallbackApplied,
      terminationReason,
      ...(lastSearchResult !== undefined ? { searchResults: lastSearchResult } : {}),
    };
  }
}

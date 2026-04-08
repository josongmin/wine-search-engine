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
import { DomainError } from '../../domain/shared/error/domain-error.js';
import { POLICY_BLOCKED_CODE } from '../../domain/shared/error/policy-blocked.js';
import type { AgentConfig } from '../../domain/agent/model/agent-config.js';
import type { AgentResult } from '../../domain/agent/model/agent-result.js';
import type { AgentStep, AgentTerminationReason } from '../../domain/agent/model/agent-step.js';
import { DEFAULT_AGENT_CONFIG } from '../../domain/agent/model/agent-config.js';
import { StepBudget } from '../../domain/agent/service/step-budget.js';
import { classifyQueryBudget } from '../../domain/agent/service/adaptive-budget.js';
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
    // Trim first, then strip markdown code fences (anchored ^ needs trimmed input).
    // The previous regex `^```json?\s*` matched only "```jso" or "```json" — plain
    // ``` fences (no language tag) that LLMs often emit fell through and broke JSON.parse.
    const trimmed = text.trim();
    // Strip ANY language tag (typescript, yaml, plain, etc.). Models routinely
    // emit ` ```json `, ` ``` `, ` ```typescript `, etc. — restricting to a
    // small whitelist degrades the agent to passthrough on legitimate JSON.
    const cleaned = trimmed
      .replace(/^```[\w-]*\s*\n?/i, '')
      .replace(/\s*```$/i, '')
      .trim();
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

    // If neither action nor answer, treat the whole text as an answer.
    // Logged as warn so ops can detect a model that's no longer following the
    // structured output protocol — otherwise this silently degrades to passthrough.
    log.warn(
      { textPreview: trimmed.slice(0, 200) },
      'agent LLM produced JSON without action or answer; falling back to raw text',
    );
    return { thought: '[unparseable LLM structure]', answer: trimmed };
  } catch {
    // LLM returned non-JSON — treat as direct answer.
    log.warn(
      { textPreview: text.slice(0, 200) },
      'agent LLM produced non-JSON output; falling back to raw text',
    );
    return { thought: '[unparseable LLM output]', answer: text.trim() };
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

  async execute(
    query: string,
    requestId: string,
    overrides?: Partial<Pick<AgentConfig, 'maxSteps' | 'perStepTimeoutMs' | 'agentTimeoutMs'>>,
  ): Promise<AgentResult> {
    // Adaptive step budget — lexical classifier picks a tighter ceiling for
    // specific SKU lookups, adversarial probes, and off-domain queries.
    // Caller-supplied overrides win; classifier only fires when override
    // absent. Returns undefined for queries without a clear class, falling
    // back to this.config.maxSteps.
    const adaptive = overrides?.maxSteps === undefined ? classifyQueryBudget(query) : undefined;
    const effectiveConfig = {
      ...this.config,
      ...(adaptive !== undefined ? { maxSteps: adaptive.maxSteps } : {}),
      ...(overrides ?? {}),
    };
    if (adaptive !== undefined) {
      log.info(
        { requestId, classification: adaptive.classification, maxSteps: adaptive.maxSteps, reason: adaptive.reason },
        'adaptive step budget applied',
      );
    }
    const budget = new StepBudget(effectiveConfig);
    const steps: AgentStep[] = [];
    let lastSearchResult: SearchResponseV1 | undefined;
    let terminationReason: AgentTerminationReason = 'max_steps';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    /**
     * Set when a tool execution surfaced a policy block. Prevents the
     * single-shot fallback from re-running the raw query through the
     * search use case after the agent's protective layers said no.
     */
    let policyBlocked = false;
    let unknownToolAttempts = 0;
    const MAX_UNKNOWN_TOOL_ATTEMPTS = 2;

    try {
      while (true) {
        // Budget check — enforce BOTH step count AND wall-clock timeout.
        // The previous code only checked steps; a chain of perStepTimeoutMs
        // steps could exceed agentTimeoutMs without ever tripping canProceed.
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

        // LLM call with per-step timeout and AbortSignal propagation.
        // The AbortController cancels the underlying HTTP request when the
        // timeout fires, preventing orphaned in-flight requests.
        const stepStart = Date.now();
        let llmResult: { text: string; model: string; finishReason?: string | null };
        const stepAbortController = new AbortController();
        let stepTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
          llmResult = await Promise.race([
            this.deps.chatLlm.complete({
              messages,
              temperature: 0,
              maxOutputTokens: 1024,
              ...(effectiveConfig.seed !== undefined ? { seed: effectiveConfig.seed } : {}),
              abortSignal: stepAbortController.signal,
            }),
            new Promise<never>((_resolve, reject) => {
              stepTimeoutHandle = setTimeout(
                () => {
                  stepAbortController.abort();
                  reject(new Error('Agent LLM step timed out'));
                },
                effectiveConfig.perStepTimeoutMs,
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

        // Guard against truncated output (LLM hit max_tokens)
        if (llmResult.finishReason === 'length') {
          log.warn({ requestId, stepIndex: steps.length }, 'Agent LLM output truncated (finish_reason=length)');
          terminationReason = 'error';
          break;
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

          // Unknown tool guard FIRST — do not consume budget on adversarial
          // LLM-emitted unknown tool names. Adds an observation step but
          // does not call recordStep so the loop counter is preserved.
          // Cap unknown-tool attempts to prevent infinite loops from an
          // adversarial or confused LLM that keeps emitting the same
          // invalid tool name.
          if (!isKnownTool(tool)) {
            unknownToolAttempts++;
            if (unknownToolAttempts > MAX_UNKNOWN_TOOL_ATTEMPTS) {
              terminationReason = 'error';
              break;
            }
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

          // Loop detection (only for known tools)
          const loopCheck = budget.recordStep(tool, input);
          if (!loopCheck.allowed) {
            terminationReason = loopCheck.reason ?? 'loop_detected';
            break;
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
            // Detect policy-block errors so the fallback doesn't re-run the
            // raw query through the same security layer that already rejected it.
            if (toolErr instanceof DomainError && toolErr.code === POLICY_BLOCKED_CODE) {
              policyBlocked = true;
            }
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
      if (err instanceof DomainError && err.code === POLICY_BLOCKED_CODE) {
        policyBlocked = true;
      }
    }

    // Fallback: if no answer was produced, do a single-shot search.
    // Skip when a policy block already rejected the query — re-running
    // the raw query through the search use case would just hit the same
    // security gate (or worse, slip through if the gate state changed).
    let fallbackApplied = false;
    let answer = steps.find((s) => s.answer !== undefined)?.answer ?? '';

    if (!policyBlocked && answer === '' && terminationReason !== 'answer') {
      // Cap the fallback search at a fixed wall-clock budget independent of
      // perStepTimeoutMs. The previous Math.min(perStep, 5s) was inverted:
      // when operators tuned perStepTimeoutMs LOW (e.g. 2s), the fallback got
      // the SAME 2s the agent already exhausted, making it useless.
      const FALLBACK_SEARCH_TIMEOUT_MS = 5_000;
      const fallbackController = new AbortController();
      const fallbackTimer = setTimeout(
        () => {
          fallbackController.abort();
        },
        FALLBACK_SEARCH_TIMEOUT_MS,
      );
      try {
        const fallbackResult = await this.deps.toolDeps.searchUseCase.execute(
          { query },
          `${requestId}-fallback`,
          { abortSignal: fallbackController.signal },
        );
        const topResult = fallbackResult.queryType === 'search' ? fallbackResult.results[0] : undefined;
        if (topResult !== undefined) {
          const producer = topResult.entity.producer ?? '';
          const region = topResult.entity.region ?? '';
          const detail = [producer, region].filter(Boolean).join(', ');
          answer = `Based on your query, I found: ${topResult.entity.canonicalLabel}${detail ? ` (${detail})` : ''}. (Note: simplified result due to processing constraints.)`;
          lastSearchResult = fallbackResult.queryType === 'search' ? fallbackResult : undefined;
          fallbackApplied = true;
          terminationReason = 'fallback';
        }
      } catch (err) {
        // Log so an outage of the fallback path is observable instead of silent.
        log.warn({ err, requestId }, 'agent fallback search failed');
      } finally {
        clearTimeout(fallbackTimer);
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

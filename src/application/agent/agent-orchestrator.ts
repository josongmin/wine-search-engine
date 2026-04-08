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
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
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

/** Wall-clock budget for the observation-based synthesis LLM call (Layer 1 fallback). */
const SYNTHESIS_TIMEOUT_MS = 12_000;
/** Wall-clock budget for the Layer 2 single-shot fallback search. */
const FALLBACK_SEARCH_TIMEOUT_MS = 5_000;

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
  /**
   * Optional pre-execution security gate. When provided, queries that fail
   * sanitization (injection, jailbreak, PII extraction, etc.) are refused
   * immediately without calling any LLM or tool — they return terminationReason='blocked'.
   * When absent, the per-tool security gates still apply (defence-in-depth).
   */
  readonly querySanitizer?: QuerySanitizer | undefined;
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
    // Empty query: return immediately without tool calls.
    if (query.trim().length === 0) {
      return {
        answer: '검색어를 입력해주세요. 어떤 와인을 찾고 계신가요?',
        steps: [],
        totalDurationMs: 0,
        totalTokens: { input: 0, output: 0 },
        toolCallCount: 0,
        fallbackApplied: false,
        terminationReason: 'answer',
      };
    }

    // Security pre-check: if a sanitizer is wired in, refuse injection/jailbreak/PII
    // queries immediately before any LLM or tool call. This ensures expectedBlocked
    // adversarial scenarios terminate with reason='blocked' and 0 tool calls.
    if (this.deps.querySanitizer !== undefined) {
      const sanitizeResult = this.deps.querySanitizer.sanitize(query);
      if (!sanitizeResult.safe) {
        log.warn(
          { requestId, reason: sanitizeResult.reason },
          'Agent pre-check blocked query before LLM call',
        );
        return {
          answer: '이 요청은 처리할 수 없습니다. 와인 검색과 관련된 질문을 해주세요.',
          steps: [],
          totalDurationMs: 0,
          totalTokens: { input: 0, output: 0 },
          toolCallCount: 0,
          fallbackApplied: false,
          terminationReason: 'blocked',
        };
      }
    }

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
    /**
     * Set after the first zero-result observation so we inject the constraint-
     * relaxation hint exactly once into the next LLM user message.
     */
    let hasInjectedRefinementHint = false;
    /**
     * Pending hint text to prepend to the next user message in the ReAct loop.
     * Cleared to undefined after it is consumed.
     */
    let pendingRefinementHint: string | undefined;

    try {
      for (;;) {
        // Budget check — enforce BOTH step count AND wall-clock timeout.
        // The previous code only checked steps; a chain of perStepTimeoutMs
        // steps could exceed agentTimeoutMs without ever tripping canProceed.
        const budgetCheck = budget.canProceed();
        if (!budgetCheck.allowed) {
          terminationReason = budgetCheck.reason ?? 'max_steps';
          break;
        }

        // Synthesize-before-exhaustion: when 1 step remains and we already have
        // observations, nudge the LLM to produce a final answer rather than
        // burning the last step on another tool call that will hit fallback.
        const remainingSteps = effectiveConfig.maxSteps - budget.getStepCount();
        const hasObservations = steps.some((s) => s.observation !== undefined);
        const isLastStep = remainingSteps === 1 && hasObservations;

        // Pre-flight token budget check — prevent unnecessary LLM calls when
        // the budget is already exhausted. The check uses accumulated totals
        // from prior steps, so the FIRST step always executes.
        if (totalInputTokens + totalOutputTokens >= effectiveConfig.maxTotalTokens) {
          log.warn(
            { requestId, totalTokens: totalInputTokens + totalOutputTokens, budget: effectiveConfig.maxTotalTokens },
            'agent token budget exhausted before LLM call — terminating',
          );
          terminationReason = 'budget';
          break;
        }

        // Build messages
        // Consume any pending refinement hint by prepending it to the query message.
        // The hint is only injected once (hasInjectedRefinementHint guards re-entry).
        const baseUserContent = pendingRefinementHint !== undefined
          ? `${pendingRefinementHint}\n\n${query}`
          : query;
        pendingRefinementHint = undefined;
        const userMsg = buildUserMessage(baseUserContent);
        const messages = [
          buildSystemMessage(),
          ...(isLastStep
            ? [{ ...userMsg, content: userMsg.content + '\n\n[SYSTEM: This is your LAST step. You MUST provide a final answer NOW using the information you have gathered. Do NOT call another tool.]' }]
            : [userMsg]),
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

        // Hard token budget cap — prevents resource exhaustion from bloated
        // context windows. The estimate is rough but sufficient as a guard.
        if (totalInputTokens + totalOutputTokens > effectiveConfig.maxTotalTokens) {
          log.warn(
            { requestId, totalTokens: totalInputTokens + totalOutputTokens, budget: effectiveConfig.maxTotalTokens },
            'agent token budget exceeded — terminating',
          );
          terminationReason = 'budget';
          break;
        }

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
            // Detect policy-block errors — terminate the loop immediately.
            // The agent must NOT continue calling tools after a security block.
            if (toolErr instanceof DomainError && toolErr.code === POLICY_BLOCKED_CODE) {
              policyBlocked = true;
              terminationReason = 'blocked';
              steps.push({
                index: steps.length,
                thought: parsed.thought,
                action: { tool, input },
                observation: `Policy blocked: ${toolErr.message}`,
                durationMs: Date.now() - stepStart,
                tokenCount: { input: inputTokens, output: outputTokens },
              });
              break;
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

          // Constraint-relaxation hint: if the observation indicates zero results
          // and we have enough remaining steps, inject a hint once into the next
          // LLM message to guide iterative constraint relaxation.
          const remainingStepsAfterTool = effectiveConfig.maxSteps - budget.getStepCount();
          if (
            !hasInjectedRefinementHint &&
            remainingStepsAfterTool >= 3 &&
            (observation.includes('0개') || observation.includes('검색 결과가 없습니다'))
          ) {
            hasInjectedRefinementHint = true;
            pendingRefinementHint =
              'HINT: 이전 검색에서 결과가 없었습니다. 가장 제한적인 조건(가격/품종/지역)을 하나씩 완화하여 재검색하세요. 예: 가격 조건을 넓히거나 지역 조건을 제거하고 재검색.';
          }
        }
      }
    } catch (err) {
      log.error({ err, requestId }, 'Agent orchestrator unexpected error');
      if (err instanceof DomainError && err.code === POLICY_BLOCKED_CODE) {
        policyBlocked = true;
        terminationReason = 'blocked';
      } else {
        terminationReason = 'error';
      }
    }

    // Fallback: if no answer was produced, do a single-shot search.
    // Skip when a policy block already rejected the query — re-running
    // the raw query through the search use case would just hit the same
    // security gate (or worse, slip through if the gate state changed).
    let fallbackApplied = false;
    let answer = steps.find((s) => s.answer !== undefined)?.answer ?? '';

    // Observation-based synthesis: if we have tool results but no answer,
    // try to synthesize from what we already gathered before doing a fresh search.
    // This avoids the "agent ran 3 steps, got great results, then returned nothing" failure.
    if (!policyBlocked && answer === '' && terminationReason !== 'answer') {
      const obsSteps = steps.filter((s) => s.observation !== undefined && s.observation.length > 0);
      if (obsSteps.length > 0) {
        const synthMessages = [
          buildSystemMessage(),
          buildUserMessage(query),
          ...buildStepMessages(steps),
          {
            role: 'user' as const,
            content: '[SYSTEM: You have gathered information but did not provide a final answer. Based on the tool results above, provide your final answer NOW.]',
          },
        ];
        const attemptSynthesis = async (maxOutputTokens: number): Promise<string | undefined> => {
          const synthAbort = new AbortController();
          const synthTimer = setTimeout(() => {
            synthAbort.abort();
          }, SYNTHESIS_TIMEOUT_MS);
          try {
            const synthResult = await this.deps.chatLlm.complete({
              messages: synthMessages,
              temperature: 0,
              maxOutputTokens,
              abortSignal: synthAbort.signal,
            });
            const parsedSynth = parseLlmOutput(synthResult.text);
            return parsedSynth.answer && parsedSynth.answer.trim().length > 0
              ? parsedSynth.answer
              : undefined;
          } finally {
            clearTimeout(synthTimer);
          }
        };
        // Attempt 1: full 512-token synthesis
        let synthAnswer: string | undefined;
        try {
          synthAnswer = await attemptSynthesis(512);
        } catch (synthErr1) {
          log.error({ err: synthErr1, requestId }, 'synthesis attempt 1 threw (timeout/error) — retrying with maxOutputTokens=256');
        }
        // Attempt 2: retry with shorter output if attempt 1 failed (empty or threw)
        if (synthAnswer === undefined) {
          try {
            log.info({ requestId, obsSteps: obsSteps.length }, 'synthesis attempt 1 returned empty — retrying with maxOutputTokens=256');
            synthAnswer = await attemptSynthesis(256);
          } catch (synthErr2) {
            log.error({ err: synthErr2, requestId }, 'synthesis attempt 2 threw — proceeding to fallback search');
          }
        }
        if (synthAnswer !== undefined) {
          answer = synthAnswer;
          terminationReason = 'answer';
          log.info({ requestId, obsSteps: obsSteps.length }, 'synthesized answer from observations');
        }
      }
    }

    if (!policyBlocked && answer === '' && terminationReason !== 'answer') {
      // Cap the fallback search at FALLBACK_SEARCH_TIMEOUT_MS (module-scope const).
      // This is independent of perStepTimeoutMs to avoid the inversion bug where
      // low perStep settings gave the fallback the same exhausted budget.
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
        } else {
          // Fallback search returned no results — construct a graceful template answer
          answer = `"${query}"에 대한 검색 결과를 찾지 못했습니다. 검색어를 더 간단하게 바꾸거나 다른 와인명이나 품종으로 다시 시도해보세요.`;
          fallbackApplied = true;
          terminationReason = 'fallback';
        }
      } catch (err) {
        // Log so an outage of the fallback path is observable instead of silent.
        log.error({ err, requestId }, 'agent fallback search failed');
      } finally {
        clearTimeout(fallbackTimer);
      }
    }

    if (!policyBlocked && answer === '') {
      // Layer 3: synthesize from last available observation (deterministic, no LLM)
      const lastObs = steps.findLast((s) => s.observation !== undefined && s.observation.length > 0);
      if (lastObs?.observation !== undefined) {
        answer = `검색 결과 요약: ${lastObs.observation.slice(0, 300)}`;
        fallbackApplied = true;
        terminationReason = 'fallback';
        log.error({ requestId }, 'Layer 3 fallback: all LLM synthesis paths failed — using raw observation');
      }
    }

    if (answer === '') {
      // Layer 4: absolute guarantee — no tool call is ALWAYS better than empty
      answer = '요청하신 와인 정보를 현재 처리하지 못했습니다. 검색어를 바꿔서 다시 시도해주세요.';
      fallbackApplied = true;
      terminationReason = 'fallback';
      log.error({ requestId, query, steps: steps.length }, 'Layer 4 fallback: all synthesis paths exhausted — returning template answer');
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

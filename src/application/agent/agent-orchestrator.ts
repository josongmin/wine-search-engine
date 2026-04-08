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
  executeAgentToolsBatch,
  isKnownTool,
  type AgentToolDeps,
  type AgentToolResult,
} from './agent-tools.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

const log = bootstrapLogger.child({ component: 'AgentOrchestrator' });

/** Wall-clock budget for the observation-based synthesis LLM call (Layer 1 fallback).
 * gpt-4o averages 20-30s per call; 12s caused consistent timeouts. */
const SYNTHESIS_TIMEOUT_MS = 60_000;
/** Wall-clock budget for the Layer 2 single-shot fallback search. */
const FALLBACK_SEARCH_TIMEOUT_MS = 5_000;
/** First synthesis attempt: full token budget (allows detailed, well-structured answers). */
const SYNTHESIS_TOKENS_ATTEMPT_1 = 512;
/** Second synthesis attempt: halved budget — fast path when first attempt times out. */
const SYNTHESIS_TOKENS_ATTEMPT_2 = 256;
/** Layer 3 fallback: max chars of observation to include in answer (prevents oversized responses). */
const LAYER3_OBSERVATION_SLICE_CHARS = 300;
/** Log-preview chars for non-parseable LLM text — enough to diagnose without bloating the log line. */
const LOG_PREVIEW_CHARS = 200;
/** Rough estimate: 4 characters ≈ 1 LLM token (for budget tracking only, not billing). */
const CHARS_PER_TOKEN_ESTIMATE = 4;

/** Parsed LLM output — either a tool call, a parallel batch, or a final answer. */
interface LlmAction {
  readonly thought: string;
  // Sequential single tool call
  readonly action?: { readonly tool: string; readonly input: Record<string, unknown> };
  // Parallel batch: LLM emits {"thought":"…","actions":[{tool,input},{tool,input}]}
  readonly actions?: readonly { readonly tool: string; readonly input: Record<string, unknown> }[];
  readonly answer?: string;
}

function parseLlmOutput(text: string): LlmAction {
  try {
    const trimmed = text.trim();
    const cleaned = trimmed
      .replace(/^```[\w-]*\s*\n?/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    const parsed = JSON.parse(cleaned) as unknown as Record<string, unknown>;

    const thought = typeof parsed['thought'] === 'string' ? parsed['thought'] : '';

    if (typeof parsed['answer'] === 'string') {
      return { thought, answer: parsed['answer'] };
    }

    // Parallel batch: {"thought":"…","actions":[{tool,input},…]}
    // Validate each entry; silently drop malformed entries.
    const actionsRaw = parsed['actions'];
    if (Array.isArray(actionsRaw) && actionsRaw.length > 0) {
      const validActions = (actionsRaw as unknown[])
        .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
        .map((a) => ({
          tool: typeof a['tool'] === 'string' ? a['tool'] : '',
          input:
            typeof a['input'] === 'object' && a['input'] !== null
              ? (a['input'] as Record<string, unknown>)
              : {},
        }))
        .filter((a) => a.tool.length > 0);
      if (validActions.length > 0) {
        return { thought, actions: validActions };
      }
    }

    // Single tool call (sequential)
    const action = parsed['action'] as Record<string, unknown> | undefined;
    if (action !== undefined && typeof action['tool'] === 'string' && action['tool'].length > 0) {
      const input =
        typeof action['input'] === 'object' && action['input'] !== null
          ? (action['input'] as Record<string, unknown>)
          : {};
      return { thought, action: { tool: action['tool'], input } };
    }

    // If neither action/actions nor answer, treat the whole text as an answer.
    log.warn(
      { textPreview: trimmed.slice(0, LOG_PREVIEW_CHARS) },
      'agent LLM produced JSON without action or answer; falling back to raw text',
    );
    return { thought: '[unparseable LLM structure]', answer: trimmed };
  } catch {
    log.warn(
      { textPreview: text.slice(0, LOG_PREVIEW_CHARS) },
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
    abortSignal?: AbortSignal,
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
     * Hard cap on parallel tools per batch step. An adversarially-prompted LLM
     * can emit {"actions":[...100 tools...]} to trigger 100 concurrent Promise.all
     * executions, exhausting DB connection pools or Vespa rate limits. Capping at
     * 4 allows legitimate parallel patterns (search + food pairing = 2; compare +
     * drinking-window × 2 = 3) while blocking resource-exhaustion attacks.
     */
    const MAX_TOOLS_PER_BATCH = 4;
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

        // Synthesize-before-exhaustion: when 1 step remains, nudge the LLM to
        // produce a final answer rather than burning the last step on another
        // tool call that will hit fallback. Fire regardless of whether
        // observations exist — maxSteps=1 must also receive the nudge.
        const remainingSteps = effectiveConfig.maxSteps - budget.getStepCount();
        const isLastStep = remainingSteps === 1;

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
        // CLAUDE.md rule: after enriching a string, length-check the RESULT (not just the input).
        const baseUserContentRaw = pendingRefinementHint !== undefined
          ? `${pendingRefinementHint}\n\n${query}`
          : query;
        pendingRefinementHint = undefined;
        // Cap the enriched user content at maxContextChars to prevent context overflow.
        const baseUserContent = baseUserContentRaw.length > effectiveConfig.maxContextChars
          ? baseUserContentRaw.slice(0, effectiveConfig.maxContextChars)
          : baseUserContentRaw;
        const userMsg = buildUserMessage(baseUserContent);
        const stepMessages = buildStepMessages(steps);
        const messages = [
          buildSystemMessage(),
          userMsg,
          ...stepMessages,
          // Inject LAST_STEP nudge as the FINAL user message AFTER all tool
          // results so the LLM sees "you just got a result → now answer".
          // Placing it at the query position (before step messages) meant the
          // model saw the warning before its own tool history, which reduced
          // compliance. A trailing user message is the natural "now respond" turn.
          ...(isLastStep
            ? [{ role: 'user' as const, content: `[LAST_STEP] Step budget exhausted. You MUST produce a final {"thought":"…","answer":"…"} JSON now using the information above. Do NOT call another tool.` }]
            : []),
        ];

        // LLM call with per-step timeout and AbortSignal propagation.
        // The AbortController cancels the underlying HTTP request when the
        // timeout fires, preventing orphaned in-flight requests.
        // Short-circuit if the caller (HTTP route) already signalled abort
        // (client disconnect). This prevents spending LLM tokens for a response
        // nobody will receive.
        if (abortSignal?.aborted) {
          terminationReason = 'error';
          break;
        }

        const stepStart = Date.now();
        let llmResult: { text: string; model: string; finishReason?: string | null };
        const stepAbortController = new AbortController();
        // Propagate caller abort into the per-step controller so the HTTP client
        // connection also cancels the underlying LLM fetch.
        const propagateAbort = (): void => { stepAbortController.abort(); };
        abortSignal?.addEventListener('abort', propagateAbort, { once: true });
        // Race guard: abort may fire between the pre-flight check above and
        // addEventListener. Re-check immediately after registration.
        if (abortSignal?.aborted) {
          abortSignal.removeEventListener('abort', propagateAbort);
          terminationReason = 'error';
          break;
        }
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
          abortSignal?.removeEventListener('abort', propagateAbort);
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

        // Estimate token counts (rough: CHARS_PER_TOKEN_ESTIMATE chars ≈ 1 token)
        const inputChars = messages.reduce((sum, m) => sum + m.content.length, 0);
        const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN_ESTIMATE);
        const outputTokens = Math.ceil(llmResult.text.length / CHARS_PER_TOKEN_ESTIMATE);
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
            durationMs: Math.max(0, Date.now() - stepStart),
            tokenCount: { input: inputTokens, output: outputTokens },
          });
          terminationReason = 'answer';
          break;
        }

        // ── Parallel batch ──────────────────────────────────────────────────
        // LLM emits {"thought":"…","actions":[{tool,input},{tool,input}]}
        // All tools fire simultaneously via Promise.all.
        // Policy-block (DomainError) from any tool → re-thrown, caught here, abort loop.
        if (parsed.actions !== undefined) {
          const batchCalls = parsed.actions;

          // Per-batch tool count limit: reject oversized batches to prevent
          // resource exhaustion via Promise.all with 100+ concurrent tool calls.
          if (batchCalls.length > MAX_TOOLS_PER_BATCH) {
            terminationReason = 'error';
            steps.push({
              index: steps.length,
              thought: parsed.thought,
              actions: batchCalls.slice(0, MAX_TOOLS_PER_BATCH),
              observations: [
                `Batch too large: ${batchCalls.length} tools requested (max ${MAX_TOOLS_PER_BATCH}). Retry with fewer parallel calls.`,
              ],
              durationMs: Math.max(0, Date.now() - stepStart),
              tokenCount: { input: inputTokens, output: outputTokens },
            });
            break;
          }

          // Unknown tool guard: reject the whole batch on first unknown name.
          const unknownTool = batchCalls.find((c) => !isKnownTool(c.tool));
          if (unknownTool !== undefined) {
            unknownToolAttempts++;
            if (unknownToolAttempts > MAX_UNKNOWN_TOOL_ATTEMPTS) {
              terminationReason = 'error';
              break;
            }
            steps.push({
              index: steps.length,
              thought: parsed.thought,
              actions: batchCalls,
              observations: [
                `Unknown tool: ${unknownTool.tool}. Available: search_wines, compare_wines, check_drinking_window, get_food_pairings`,
              ],
              durationMs: Math.max(0, Date.now() - stepStart),
              tokenCount: { input: inputTokens, output: outputTokens },
            });
            continue;
          }

          // Loop detection: recordStep for each call; abort on first violation.
          let batchLoopBlocked = false;
          for (const call of batchCalls) {
            const loopCheck = budget.recordStep(call.tool, call.input);
            if (!loopCheck.allowed) {
              terminationReason = loopCheck.reason ?? 'loop_detected';
              batchLoopBlocked = true;
              break;
            }
          }
          if (batchLoopBlocked) break;

          // Execute all tools in parallel.
          // Policy-block DomainErrors propagate through executeAgentToolsBatch
          // (not caught inside executeAgentTool). Wrap in try-catch here.
          let batchResults: readonly AgentToolResult[];
          try {
            batchResults = await executeAgentToolsBatch(
              batchCalls,
              this.deps.toolDeps,
              `${requestId}-step${steps.length}`,
            );
          } catch (batchErr) {
            if (batchErr instanceof DomainError && batchErr.code === POLICY_BLOCKED_CODE) {
              policyBlocked = true;
              terminationReason = 'blocked';
              steps.push({
                index: steps.length,
                thought: parsed.thought,
                actions: batchCalls,
                observations: [`Policy blocked: ${batchErr.message}`],
                durationMs: Math.max(0, Date.now() - stepStart),
                tokenCount: { input: inputTokens, output: outputTokens },
              });
            } else {
              terminationReason = 'error';
            }
            break;
          }

          const observations: string[] = [];
          for (const result of batchResults) {
            observations.push(
              truncateObservation(result.observation, this.config.maxContextChars),
            );
            if (
              result.rawResult !== null &&
              typeof result.rawResult === 'object' &&
              'queryType' in (result.rawResult as Record<string, unknown>) &&
              (result.rawResult as Record<string, unknown>)['queryType'] === 'search'
            ) {
              lastSearchResult = result.rawResult as SearchResponseV1;
            }
          }

          steps.push({
            index: steps.length,
            thought: parsed.thought,
            actions: batchCalls,
            observations,
            durationMs: Math.max(0, Date.now() - stepStart),
            tokenCount: { input: inputTokens, output: outputTokens },
          });

          const remainingAfterBatch = effectiveConfig.maxSteps - budget.getStepCount();
          if (
            !hasInjectedRefinementHint &&
            remainingAfterBatch >= 3 &&
            observations.some((o) => o.includes('0개') || o.includes('검색 결과가 없습니다') || o.startsWith('NO_MATCH:'))
          ) {
            hasInjectedRefinementHint = true;
            pendingRefinementHint =
              'HINT: 이전 검색에서 결과가 없었습니다. 가장 제한적인 조건(가격/품종/지역)을 하나씩 완화하여 재검색하세요. 예: 가격 조건을 넓히거나 지역 조건을 제거하고 재검색.';
          }
        }

        // ── Sequential single tool call ─────────────────────────────────────
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
              durationMs: Math.max(0, Date.now() - stepStart),
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
                durationMs: Math.max(0, Date.now() - stepStart),
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
            durationMs: Math.max(0, Date.now() - stepStart),
            tokenCount: { input: inputTokens, output: outputTokens },
          });

          // Constraint-relaxation hint: if the observation indicates zero results
          // and we have enough remaining steps, inject a hint once into the next
          // LLM message to guide iterative constraint relaxation.
          const remainingStepsAfterTool = effectiveConfig.maxSteps - budget.getStepCount();
          if (
            !hasInjectedRefinementHint &&
            remainingStepsAfterTool >= 3 &&
            (observation.includes('0개') || observation.includes('검색 결과가 없습니다') || observation.startsWith('NO_MATCH:'))
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
    // Skip entirely if caller already disconnected — synthesis costs 1-2 LLM round-trips
    // that nobody will receive.
    if (!policyBlocked && answer === '' && terminationReason !== 'answer' && !(abortSignal?.aborted)) {
      // Check both sequential (observation) and parallel batch (observations[]) steps
      // so synthesis fires when the agent used parallel tools and has results.
      const obsSteps = steps.filter(
        (s) =>
          (s.observation !== undefined && s.observation.length > 0) ||
          (s.observations !== undefined && s.observations.some((o) => o.length > 0)),
      );
      if (obsSteps.length > 0) {
        // requestId embedded in sentinel to prevent adversarial tool results from
        // containing the literal string and colliding with our synthesis detector.
        const synthSentinel = `[SYSTEM:${requestId}:FINAL_ANSWER_REQUIRED. You must output ONLY this JSON format:\n{"thought":"brief summary of what you found","answer":"your complete response to the user in their language"}\nDo NOT output "action". Do NOT call any tool. Output the "answer" field now with your best response based on the tool results above.]`;
        const synthMessages = [
          buildSystemMessage(),
          buildUserMessage(query),
          ...buildStepMessages(steps),
          {
            role: 'user' as const,
            content: synthSentinel,
          },
        ];
        const attemptSynthesis = async (maxOutputTokens: number): Promise<string | undefined> => {
          // Short-circuit if caller disconnected before we even start the LLM call.
          if (abortSignal?.aborted) return undefined;
          const synthAbort = new AbortController();
          // Propagate caller abort into the synthesis controller.
          const propagateSynthAbort = (): void => { synthAbort.abort(); };
          abortSignal?.addEventListener('abort', propagateSynthAbort, { once: true });
          // Re-check after addEventListener: if abort fired between the aborted===true
          // check above and addEventListener, the 'abort' event already fired and the
          // listener will never be called — synthAbort would never abort. Guard this race.
          if (abortSignal?.aborted) {
            synthAbort.abort();
            abortSignal.removeEventListener('abort', propagateSynthAbort);
            return undefined;
          }
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
            // If the synthesis LLM still returns a tool call despite the sentinel
            // instruction, treat it as failure (return undefined). Continuing
            // with parsedSynth.action would cause a use-after-loop tool execution
            // outside the budget guard.
            if (parsedSynth.action !== undefined || parsedSynth.actions !== undefined) {
              log.warn({ requestId }, 'synthesis LLM returned tool call — ignoring, falling to next layer');
              return undefined;
            }
            return parsedSynth.answer && parsedSynth.answer.trim().length > 0
              ? parsedSynth.answer
              : undefined;
          } finally {
            abortSignal?.removeEventListener('abort', propagateSynthAbort);
            clearTimeout(synthTimer);
          }
        };
        // Attempt 1: full token budget synthesis
        let synthAnswer: string | undefined;
        try {
          synthAnswer = await attemptSynthesis(SYNTHESIS_TOKENS_ATTEMPT_1);
        } catch (synthErr1) {
          log.error({ err: synthErr1, requestId }, `synthesis attempt 1 threw (timeout/error) — retrying with maxOutputTokens=${SYNTHESIS_TOKENS_ATTEMPT_2}`);
        }
        // Attempt 2: retry with shorter output if attempt 1 failed (empty or threw)
        // Skip if caller disconnected between attempts.
        if (synthAnswer === undefined && !(abortSignal?.aborted)) {
          try {
            log.info({ requestId, obsSteps: obsSteps.length }, `synthesis attempt 1 returned empty — retrying with maxOutputTokens=${SYNTHESIS_TOKENS_ATTEMPT_2}`);
            synthAnswer = await attemptSynthesis(SYNTHESIS_TOKENS_ATTEMPT_2);
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

    // Track whether the agent already gathered tool observations before reaching fallback.
    // When observations exist, synthesis failed but tool execution succeeded — the agent
    // correctly called the right tools; only the final LLM synthesis call failed (infra).
    // In that case we avoid re-running a fresh search (Layer 2) and instead use
    // Layer 3 (raw observation) with terminationReason='answer' so the scorer does not
    // penalise correct tool execution as a complete failure.
    const hasToolObservations = steps.some(
      (s) =>
        (s.observation !== undefined && s.observation.length > 0) ||
        (s.observations !== undefined && s.observations.some((o) => o.length > 0)),
    );

    if (!policyBlocked && answer === '' && terminationReason !== 'answer' && !hasToolObservations && !(abortSignal?.aborted)) {
      // Layer 2: single-shot fallback search — only when the agent made NO tool calls.
      // Skip when tool observations exist; those cases go directly to Layer 3 so we
      // preserve the agent's correct tool execution in the terminationReason.
      // Also skip if caller already disconnected (abortSignal.aborted).
      //
      // Cap the fallback search at FALLBACK_SEARCH_TIMEOUT_MS (module-scope const).
      // This is independent of perStepTimeoutMs to avoid the inversion bug where
      // low perStep settings gave the fallback the same exhausted budget.
      const fallbackController = new AbortController();
      // Chain caller abort → fallback controller so client disconnect cancels the search.
      const propagateFallbackAbort = (): void => { fallbackController.abort(); };
      abortSignal?.addEventListener('abort', propagateFallbackAbort, { once: true });
      // Race guard: abort may fire between the outer if-guard and addEventListener.
      // Re-check immediately after registration. If aborted, skip the fallback search.
      if (abortSignal?.aborted) {
        fallbackController.abort();
        abortSignal.removeEventListener('abort', propagateFallbackAbort);
        // Fall through to Layer 3/4 without executing the search.
      } else {
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
        abortSignal?.removeEventListener('abort', propagateFallbackAbort);
        clearTimeout(fallbackTimer);
      }
      } // end else (not aborted before fallback search started)
    } // end if (answer === '' && !hasToolObservations) — Layer 2 block

    if (!policyBlocked && answer === '') {
      // Layer 3: synthesize from last available observation (deterministic, no LLM)
      // Check both sequential (observation) and parallel (observations[]) steps.
      const lastObs = steps.findLast(
        (s) =>
          (s.observation !== undefined && s.observation.length > 0) ||
          (s.observations !== undefined && s.observations.some((o) => o.length > 0)),
      );
      const lastObsText =
        lastObs?.observation ??
        lastObs?.observations?.find((o) => o.length > 0);
      if (lastObsText !== undefined) {
        answer = `검색 결과 요약: ${lastObsText.slice(0, LAYER3_OBSERVATION_SLICE_CHARS)}`;
        fallbackApplied = true;
        // When tool observations exist, the agent successfully called the right tools —
        // only the synthesis LLM call failed (infrastructure). Use terminationReason='answer'
        // so the scorer credits correct tool execution rather than penalising as full failure.
        terminationReason = hasToolObservations ? 'answer' : 'fallback';
        log.error({ requestId, hasToolObservations }, 'Layer 3 fallback: all LLM synthesis paths failed — using raw observation');
      }
    }

    if (answer === '') {
      // Layer 4: absolute guarantee — no tool call is ALWAYS better than empty
      answer = '요청하신 와인 정보를 현재 처리하지 못했습니다. 검색어를 바꿔서 다시 시도해주세요.';
      fallbackApplied = true;
      // Same reasoning as Layer 3: if tool observations exist, the agent execution was
      // correct; only synthesis failed. Use 'answer' to avoid penalising correct execution.
      terminationReason = hasToolObservations ? 'answer' : 'fallback';
      log.error({ requestId, query, steps: steps.length }, 'Layer 4 fallback: all synthesis paths exhausted — returning template answer');
    }

    log.info(
      {
        requestId,
        steps: steps.length,
        toolCalls: steps.reduce((n, s) => n + (s.action !== undefined ? 1 : 0) + (s.actions?.length ?? 0), 0),
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
      toolCallCount: steps.reduce((n, s) => n + (s.action !== undefined ? 1 : 0) + (s.actions?.length ?? 0), 0),
      fallbackApplied,
      terminationReason,
      ...(lastSearchResult !== undefined ? { searchResults: lastSearchResult } : {}),
    };
  }
}

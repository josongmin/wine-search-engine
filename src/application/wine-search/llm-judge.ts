/**
 * LLM-as-judge adapter for the shadow-mode bench scorer.
 *
 * Why this module exists (cutover-gate hardening):
 *   The bench scorer (`test/benchmark/agent/scorer.ts`) exposes two LLM-fed
 *   dimensions — `judge` (overall rubric quality) and `faithfulness` (RAGAS
 *   grounding of answer claims in tool observations). Both are *injected*
 *   parameters: `scoreScenario(scenario, execution, judgeScore, faithfulnessScore, …)`
 *   (scorer.ts:1106-1110). When the shadow CLI passes `undefined` for both
 *   (loadBenchScorer today), the scorer leaves the dims `null` and DROPS them
 *   from the geometric mean (scorer.ts:1182, 1215). That weakens the cutover
 *   gate: 2 of 8 core dims never participate.
 *
 *   This adapter produces those two scores from a single forced-structured
 *   LLM call over `StructuredLlmPort.synthesize`. The judge emits BOTH:
 *     - `score`        → the overall rubric quality   → scorer `judgeScore`
 *     - `faithfulness` → groundedness sub-judgment     → scorer `faithfulnessScore`
 *
 *   Faithfulness is a SECOND judge dimension (not derived from observations by
 *   the scorer — verified at scorer.ts:1215 `faithfulnessScore ?? null`). The
 *   scorer's `contextRecall` / `contextRelevance` ARE observation-driven and
 *   already populate; `faithfulness` needs an injected number, so the judge
 *   produces a focused groundedness sub-score in the same call (one round-trip,
 *   not two).
 *
 * SOTA++ invariants:
 *   - Forced structured output via a Zod schema (CLAUDE.md rule 11/12 — no
 *     `as` casts on LLM output).
 *   - Schema is NOT `.strict()` (rule 10) — LLMs routinely emit extra keys.
 *   - Numeric fields accept `number | string` and parse to finite (LLM-numeric
 *     convention).
 *   - Out-of-range scores are clamped to [0, 1] with a warn log.
 *   - On LLM failure (validation / timeout / refusal / partial / unexpected),
 *     the adapter returns an `unavailable` sentinel — it NEVER fabricates a 0.
 *     The caller leaves the dim `null` so the scorer drops it honestly.
 *   - Prompt cache enabled on the system prompt (rule: prompt-cache the rubric).
 *   - All clamp bounds / default model / token budget are named consts (rule 15).
 */

import { z } from 'zod';
import type { ChatMessage } from '@domain/ai/port/chat-llm.port.js';
import type {
  StructuredLlmPort,
  TokenUsage,
} from '@domain/ai/port/structured-llm.port.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Normalized score floor — the judge rubric is defined on [0, 1]. */
const JUDGE_SCORE_MIN = 0;
/** Normalized score ceiling. */
const JUDGE_SCORE_MAX = 1;

/**
 * Default judge model. A judge call is a short rubric evaluation, not a
 * generation task — a cheaper/faster Haiku-class model is sufficient and keeps
 * the per-scenario judge cost low (the bench runs 1 judge call per side). The
 * model id matches the `claude-(opus|sonnet|haiku)-N-M` form the Anthropic
 * Messages API accepts (a `*-latest` alias is rejected with HTTP 400 — see
 * synthesis-runner.ts DEFAULT_SYNTHESIS_MODEL note).
 */
export const DEFAULT_JUDGE_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Max output tokens for the judge. The judge emits a small JSON object
 * ({ score, faithfulness, reasoning }); 512 leaves ample room for a 2-3
 * sentence Korean/English rationale without risking a `max_tokens` truncation
 * (which would surface as a StructuredLlmPartialOutputError → unavailable).
 */
const JUDGE_MAX_OUTPUT_TOKENS = 512;

/**
 * Per-call timeout (ms). A judge call is a single short completion; 20s is
 * generous headroom over the typical Haiku latency and well under the bench's
 * per-scenario timeout (35s default) so a slow judge degrades to `unavailable`
 * rather than killing the whole scenario.
 */
const JUDGE_PER_STEP_TIMEOUT_MS = 20_000;

/**
 * Max grounding observations folded into the judge prompt. Korean wine
 * observations can be 100+ chars each and a scenario can carry hundreds; we
 * cap the prompt at the most-relevant prefix to bound token cost. Loop-based
 * slice (rule 9 — never spread large arrays).
 */
const MAX_GROUNDING_OBSERVATIONS = 24;

/**
 * Per-observation char clip. Bounds a single pathological observation from
 * dominating the prompt budget.
 */
const MAX_OBSERVATION_CHARS = 600;

/**
 * Wine-domain answer-quality rubric. Kept SHORT (~400 tokens) and prompt-cached
 * so the judge cost is dominated by the per-scenario user turn, not the system
 * prompt. The judge scores BOTH overall quality (`score`) and a focused
 * groundedness sub-score (`faithfulness`).
 */
const JUDGE_SYSTEM_PROMPT = [
  'You are a strict evaluator of a wine-recommendation assistant.',
  'You receive: the user QUERY, the assistant ANSWER, and the GROUNDING',
  'observations (tool results the assistant could cite). Score the ANSWER.',
  '',
  'Return two scores in [0,1] plus a short reasoning:',
  '',
  '1. "score" — OVERALL answer quality. Weigh:',
  '   - relevance: does the answer address the query intent?',
  '   - language match: answer language matches the query language',
  '     (Korean query → Korean answer; English → English). A mismatch is a',
  '     serious defect.',
  '   - usefulness: concrete, actionable wine guidance vs vague filler.',
  '   - no hallucination: no invented wines, prices, vintages, or facts that',
  '     contradict or are absent from GROUNDING.',
  '',
  '2. "faithfulness" — GROUNDEDNESS ONLY. The fraction of the answer\'s',
  '   factual claims (wine names, prices, regions, vintages, scores) that are',
  '   supported by GROUNDING. Unsupported or contradicted claims lower it.',
  '   If GROUNDING is empty and the answer makes no specific factual claims',
  '   (e.g. an honest "no results" reply), faithfulness is high (~1).',
  '   If the answer asserts specific facts with no supporting GROUNDING,',
  '   faithfulness is low (~0).',
  '',
  'Be calibrated, not generous. 1.0 is reserved for excellent answers.',
  'Reasoning must be one or two sentences.',
].join('\n');

// ---------------------------------------------------------------------------
// Judge output schema (rule 10 — NOT .strict(); rule 11/12 — parsed, no cast)
// ---------------------------------------------------------------------------

/**
 * Coerce an LLM-emitted numeric field. LLMs routinely return `"0.8"` instead
 * of `0.8` (CLAUDE.md LLM-numeric convention). Accept both, parse to a finite
 * number, and reject non-finite (NaN/Infinity) so the schema fails closed
 * rather than poisoning the score with NaN.
 */
const LlmNumber = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'string' ? Number.parseFloat(v) : v))
  .refine((v) => Number.isFinite(v), { message: 'must be a finite number' });

/**
 * Judge tool-call output. Intentionally NOT `.strict()` — the judge LLM may
 * emit extra keys (confidence, sub-criteria) and strict mode would fail the
 * whole validation (rule 10). We read only the three fields we need.
 */
export const JudgeOutputSchema = z.object({
  score: LlmNumber,
  faithfulness: LlmNumber,
  reasoning: z.string(),
});


// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface JudgeInput {
  readonly query: string;
  readonly answer: string;
  readonly groundingObservations: readonly string[];
  /** scenario.expectation.rubric, when present — appended to the system rubric. */
  readonly rubric?: string;
  readonly requestId: string;
  readonly abortSignal?: AbortSignal;
}

/**
 * A successful judge evaluation. `score` and `faithfulness` are clamped to
 * [0, 1]. `available: true` distinguishes a real judgment from the sentinel.
 */
export interface JudgeResultAvailable {
  readonly available: true;
  readonly score: number;
  readonly faithfulness: number;
  readonly reasoning: string;
  readonly tokenUsage: TokenUsage;
}

/**
 * Sentinel returned when the judge could not produce a usable judgment
 * (validation / timeout / refusal / partial / unexpected). The caller MUST
 * treat this as "judge unavailable" and leave the scorer dims null — never
 * fabricate a 0. `tokenUsage` is still surfaced (a failed call may have burned
 * tokens) so the bench can account for cost honestly.
 */
export interface JudgeResultUnavailable {
  readonly available: false;
  readonly reason: JudgeUnavailableReason;
  readonly tokenUsage: TokenUsage;
}

export type JudgeUnavailableReason =
  | 'validation'
  | 'timeout'
  | 'refusal'
  | 'partial'
  | 'circuit_open'
  | 'unexpected';

export type JudgeResult = JudgeResultAvailable | JudgeResultUnavailable;

export interface LlmJudge {
  evaluate(input: JudgeInput): Promise<JudgeResult>;
}

interface JudgeLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

interface StructuredLlmJudgeDeps {
  readonly structuredLlm: StructuredLlmPort;
  /** Defaults to {@link DEFAULT_JUDGE_MODEL}. */
  readonly model?: string;
  readonly logger?: JudgeLogger;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** Clamp a score into [JUDGE_SCORE_MIN, JUDGE_SCORE_MAX]. */
function clampJudgeScore(value: number): number {
  if (value < JUDGE_SCORE_MIN) return JUDGE_SCORE_MIN;
  if (value > JUDGE_SCORE_MAX) return JUDGE_SCORE_MAX;
  return value;
}

/** Bound the grounding block: clip per-observation length and total count. */
function formatGrounding(observations: readonly string[]): string {
  if (observations.length === 0) return '(no tool observations — answer must not assert specific facts)';
  const lines: string[] = [];
  for (let i = 0; i < observations.length && lines.length < MAX_GROUNDING_OBSERVATIONS; i += 1) {
    const obs = observations[i];
    if (obs === undefined || obs.length === 0) continue;
    const clipped = obs.length > MAX_OBSERVATION_CHARS
      ? `${obs.slice(0, MAX_OBSERVATION_CHARS)}…`
      : obs;
    lines.push(`- ${clipped}`);
  }
  return lines.length > 0 ? lines.join('\n') : '(no non-empty tool observations)';
}

/**
 * Classify a thrown error from the structured-LLM port into an unavailable
 * reason. We match on the error `name` (set by each error class constructor in
 * structured-llm.port.ts) rather than `instanceof` so this module does not
 * couple to the concrete error classes (and survives bundler de-duplication
 * where two copies of the class would fail `instanceof`).
 */
function classifyJudgeError(err: unknown): JudgeUnavailableReason {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'StructuredLlmTimeoutError':
      return 'timeout';
    case 'StructuredLlmRefusalError':
      return 'refusal';
    case 'StructuredLlmPartialOutputError':
      return 'partial';
    case 'StructuredLlmValidationError':
      return 'validation';
    case 'StructuredLlmCircuitOpenError':
      return 'circuit_open';
    default:
      return 'unexpected';
  }
}

/** Abort errors must propagate so the bench can cancel the whole run. */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  // Some runtimes throw a DOMException with name 'AbortError'.
  return typeof err === 'object'
    && err !== null
    && 'name' in err
    && (err as { name?: unknown }).name === 'AbortError';
}

// ---------------------------------------------------------------------------
// StructuredLlmJudge
// ---------------------------------------------------------------------------

export class StructuredLlmJudge implements LlmJudge {
  private readonly structuredLlm: StructuredLlmPort;
  private readonly model: string;
  private readonly logger?: JudgeLogger;

  constructor(deps: StructuredLlmJudgeDeps) {
    this.structuredLlm = deps.structuredLlm;
    this.model = deps.model ?? DEFAULT_JUDGE_MODEL;
    if (deps.logger !== undefined) this.logger = deps.logger;
  }

  async evaluate(input: JudgeInput): Promise<JudgeResult> {
    const grounding = formatGrounding(input.groundingObservations);
    const rubricBlock = input.rubric !== undefined && input.rubric.trim().length > 0
      ? `\n\nScenario-specific rubric (apply on top of the general criteria):\n${input.rubric.trim()}`
      : '';

    const messages: readonly ChatMessage[] = [
      { role: 'user', content: `QUERY:\n${input.query}` },
      { role: 'user', content: `ANSWER:\n${input.answer}` },
      { role: 'user', content: `GROUNDING:\n${grounding}` },
    ];

    try {
      const result = await this.structuredLlm.synthesize({
        messages,
        schema: JudgeOutputSchema,
        systemPrompt: `${JUDGE_SYSTEM_PROMPT}${rubricBlock}`,
        enablePromptCache: true,
        maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: JUDGE_PER_STEP_TIMEOUT_MS,
        model: this.model,
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      });

      // The port already `.safeParse`d against JudgeOutputSchema and threw
      // StructuredLlmValidationError on failure, so `result.data` is typed.
      // We re-validate defensively (cheap insurance, no `as` cast).
      const parsed = JudgeOutputSchema.safeParse(result.data);
      if (!parsed.success) {
        this.logger?.warn(
          { requestId: input.requestId, issues: parsed.error.issues.slice(0, 3) },
          '[llm-judge] post-port validation failed — judge unavailable',
        );
        return { available: false, reason: 'validation', tokenUsage: result.usage };
      }

      const rawScore = parsed.data.score;
      const rawFaithfulness = parsed.data.faithfulness;
      const score = clampJudgeScore(rawScore);
      const faithfulness = clampJudgeScore(rawFaithfulness);
      if (rawScore !== score || rawFaithfulness !== faithfulness) {
        this.logger?.warn(
          {
            requestId: input.requestId,
            rawScore,
            rawFaithfulness,
            clampedScore: score,
            clampedFaithfulness: faithfulness,
          },
          '[llm-judge] judge emitted out-of-range score(s) — clamped to [0,1]',
        );
      }

      return {
        available: true,
        score,
        faithfulness,
        reasoning: parsed.data.reasoning,
        tokenUsage: result.usage,
      };
    } catch (err) {
      // Abort propagates — the caller wants to cancel the whole bench run.
      if (isAbortError(err)) throw err;
      const reason = classifyJudgeError(err);
      this.logger?.warn(
        { requestId: input.requestId, reason, errName: err instanceof Error ? err.name : 'unknown' },
        '[llm-judge] judge call failed — judge unavailable (dim stays null)',
      );
      return { available: false, reason, tokenUsage: ZERO_USAGE };
    }
  }
}

/**
 * SynthesisRunner — typed contract shapes.
 *
 * `AnswerResult` is the public typed output of the Plan-then-Execute
 * synthesis stage. The runner guarantees `answer.length > 0` for any
 * non-aborted call: on every failure path we fall through to the deterministic
 * Korean/English templates in `synthesis-fallback-templates.ts`.
 *
 * `SynthesisAnswerSchema` is the Zod schema applied to the LLM's tool_use
 * input. It deliberately does NOT chain `.strict()` — CLAUDE.md rule 10
 * exception for LLM-emitted shapes (the model routinely sprinkles extra
 * `reasoning` / `confidence` keys and strict mode would fail the entire
 * parse).
 */

import { z } from 'zod';
import type { TokenUsage } from '@domain/ai/port/structured-llm.port.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Minimum length of the LLM-emitted `answer` field — empty answers are
 *  rejected and trigger the fallback ladder. */
export const SYNTHESIS_MIN_ANSWER_CHARS = 1;

/** Maximum length of the LLM-emitted `answer` field. Sized to fit a
 *  multi-paragraph wine recommendation comfortably (≈3 paragraphs in Korean
 *  with citations). Going higher inflates output tokens without measurable
 *  user-perceived gain. */
export const SYNTHESIS_MAX_ANSWER_CHARS = 3000;

/** Per-citation length cap. Citations are entity ids or short URLs. */
const SYNTHESIS_CITATION_MAX_CHARS = 256;

/** Maximum number of citations the LLM may emit. Mirrors the worst observed
 *  multi-result synthesis (compare across 4 legs * 2 citations each). */
const SYNTHESIS_MAX_CITATIONS = 12;

// ---------------------------------------------------------------------------
// LLM output schema
// ---------------------------------------------------------------------------

/**
 * The shape the synthesis LLM must emit. INTENTIONALLY NOT `.strict()` —
 * see module docstring (CLAUDE.md rule 10 exception for LLM tool_use input).
 */
export const SynthesisAnswerSchema = z.object({
  answer: z
    .string()
    .min(SYNTHESIS_MIN_ANSWER_CHARS)
    .max(SYNTHESIS_MAX_ANSWER_CHARS),
  citations: z
    .array(z.string().min(1).max(SYNTHESIS_CITATION_MAX_CHARS))
    .max(SYNTHESIS_MAX_CITATIONS)
    .optional(),
});
export type SynthesisAnswer = z.infer<typeof SynthesisAnswerSchema>;

// ---------------------------------------------------------------------------
// Public AnswerResult contract
// ---------------------------------------------------------------------------

export type AnswerLayer = 'primary' | 'layer2' | 'layer3' | 'layer4';

export type DegradedReason =
  | 'malformed_llm_output'
  | 'timeout'
  | 'circuit_open'
  | 'no_results'
  | 'policy_blocked'
  /**
   * The primary structured-LLM call threw an exception that is NOT one of
   * the typed {@link StructuredLlm*Error} classes — i.e. an unmodeled
   * runtime failure (network hiccup, downstream adapter bug, generic
   * `Error`). Distinguished from `malformed_llm_output` so operations can
   * tell schema-validation noise apart from genuine surprises.
   */
  | 'unexpected_error'
  /**
   * S3 grounding-verify: the primary synthesis answer asserted a factual
   * wine claim (canonical label / region / grape / vintage / price) that
   * could not be matched against the UNION of GROUNDING_JSON blocks across
   * all tool outcomes. One re-synth attempt is made; if the re-synth answer
   * is still ungrounded, the runner degrades to the deterministic Layer 2
   * template and tags the result with this reason.
   */
  | 'ungrounded_claim'
  /**
   * Wave 1 (Cluster F): the DecisionEngine emitted
   * `failureReason: 'NO_CORPUS_MATCH'` — the planner extracted a
   * high-confidence anchor but the resolver returned 0 candidates. The
   * synthesizer emitted the deterministic `corpusGapAdmission` template
   * (not in our catalogue / 카탈로그에서 찾지 못했어요). Distinct from
   * `no_results` (which is the no-grounding path) and from
   * `policy_blocked` (which is security / unsupported intent) so
   * operators can monitor catalogue-coverage gaps as a separate signal.
   */
  | 'no_corpus_match';

export interface AnswerResult {
  /** Non-empty answer string — invariant guaranteed by the runner's
   *  fallback ladder. */
  readonly answer: string;
  readonly layer: AnswerLayer;
  /** True iff the answer was synthesized from at least one grounding tool
   *  outcome (success or partial_result). Layer 2 sets this to true (uses
   *  the top grounded result); Layer 3 sets true when the last observation
   *  carried structured grounding; Layer 4 is always false. */
  readonly groundedOnToolResults: boolean;
  /** Number of LLM synthesis calls made (primary attempt + retry, if any).
   *  0 when the runner short-circuits without calling the LLM
   *  (policy-blocked, no tool outcomes). */
  readonly synthesisAttempts: number;
  /**
   * S3 grounding-verify: number of full synthesis passes that produced a
   * candidate answer which was then checked against the grounding union.
   * `1` when the primary answer passed grounding-verify on the first pass;
   * `2` when an ungrounded claim forced exactly one deterministic re-synth.
   * `0` on paths that never produce an LLM-synthesized candidate
   * (policy-blocked, no-results, or a deterministic fallback layer that was
   * never gated by grounding-verify). Distinct from `synthesisAttempts`,
   * which counts every LLM round-trip including schema-validation retries. */
  readonly verificationAttempts: number;
  /** Accumulated token usage across all synthesis attempts. */
  readonly tokenUsage: TokenUsage;
  /** Optional degradation tag for observability — undefined when layer is
   *  'primary' and no degradation occurred. */
  readonly degradedReason?: DegradedReason | undefined;
}

// ---------------------------------------------------------------------------
// Error class — surfaced when the caller's AbortSignal fires
// ---------------------------------------------------------------------------

/**
 * Raised when the synthesis runner observes its abortSignal in an aborted
 * state. The runner deliberately does NOT swallow this into a fallback
 * answer — the orchestrator decides whether to return a 4xx, retry, or
 * propagate to the client.
 */
export class SynthesisAbortedError extends Error {
  constructor(message?: string) {
    super(message ?? 'synthesis-runner: aborted before answer could be produced');
    this.name = 'SynthesisAbortedError';
  }
}

// ---------------------------------------------------------------------------
// Zero-token-usage helper — re-used by short-circuit paths
// ---------------------------------------------------------------------------

export function makeZeroTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

/** Pure accumulator — pre-validates that all inputs are finite non-negative
 *  integers, falling back to 0 on malformed adapter output. */
export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: safeAdd(a.inputTokens, b.inputTokens),
    outputTokens: safeAdd(a.outputTokens, b.outputTokens),
    cacheReadTokens: safeAdd(a.cacheReadTokens, b.cacheReadTokens),
    cacheCreationTokens: safeAdd(a.cacheCreationTokens, b.cacheCreationTokens),
  };
}

function safeAdd(a: number, b: number): number {
  const left = Number.isFinite(a) && a >= 0 ? a : 0;
  const right = Number.isFinite(b) && b >= 0 ? b : 0;
  return left + right;
}

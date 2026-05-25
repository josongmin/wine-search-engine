/**
 * ComparisonLlmFallback — one-shot grounded LLM synthesis for
 * comparison-flavored queries that exhaust the mini-loop's step budget.
 *
 * Motivation (bench v9, scenarios #30/#31/#32/#117):
 *   `comparison_nested` queries that need to (1) retrieve leg A, (2) retrieve
 *   leg B, (3) reason about drinkability / pairing / price, and (4) emit a
 *   final verdict all in ≤3 mini-loop turns reliably exhaust `max_steps`
 *   before the verdict turn. The mini-loop terminates with
 *   `terminationReason: 'max_steps'` and the downstream `SynthesisRunner`
 *   has to choose between (a) the deterministic Layer-2 template anchored on
 *   ONE wine (the comparison verdict is lost), or (b) the Layer-4 hard-coded
 *   fallback ("we couldn't process your wine query").
 *
 * Strategy:
 *   The mini-loop DID retrieve both legs' candidates before running out of
 *   steps. Pull those candidates from the tool outcomes, dump them as a
 *   structured prompt to the synthesis LLM, and ask for ONE grounded verdict
 *   in a single round-trip. This trades exploratory drilling (multi-step
 *   reasoning) for full-context one-shot synthesis — the LLM sees both legs
 *   side-by-side and picks A/B/tie with reasoning grounded in the candidate
 *   fields.
 *
 * Boundaries:
 *   - This is NOT a generic synthesizer — it ONLY fires when the orchestrator
 *     detects a stalled comparison plan (`max_steps` + comparison signal).
 *   - It does NOT call any tools. The candidate set is whatever the mini-loop
 *     already pulled before stalling.
 *   - It returns `null` when fewer than {@link MIN_CANDIDATES_PER_LEG_FOR_VERDICT}
 *     candidates exist across both legs — the underlying retrieval was broken
 *     and pretending the LLM can synthesize a verdict from nothing would
 *     fabricate facts (CLAUDE.md schema-quality bar).
 *
 * SSoT discipline:
 *   - Reuses `StructuredLlmPort.synthesize` (same surface SynthesisRunner uses).
 *   - Reuses `TokenUsage` and `addTokenUsage` so the orchestrator can fold
 *     the fallback's tokens into the cumulative result.
 *   - Zod schema for the LLM output does NOT chain `.strict()` (CLAUDE.md
 *     rule 10 exception — LLM tool_use inputs routinely carry extra keys).
 */

import { z } from 'zod';
import {
  StructuredLlmCircuitOpenError,
  StructuredLlmPartialOutputError,
  StructuredLlmRefusalError,
  StructuredLlmTimeoutError,
  StructuredLlmValidationError,
  type StructuredLlmPort,
  type SynthesizeResult,
  type TokenUsage,
} from '@domain/ai/port/structured-llm.port.js';
import type { ChatMessage } from '@domain/ai/port/chat-llm.port.js';
import { CLAUDE_SONNET_MODEL_ID } from '@domain/shared/constants/claude-models.js';
import { bootstrapLogger } from '@domain/shared/bootstrap-logger.js';
import { isAbortError } from '@domain/shared/cooperative-abort.js';
import { addTokenUsage, makeZeroTokenUsage } from './synthesis-schemas.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15) — every magic number lives here with a
// rationale comment so a future reader can audit the trade-off.
// ---------------------------------------------------------------------------

/** Default model for the comparison fallback. Same Sonnet-class model the
 *  primary synthesizer uses — comparison verdict quality is bounded by
 *  reasoning ability over the candidate set, not throughput. */
const COMPARISON_FALLBACK_DEFAULT_MODEL = CLAUDE_SONNET_MODEL_ID;

/** Maximum number of candidates serialized PER LEG into the prompt. Sized so
 *  two legs × 5 candidates × ~12 fields ≈ 120 lines of JSON-ish payload —
 *  well within the synthesis prompt budget and large enough to surface the
 *  top representative wines without burying the LLM in tail noise. */
const MAX_CANDIDATES_PER_LEG = 5;

/** A comparison verdict requires two sides, by definition. */
const MIN_LEGS_FOR_COMPARISON = 2;

/** Per-leg minimum so we always have something on BOTH sides when we proceed.
 *  When only one leg has candidates, a "comparison verdict" is meaningless —
 *  the LLM would either invent the other side or unilaterally pick the side
 *  it has data for. This is the single source of truth for "do we have
 *  enough to compare"; together with {@link MIN_LEGS_FOR_COMPARISON} it
 *  implies a minimum total of 2 candidates. */
const MIN_CANDIDATES_PER_LEG_FOR_VERDICT = 1;

/** Maximum length of the LLM-emitted Korean / English answer. Mirrors
 *  `SYNTHESIS_MAX_ANSWER_CHARS` — comparison verdicts shouldn't be longer
 *  than a typical recommendation; if they are, the model is rambling. */
const COMPARISON_FALLBACK_MAX_ANSWER_CHARS = 3000;

/** Minimum answer length — empty strings are not a valid verdict. */
const COMPARISON_FALLBACK_MIN_ANSWER_CHARS = 1;

/** Maximum length of the LLM-emitted reasoning field. Shorter than the
 *  answer because the reasoning is a structured justification of the
 *  chosenSide, not the user-facing narrative. */
const COMPARISON_FALLBACK_MAX_REASONING_CHARS = 1000;

/** Per-field character cap for any structured value we serialize into the
 *  prompt. Defense against pathologically long canonical labels / regions
 *  blowing up the prompt size in case of upstream data corruption. */
const PROMPT_FIELD_MAX_CHARS = 256;

/** Per-leg query character cap — the leg query is part of the prompt so the
 *  LLM knows what the user was asking each side to match. Matches typical
 *  short sub-queries; longer surfaces are clipped. */
const PROMPT_LEG_QUERY_MAX_CHARS = 200;

/** Soft cap on the FULL prompt body's character length (sum of all legs and
 *  their candidates). When exceeded the per-leg serializer truncates the
 *  tail with an explicit marker so the model SEES that context was clipped. */
const PROMPT_BODY_SOFT_MAX_CHARS = 12_000;

/** Marker the prompt-tail truncation appends. The LLM treats it as a hint
 *  that the context window was clipped (so it should not over-confidently
 *  claim "I considered every candidate"). */
const PROMPT_TRUNCATION_MARKER = '\n…[candidates truncated to fit prompt budget]';

/** Bounded preview length surfaced into logs. Defense against accidentally
 *  echoing arbitrary downstream payloads into log aggregation
 *  (CLAUDE.md schema-quality bar — never log raw query content above
 *  200 chars). */
const LOG_PREVIEW_MAX_CHARS = 200;

// ---------------------------------------------------------------------------
// LLM output schema — NOT `.strict()` (CLAUDE.md rule 10 exception for LLM
// tool_use inputs). The LLM routinely sprinkles extra `reasoning_trace` /
// `confidence` keys; `.strict()` would fail the entire parse on a single
// extra key.
// ---------------------------------------------------------------------------

const ChosenSideSchema = z.enum(['A', 'B', 'tie']);

export const ComparisonFallbackAnswerSchema = z.object({
  /** Discriminator: which side won, or `'tie'` when the LLM judges neither
   *  side dominates for the user's intent. */
  chosenSide: ChosenSideSchema,
  /** Short structured justification of `chosenSide`. Used for traceability
   *  and offline eval; NOT user-facing prose (that lives in `answer`). */
  reasoning: z
    .string()
    .min(COMPARISON_FALLBACK_MIN_ANSWER_CHARS)
    .max(COMPARISON_FALLBACK_MAX_REASONING_CHARS),
  /** The user-facing answer. Korean when the user query is Korean (the
   *  prompt instructs the LLM); English otherwise. */
  answer: z
    .string()
    .min(COMPARISON_FALLBACK_MIN_ANSWER_CHARS)
    .max(COMPARISON_FALLBACK_MAX_ANSWER_CHARS),
});
export type ComparisonFallbackAnswer = z.infer<typeof ComparisonFallbackAnswerSchema>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal structural shape of a candidate retrieved from `search_wines` /
 * `compare_wines`. We deliberately accept a wide, optional-field shape
 * rather than coupling to `ResultItem` directly: the candidate set may
 * arrive from a `SearchResponseV1.results` array (`{ entity: EntitySummary,
 * ... }`) OR directly as an entity-shaped object (`compare_wines` legs).
 * The structural check at runtime (see {@link extractCandidateFields})
 * tolerates both.
 */
export interface ComparisonFallbackCandidate {
  readonly canonicalLabel?: string | undefined;
  readonly producer?: string | undefined;
  readonly region?: string | undefined;
  readonly country?: string | undefined;
  readonly vintage?: number | undefined;
  readonly grapes?: readonly string[] | undefined;
  readonly alcoholPct?: number | undefined;
  readonly criticScore?: number | undefined;
  readonly priceRange?: string | undefined;
  readonly body?: number | undefined;
  readonly tannin?: number | undefined;
  readonly acidity?: number | undefined;
  readonly sweetness?: number | undefined;
  readonly drinkingWindowStart?: number | undefined;
  readonly drinkingWindowEnd?: number | undefined;
}

export interface ComparisonLlmFallbackLeg {
  readonly leg: 'A' | 'B';
  readonly legQuery: string;
  readonly candidates: ReadonlyArray<ComparisonFallbackCandidate>;
}

export interface ComparisonLlmFallbackInput {
  readonly query: string;
  readonly requestId: string;
  readonly originalRetrievalDocs: ReadonlyArray<ComparisonLlmFallbackLeg>;
  readonly perStepTimeoutMs: number;
  readonly maxOutputTokens: number;
  readonly hangulDominant: boolean;
  readonly abortSignal?: AbortSignal | undefined;
}

export interface ComparisonLlmFallbackOutput {
  readonly answer: string;
  readonly tokenUsage: TokenUsage;
  readonly chosenSide: 'A' | 'B' | 'tie';
  readonly reasoning: string;
}

/**
 * Outcome of the fallback runner — a discriminated result so the orchestrator
 * can distinguish "we DID produce a verdict" from "candidates were too sparse
 * to attempt" from "LLM failed (timeout, refusal, schema mismatch, …)".
 *
 * The orchestrator's reaction:
 *  - `produced`         → use this as the final answer (override Layer-2/4).
 *  - `declined_no_candidates` → let the synthesizer's standard ladder play out.
 *  - `failed`           → log + let the synthesizer's standard ladder play out.
 */
export type ComparisonLlmFallbackResult =
  | { readonly kind: 'produced'; readonly output: ComparisonLlmFallbackOutput }
  | { readonly kind: 'declined_no_candidates'; readonly totalCandidates: number }
  | { readonly kind: 'failed'; readonly reason: ComparisonLlmFallbackFailureReason; readonly tokenUsage: TokenUsage };

export type ComparisonLlmFallbackFailureReason =
  | 'timeout'
  | 'circuit_open'
  | 'refusal'
  | 'malformed_llm_output'
  | 'partial_output'
  | 'unexpected_error';

// ---------------------------------------------------------------------------
// Logger seam
// ---------------------------------------------------------------------------

interface ComparisonLlmFallbackLogger {
  warn(payload: Record<string, unknown>, msg: string): void;
  info(payload: Record<string, unknown>, msg: string): void;
}

const defaultLog = bootstrapLogger.child({ component: 'ComparisonLlmFallback' });

// ---------------------------------------------------------------------------
// Public runner
// ---------------------------------------------------------------------------

/**
 * Run the one-shot grounded comparison synthesis.
 *
 * Contract:
 *  - Never throws on modeled LLM errors — surfaces them through the
 *    `'failed'` result kind so the caller can fall through cleanly.
 *  - Re-throws `AbortError` (the orchestrator owns abort propagation).
 *  - Returns `'declined_no_candidates'` when the candidate budget is too
 *    thin for a meaningful verdict (see {@link MIN_CANDIDATES_PER_LEG_FOR_VERDICT}).
 */
export async function runComparisonLlmFallback(
  input: ComparisonLlmFallbackInput,
  llm: StructuredLlmPort,
  options: { readonly model?: string; readonly logger?: ComparisonLlmFallbackLogger } = {},
): Promise<ComparisonLlmFallbackResult> {
  const logger = options.logger ?? defaultLog;
  const model = options.model ?? COMPARISON_FALLBACK_DEFAULT_MODEL;

  // Pre-flight: candidate budget. The orchestrator MUST be able to fall
  // through cleanly when retrieval was broken — fabricating a verdict from
  // nothing is a violation of the schema-quality bar.
  const totalCandidates = input.originalRetrievalDocs.reduce(
    (acc, leg) => acc + leg.candidates.length,
    0,
  );
  const everyLegHasMinimum = input.originalRetrievalDocs.every(
    (leg) => leg.candidates.length >= MIN_CANDIDATES_PER_LEG_FOR_VERDICT,
  );
  if (
    input.originalRetrievalDocs.length < MIN_LEGS_FOR_COMPARISON
    || !everyLegHasMinimum
  ) {
    logger.info(
      {
        requestId: input.requestId,
        totalCandidates,
        legCount: input.originalRetrievalDocs.length,
        perLegCounts: input.originalRetrievalDocs.map((l) => l.candidates.length),
      },
      '[comparison-llm-fallback] declining: insufficient candidates',
    );
    return { kind: 'declined_no_candidates', totalCandidates };
  }

  const prompt = buildComparisonPrompt(input);
  const baseRequest = {
    schema: ComparisonFallbackAnswerSchema,
    systemPrompt: COMPARISON_FALLBACK_SYSTEM_PROMPT,
    enablePromptCache: true,
    maxOutputTokens: input.maxOutputTokens,
    perStepTimeoutMs: input.perStepTimeoutMs,
    model,
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
  } as const;

  let usage = makeZeroTokenUsage();
  try {
    const result: SynthesizeResult<ComparisonFallbackAnswer> = await llm.synthesize({
      ...baseRequest,
      messages: prompt,
    });
    usage = addTokenUsage(usage, result.usage);
    const parsed = ComparisonFallbackAnswerSchema.safeParse(result.data);
    if (!parsed.success) {
      logger.warn(
        {
          requestId: input.requestId,
          issues: parsed.error.issues.slice(0, 3),
        },
        '[comparison-llm-fallback] schema validation failed on LLM output',
      );
      return { kind: 'failed', reason: 'malformed_llm_output', tokenUsage: usage };
    }
    logger.info(
      {
        requestId: input.requestId,
        chosenSide: parsed.data.chosenSide,
        answerPreview: parsed.data.answer.slice(0, LOG_PREVIEW_MAX_CHARS),
      },
      '[comparison-llm-fallback] produced verdict',
    );
    return {
      kind: 'produced',
      output: {
        answer: parsed.data.answer,
        chosenSide: parsed.data.chosenSide,
        reasoning: parsed.data.reasoning,
        tokenUsage: usage,
      },
    };
  } catch (err) {
    if (isAbortError(err)) {
      // Abort is owned by the orchestrator — re-throw so cooperative abort
      // semantics are preserved.
      throw err;
    }
    const reason = classifyFailure(err);
    logger.warn(
      {
        requestId: input.requestId,
        reason,
        err: err instanceof Error ? err.message.slice(0, LOG_PREVIEW_MAX_CHARS) : String(err).slice(0, LOG_PREVIEW_MAX_CHARS),
      },
      '[comparison-llm-fallback] LLM call failed',
    );
    return { kind: 'failed', reason, tokenUsage: usage };
  }
}

// ---------------------------------------------------------------------------
// System prompt — Korean / English bilingual instructions. Static so it
// benefits from prompt caching across requests.
//
// Design notes:
//  - The model MUST emit JSON matching `ComparisonFallbackAnswerSchema`.
//  - The model MUST pick A / B / tie and justify in `reasoning`.
//  - The user-facing `answer` MUST respect the query language (Korean ↔ English).
//  - The model MUST ground every factual claim in the supplied candidate
//    fields — explicit "no fabrication" instruction mirrors the synthesizer's
//    hard rule.
// ---------------------------------------------------------------------------

const COMPARISON_FALLBACK_SYSTEM_PROMPT = [
  'You are a wine comparison synthesizer for a Korean-friendly wine search backend.',
  '',
  'Context: a deterministic comparison pipeline retrieved candidates for two sides (A and B) of the user\'s "X vs Y" question, but ran out of step budget before producing a final verdict. You receive the COMPLETE candidate dump for both legs and must emit a single grounded verdict in ONE round-trip.',
  '',
  'Your job, in order:',
  '  1. Read the original user query — note any qualifying constraints (drinkability, price, food pairing, vintage).',
  '  2. Read the candidates for leg A and leg B. Each candidate carries structured fields (canonical_label, producer, region, vintage, grapes, alcohol_pct, critic_score, price_range, body, tannin, acidity, sweetness, drinking_window_start, drinking_window_end). Missing fields are OMITTED — never invent a value for a missing field.',
  '  3. Compare the two sides AGAINST THE USER\'S INTENT. If the user asked "which is better for drinking NOW", weigh `drinking_window_start` / `drinking_window_end`. If the user asked about pairing with a specific food, weigh `grapes` / `body` / `tannin` / `acidity`. If the user asked about price, weigh `price_range`. Default to overall quality (critic_score) when the user query is neutral.',
  '  4. Choose ONE winner: A, B, or tie. A tie is acceptable ONLY when both sides are genuinely indistinguishable for the user\'s intent — do not abuse it as a hedge.',
  '  5. Emit the structured response. The `answer` field is user-facing prose — Korean if the original query contains 한글, English otherwise.',
  '',
  'Hard rules:',
  '  - Ground EVERY factual claim (wine name, region, vintage, score, price) in the supplied candidate fields. Never fabricate.',
  '  - The candidate fields are AUTHORITATIVE — if a candidate has no `drinking_window_start`, do not assert "ready to drink now" for it.',
  '  - Keep the user-facing `answer` focused (2-4 short paragraphs maximum). Lead with the verdict, then the 1-2 strongest grounding facts.',
  '  - Do NOT promise availability or stock status ("currently sold", "in stock") — the candidate fields do not carry that signal.',
  '  - The `reasoning` field is for offline eval traceability — keep it tight (≤3 sentences) and reference candidate fields by name.',
  '',
  'Output: emit a single tool call with input matching this shape:',
  '  {',
  '    "chosenSide": "A" | "B" | "tie",',
  '    "reasoning": string  // short structured justification, references candidate fields',
  '    "answer": string     // user-facing prose, Korean ↔ English per query language',
  '  }',
].join('\n');

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildComparisonPrompt(input: ComparisonLlmFallbackInput): readonly ChatMessage[] {
  const header = [
    `User query: ${input.query}`,
    `Query language hint: ${input.hangulDominant ? 'Korean (respond in 한국어)' : 'English (respond in English)'}`,
  ].join('\n');

  let body = '';
  let truncated = false;
  for (const leg of input.originalRetrievalDocs) {
    const legBlock = serializeLegBlock(leg);
    if (body.length + legBlock.length + 1 > PROMPT_BODY_SOFT_MAX_CHARS) {
      truncated = true;
      break;
    }
    if (body.length > 0) body += '\n';
    body += legBlock;
  }
  if (truncated) body += PROMPT_TRUNCATION_MARKER;

  return [
    { role: 'user', content: header },
    { role: 'user', content: body },
  ];
}

function serializeLegBlock(leg: ComparisonLlmFallbackLeg): string {
  const lines: string[] = [];
  lines.push(`=== Leg ${leg.leg} ===`);
  lines.push(`Leg sub-query: ${clip(leg.legQuery, PROMPT_LEG_QUERY_MAX_CHARS)}`);
  lines.push(`Candidates (top ${String(Math.min(leg.candidates.length, MAX_CANDIDATES_PER_LEG))} of ${String(leg.candidates.length)}):`);
  const top = leg.candidates.slice(0, MAX_CANDIDATES_PER_LEG);
  for (let i = 0; i < top.length; i++) {
    const candidate = top[i];
    if (candidate === undefined) continue;
    lines.push(`  ${String(i + 1)}. ${serializeCandidate(candidate)}`);
  }
  return lines.join('\n');
}

function serializeCandidate(candidate: ComparisonFallbackCandidate): string {
  // Build a compact key:value list. Omitted fields are skipped (so the LLM
  // doesn't see `field=null` and conclude the field is "null" rather than
  // "unknown").
  const parts: string[] = [];
  if (candidate.canonicalLabel !== undefined) parts.push(`label=${clip(candidate.canonicalLabel, PROMPT_FIELD_MAX_CHARS)}`);
  if (candidate.producer !== undefined) parts.push(`producer=${clip(candidate.producer, PROMPT_FIELD_MAX_CHARS)}`);
  if (candidate.region !== undefined) parts.push(`region=${clip(candidate.region, PROMPT_FIELD_MAX_CHARS)}`);
  if (candidate.country !== undefined) parts.push(`country=${clip(candidate.country, PROMPT_FIELD_MAX_CHARS)}`);
  if (Number.isFinite(candidate.vintage)) parts.push(`vintage=${String(candidate.vintage)}`);
  if (candidate.grapes !== undefined && candidate.grapes.length > 0) {
    parts.push(`grapes=[${candidate.grapes.map((g) => clip(g, PROMPT_FIELD_MAX_CHARS)).join(',')}]`);
  }
  if (Number.isFinite(candidate.alcoholPct)) parts.push(`alcohol_pct=${String(candidate.alcoholPct)}`);
  if (Number.isFinite(candidate.criticScore)) parts.push(`critic_score=${String(candidate.criticScore)}`);
  if (candidate.priceRange !== undefined) parts.push(`price_range=${clip(candidate.priceRange, PROMPT_FIELD_MAX_CHARS)}`);
  if (Number.isFinite(candidate.body)) parts.push(`body=${String(candidate.body)}`);
  if (Number.isFinite(candidate.tannin)) parts.push(`tannin=${String(candidate.tannin)}`);
  if (Number.isFinite(candidate.acidity)) parts.push(`acidity=${String(candidate.acidity)}`);
  if (Number.isFinite(candidate.sweetness)) parts.push(`sweetness=${String(candidate.sweetness)}`);
  if (Number.isFinite(candidate.drinkingWindowStart)) parts.push(`drinking_window_start=${String(candidate.drinkingWindowStart)}`);
  if (Number.isFinite(candidate.drinkingWindowEnd)) parts.push(`drinking_window_end=${String(candidate.drinkingWindowEnd)}`);
  return parts.length > 0 ? parts.join(' | ') : '[no structured fields]';
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  // Always preserve at least one character before the ellipsis (defense
  // against `max < 1` collapsing to an empty slice).
  const head = Math.max(0, max - 1);
  return `${value.slice(0, head)}…`;
}

// ---------------------------------------------------------------------------
// Candidate extraction — pure structural narrowing from arbitrary tool
// outcome `result.items` shapes to `ComparisonFallbackCandidate`. The caller
// (orchestrator) feeds us tool outcomes; we never trust the shape with `as`
// casts (CLAUDE.md schema-quality bar).
// ---------------------------------------------------------------------------

/**
 * Best-effort structural extraction of comparison fields from an arbitrary
 * candidate record. Accepts both the entity-wrapped shape
 * (`{ entity: { canonicalLabel, ... }, drinkingWindow: { ... } }`) and the
 * flat-entity shape (`{ canonicalLabel, ... }`). Unknown / non-finite values
 * are OMITTED — never set to `null` or `0`, which would mislead the LLM
 * into thinking the field is "present and zero".
 *
 * Exported for direct testing of the structural narrowing.
 */
export function extractCandidateFields(raw: unknown): ComparisonFallbackCandidate {
  if (raw === null || typeof raw !== 'object') return {};
  const record = raw as Record<string, unknown>;
  // Prefer `entity` wrapper when present (this is the SearchResponseV1 /
  // ResultItem shape — most candidates arrive this way).
  const entityRaw = record['entity'];
  const entity: Record<string, unknown> = (entityRaw !== null && typeof entityRaw === 'object')
    ? entityRaw as Record<string, unknown>
    : record;
  const drinkingWindowRaw = record['drinkingWindow'];
  const drinkingWindow: Record<string, unknown> | undefined =
    (drinkingWindowRaw !== null && typeof drinkingWindowRaw === 'object')
      ? drinkingWindowRaw as Record<string, unknown>
      : undefined;

  return {
    ...pickString(entity, 'canonicalLabel', 'canonicalLabel'),
    ...pickString(entity, 'producer', 'producer'),
    ...pickString(entity, 'region', 'region'),
    ...pickString(entity, 'country', 'country'),
    ...pickFiniteNumber(entity, 'vintage', 'vintage'),
    ...pickStringArray(entity, 'grapes', 'grapes'),
    ...pickFiniteNumber(entity, 'alcoholPct', 'alcoholPct'),
    ...pickFiniteNumber(entity, 'criticScore', 'criticScore'),
    ...pickString(entity, 'priceRange', 'priceRange'),
    ...pickFiniteNumber(entity, 'body', 'body'),
    ...pickFiniteNumber(entity, 'tannin', 'tannin'),
    ...pickFiniteNumber(entity, 'acidity', 'acidity'),
    ...pickFiniteNumber(entity, 'sweetness', 'sweetness'),
    ...(drinkingWindow !== undefined
      ? {
          ...pickFiniteNumber(drinkingWindow, 'drinkingWindowStart', 'drinkingWindowStart'),
          ...pickFiniteNumber(drinkingWindow, 'drinkingWindowEnd', 'drinkingWindowEnd'),
        }
      : {}),
  };
}

function pickString(
  record: Record<string, unknown>,
  key: string,
  outKey: keyof ComparisonFallbackCandidate,
): Partial<ComparisonFallbackCandidate> {
  const value = record[key];
  if (typeof value === 'string' && value.trim().length > 0) {
    return { [outKey]: value.trim() } as Partial<ComparisonFallbackCandidate>;
  }
  return {};
}

function pickFiniteNumber(
  record: Record<string, unknown>,
  key: string,
  outKey: keyof ComparisonFallbackCandidate,
): Partial<ComparisonFallbackCandidate> {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { [outKey]: value } as Partial<ComparisonFallbackCandidate>;
  }
  return {};
}

function pickStringArray(
  record: Record<string, unknown>,
  key: string,
  outKey: keyof ComparisonFallbackCandidate,
): Partial<ComparisonFallbackCandidate> {
  const value = record[key];
  if (!Array.isArray(value)) return {};
  const cleaned: string[] = [];
  for (const v of value) {
    if (typeof v === 'string' && v.trim().length > 0) cleaned.push(v.trim());
  }
  if (cleaned.length === 0) return {};
  return { [outKey]: cleaned } as Partial<ComparisonFallbackCandidate>;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyFailure(err: unknown): ComparisonLlmFallbackFailureReason {
  if (err instanceof StructuredLlmTimeoutError) return 'timeout';
  if (err instanceof StructuredLlmCircuitOpenError) return 'circuit_open';
  if (err instanceof StructuredLlmRefusalError) return 'refusal';
  if (err instanceof StructuredLlmValidationError) return 'malformed_llm_output';
  if (err instanceof StructuredLlmPartialOutputError) return 'partial_output';
  return 'unexpected_error';
}

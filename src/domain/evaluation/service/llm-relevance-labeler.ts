/**
 * LLM-based silver labeling for retrieval relevance judgments.
 *
 * Uses an LLM to assess (query, candidate) relevance on a 4-point TREC scale.
 * Parses structured JSON output with Zod; falls back to a conservative grade
 * on parse failure to avoid false-positive relevance inflation.
 */

import { z } from 'zod';
import { coerceFiniteNumber } from '../../shared/utils/zod-coerce.js';
import type { ChatLlmPort } from '../../ai/port/chat-llm.port.js';
import type { RelevanceGrade } from '../model/relevance-judgment.js';

// ── Named constants ─────────────────────────────────────────────────────────

/** Conservative fallback grade (TREC "marginally relevant"). Picking 0
 *  would discard ambiguous candidates from training; picking 2+ would
 *  inflate recall on parse failures. 1 keeps the candidate visible
 *  while the gold-promotion stage filters it via the audit-queue path. */
export const FALLBACK_GRADE: RelevanceGrade = 1;

/** Conservative fallback confidence below both promote thresholds
 *  (HIGH_CONFIDENCE_THRESHOLD=0.85, AUDIT_LOWER_BOUND=0.5) so the
 *  fallback judgment lands in the rejected bucket of promote-to-gold. */
export const FALLBACK_CONFIDENCE = 0.3;

/** Low temperature for deterministic labeling (Zheng et al. 2023
 *  "Judging LLM-as-a-Judge"). Strict zero collapses near-tie cases too
 *  aggressively; 0.2 gives N-sample voting enough jitter to detect
 *  judgment instability without sacrificing reproducibility. */
const LABELING_TEMPERATURE = 0.2;

/** JSON payload is ~30 tokens; 256 leaves headroom for the rationale
 *  field without inviting verbose hallucinations beyond the structured
 *  output budget. */
const LABELING_MAX_TOKENS = 256;

/** Single retry on transient API failure. Labeling is offline batch
 *  work, so deeper retry chains add latency without recovering from
 *  persistent failures — those must surface to operators via logs. */
const LLM_RETRY_COUNT = 1;

// ── Types ───────────────────────────────────────────────────────────────────

export interface LabelingCandidate {
  readonly entityId: string;
  readonly canonicalLabel: string;
  readonly producer?: string;
  readonly region?: string;
  readonly grapes?: readonly string[];
  readonly style?: string;
  readonly priceUsd?: number;
  readonly vintageYear?: number;
}

export interface LabelingRequest {
  readonly query: string;
  readonly candidate: LabelingCandidate;
}

export interface LabelingResult {
  readonly grade: RelevanceGrade;
  readonly confidence: number;
  readonly rationale: string;
}

// ── Zod schema (NOT .strict() — LLM output may include extra fields) ────────


const LabelingResponseSchema = z.object({
  grade: coerceFiniteNumber.pipe(z.number().int().min(0).max(3)),
  // .finite() is defense-in-depth: coerceFiniteNumber already enforces finiteness,
  // but re-asserting at each pipe stage protects against schema drift if the
  // upstream coercion changes.
  confidence: coerceFiniteNumber.pipe(z.number().finite().min(0).max(1)),
  rationale: z.string().default(''),
});

// ── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a wine search relevance assessor. Given a user query and a candidate wine, assess relevance on a 4-point scale:

3 = HIGHLY RELEVANT: The wine perfectly matches the query intent. All constraints satisfied.
2 = RELEVANT: The wine is a reasonable match. Most constraints satisfied.
1 = MARGINALLY RELEVANT: The wine has some connection but doesn't satisfy key constraints.
0 = IRRELEVANT: The wine does not match the query at all.

Also provide:
- confidence: 0.0 to 1.0 (how sure you are)
- rationale: one sentence explaining the grade

Output ONLY valid JSON with no additional text: {"grade": N, "confidence": N, "rationale": "..."}`;

function buildUserPrompt(request: LabelingRequest): string {
  const c = request.candidate;
  const parts: string[] = [
    `Query: "${request.query}"`,
    '',
    'Candidate wine:',
    `  Name: ${c.canonicalLabel}`,
  ];
  if (c.producer) parts.push(`  Producer: ${c.producer}`);
  if (c.region) parts.push(`  Region: ${c.region}`);
  if (c.grapes && c.grapes.length > 0) parts.push(`  Grapes: ${c.grapes.join(', ')}`);
  if (c.style) parts.push(`  Style: ${c.style}`);
  if (c.priceUsd !== undefined) parts.push(`  Price: $${c.priceUsd}`);
  if (c.vintageYear !== undefined) parts.push(`  Vintage: ${c.vintageYear}`);
  return parts.join('\n');
}

// ── Core labeling function ──────────────────────────────────────────────────

/**
 * Extract JSON from LLM text that may include markdown fences or preamble.
 */
function extractJson(text: string): string {
  // Try markdown code block first
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();

  // Try to find first { ... } block
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    return text.slice(braceStart, braceEnd + 1);
  }

  return text.trim();
}

/**
 * Parse and validate an LLM labeling response.
 * Returns a LabelingResult with clamped values, or the conservative fallback.
 */
export function parseLabelingResponse(raw: string): LabelingResult {
  try {
    const json: unknown = JSON.parse(extractJson(raw));
    const parsed = LabelingResponseSchema.safeParse(json);
    if (!parsed.success) {
      return { grade: FALLBACK_GRADE, confidence: FALLBACK_CONFIDENCE, rationale: 'parse_fallback' };
    }
    return {
      grade: parsed.data.grade as RelevanceGrade,
      confidence: parsed.data.confidence,
      rationale: parsed.data.rationale,
    };
  } catch {
    return { grade: FALLBACK_GRADE, confidence: FALLBACK_CONFIDENCE, rationale: 'parse_fallback' };
  }
}

/**
 * Call the LLM to label relevance of a (query, candidate) pair.
 * Retries once on API error, then skips with a warning log.
 */
export async function labelRelevance(
  llm: ChatLlmPort,
  request: LabelingRequest,
  log?: { warn: (msg: string) => void },
): Promise<LabelingResult> {
  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: buildUserPrompt(request) },
  ];

  for (let attempt = 0; attempt <= LLM_RETRY_COUNT; attempt++) {
    try {
      const result = await llm.complete({
        messages,
        temperature: LABELING_TEMPERATURE,
        maxOutputTokens: LABELING_MAX_TOKENS,
      });
      return parseLabelingResponse(result.text);
    } catch (err) {
      if (attempt < LLM_RETRY_COUNT) continue;
      const msg = err instanceof Error ? err.message : String(err);
      log?.warn(`LLM labeling failed after ${LLM_RETRY_COUNT + 1} attempts: ${msg}`);
      return { grade: FALLBACK_GRADE, confidence: FALLBACK_CONFIDENCE, rationale: 'llm_error_fallback' };
    }
  }

  // Unreachable, but satisfies TypeScript control-flow analysis.
  return { grade: FALLBACK_GRADE, confidence: FALLBACK_CONFIDENCE, rationale: 'llm_error_fallback' };
}

/**
 * LLM semantic claim verifier (RFC-020).
 *
 * Handles semantic_claim and comparative_claim categories using NLI-style
 * verification. Batches all semantic claims into a single LLM call.
 *
 * Design: generation and evaluation are separated — the verifier receives
 * claims + evidence and independently judges support. It does NOT see the
 * original answer (preventing leakage).
 */

import type { ChatLlmPort } from '../../../domain/ai/port/chat-llm.port.js';
import type { ExtractedClaim, ClaimVerification, ClaimVerdict } from '../model/claim.js';

/** Temperature for semantic verification — 0.1 for consistency. */
const SEMANTIC_VERIFIER_TEMPERATURE = 0.1;
/** Max output tokens — calculated based on claim count.
 *  Each verdict object ≈ 60 tokens (id 16 + verdict + explanation).
 *  Budget formula: 200 base + 80 * claim_count, capped at 8000. */
function computeMaxTokens(claimCount: number): number {
  const TOKENS_PER_CLAIM = 80;
  const BASE_TOKENS = 200;
  const MAX_TOKENS = 8000;
  return Math.min(MAX_TOKENS, BASE_TOKENS + claimCount * TOKENS_PER_CLAIM);
}

/** Confidence score for entailed claims — high confidence, directly supported. */
const CONFIDENCE_ENTAILED = 0.9;
/** Confidence score for partially entailed claims — some support found. */
const CONFIDENCE_PARTIALLY_ENTAILED = 0.7;
/** Confidence score for not-entailed claims — no evidence either way. */
const CONFIDENCE_NOT_ENTAILED = 0.3;
/** Confidence score for contradicted claims — high confidence in conflict. */
const CONFIDENCE_CONTRADICTED = 0.9;

const SEMANTIC_VERIFIER_SYSTEM_PROMPT = `You are a claim verifier for a wine search engine. Given a list of claims and evidence context, verify each claim.

## Process
For each claim, determine:
- ENTAILED: claim is directly supported by the evidence
- PARTIALLY_ENTAILED: claim is partially correct (some aspects match, others don't or lack evidence)
- NOT_ENTAILED: no evidence for or against this claim
- CONTRADICTED: claim directly conflicts with the evidence

## Rules
- Only verify against the provided evidence. Do NOT use external knowledge.
- Tasting notes are subjective — if evidence describes "dark fruit" and claim says "blackberry", that is ENTAILED (specific instance of dark fruit).
- Pairing suggestions are ENTAILED if they match the wine's style profile in evidence.
- Comparative claims ("bolder than X") require BOTH wines' data in evidence. If only one is present, verdict is NOT_ENTAILED.
- "Similar to" claims are PARTIALLY_ENTAILED if the comparison wine exists in evidence but similarity is unverifiable.

## Output
JSON array, one object per claim:
[{"claim_id": "...", "verdict": "entailed|partially_entailed|not_entailed|contradicted", "explanation": "brief reason"}]

Output ONLY the JSON array. No markdown, no preamble.`;

/**
 * Verify a batch of semantic claims against evidence context using LLM NLI.
 *
 * @param llm - LLM port for inference
 * @param claims - Semantic/comparative claims to verify
 * @param evidenceContext - Concatenated evidence text from tool observations
 * @returns Verification results for each claim (same order as input)
 */
export async function verifySemanticBatch(
  llm: ChatLlmPort,
  claims: readonly ExtractedClaim[],
  evidenceContext: string,
): Promise<readonly ClaimVerification[]> {
  if (claims.length === 0) return [];

  const MAX_EVIDENCE_CONTEXT = 60_000; // ~15K tokens
  const truncatedContext = evidenceContext.length > MAX_EVIDENCE_CONTEXT
    ? evidenceContext.slice(0, MAX_EVIDENCE_CONTEXT) + '\n...[truncated]'
    : evidenceContext;

  const claimList = claims
    .map((c, i) => `${i + 1}. [${c.id}] ${c.field}: "${c.value}" (from: "${c.sourceText}")`)
    .join('\n');

  const userPrompt = `[EVIDENCE CONTEXT START]
${truncatedContext}
[EVIDENCE CONTEXT END]

[CLAIMS TO VERIFY]
${claimList}

Verify each claim against the evidence above.`;

  try {
    const result = await llm.complete({
      messages: [
        { role: 'system', content: SEMANTIC_VERIFIER_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: SEMANTIC_VERIFIER_TEMPERATURE,
      maxOutputTokens: computeMaxTokens(claims.length),
    });

    return parseBatchResponse(result.text, claims);
  } catch (err) {
    // LLM failure — emit llm_failed status so the aggregator excludes these
    // claims from denominators (silent degradation prevention).
    const errMsg = err instanceof Error ? err.message : String(err);
    return claims.map((c) => ({
      claimId: c.id,
      verdict: 'not_entailed' as ClaimVerdict,
      matchType: 'semantic_match' as const,
      verifierUsed: 'llm_semantic' as const,
      status: 'llm_failed' as const,
      confidence: 0,
      explanation: `LLM verifier call failed: ${errMsg}`,
    }));
  }
}

/**
 * Parse the LLM batch verification response into ClaimVerification array.
 * Handles JSON extraction from potential markdown wrapping.
 */
function parseBatchResponse(
  text: string,
  claims: readonly ExtractedClaim[],
): ClaimVerification[] {
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?\s*```\s*$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to find JSON array in the response
    const match = cleaned.match(/\[\s*\{[\s\S]*?\}\s*\]/);
    if (!match) {
      return fallbackVerifications(claims, 'failed to parse LLM response');
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return fallbackVerifications(claims, 'failed to parse extracted JSON');
    }
  }

  if (!Array.isArray(parsed)) {
    return fallbackVerifications(claims, 'LLM response is not an array');
  }

  const validIds = new Set(claims.map((c) => c.id));
  const resultMap = new Map<string, { verdict: ClaimVerdict; explanation: string }>();

  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const claimId = typeof obj['claim_id'] === 'string' ? obj['claim_id'] : '';
    const verdictRaw = typeof obj['verdict'] === 'string' ? obj['verdict'].toLowerCase() : '';
    const explanation = typeof obj['explanation'] === 'string' ? obj['explanation'] : '';

    const verdict = normalizeVerdict(verdictRaw);
    if (claimId.length > 0 && validIds.has(claimId)) {
      resultMap.set(claimId, { verdict, explanation });
    }
  }

  return claims.map((c) => {
    const found = resultMap.get(c.id);
    return {
      claimId: c.id,
      verdict: found?.verdict ?? ('not_entailed' as ClaimVerdict),
      matchType: 'semantic_match' as const,
      verifierUsed: 'llm_semantic' as const,
      status: found ? ('ok' as const) : ('missing_in_response' as const),
      confidence: found ? verdictToConfidence(found.verdict) : 0,
      explanation: found?.explanation ?? 'claim not found in LLM response',
    };
  });
}

function normalizeVerdict(raw: string): ClaimVerdict {
  const r = raw.toLowerCase().trim();
  if (r.includes('contradict') || r.includes('conflict') || r === 'false' || r === 'no') return 'contradicted';
  if (r.includes('partial')) return 'partially_entailed';
  if (r.includes('entail') || r === 'supported' || r === 'true' || r === 'yes' || r === 'support') return 'entailed';
  return 'not_entailed';
}

function verdictToConfidence(verdict: ClaimVerdict): number {
  switch (verdict) {
    case 'entailed': return CONFIDENCE_ENTAILED;
    case 'partially_entailed': return CONFIDENCE_PARTIALLY_ENTAILED;
    case 'not_entailed': return CONFIDENCE_NOT_ENTAILED;
    case 'contradicted': return CONFIDENCE_CONTRADICTED;
  }
}

function fallbackVerifications(
  claims: readonly ExtractedClaim[],
  reason: string,
): ClaimVerification[] {
  return claims.map((c) => ({
    claimId: c.id,
    verdict: 'not_entailed' as ClaimVerdict,
    matchType: 'semantic_match' as const,
    verifierUsed: 'llm_semantic' as const,
    status: 'parse_failed' as const,
    confidence: 0,
    explanation: reason,
  }));
}

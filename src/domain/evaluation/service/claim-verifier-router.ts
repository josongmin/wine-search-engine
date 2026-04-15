/**
 * Claim verifier router (RFC-020).
 *
 * Routes claims to deterministic, LLM semantic, or hybrid verifiers
 * based on the VERIFIER_ROUTING table. This is the single entry point
 * for claim verification — callers never call verifiers directly.
 *
 * Routing logic:
 *   identity_claim           → deterministic
 *   core_structured_claim    → deterministic
 *   derived_structured_claim → hybrid (deterministic first, LLM fallback)
 *   semantic_claim           → LLM semantic
 *   comparative_claim        → LLM semantic
 */

import type { ChatLlmPort } from '../../../domain/ai/port/chat-llm.port.js';
import type { ExtractedClaim, ClaimVerification } from '../model/claim.js';
import { VERIFIER_ROUTING } from '../model/claim.js';
import { verifyDeterministic } from './claim-verifier-deterministic.js';
import type { EvidenceRecord } from './claim-verifier-deterministic.js';
import { verifySemanticBatch } from './claim-verifier-semantic.js';

export type { EvidenceRecord } from './claim-verifier-deterministic.js';

/**
 * Route and verify all claims against evidence.
 *
 * Groups claims by verifier type, dispatches to the correct verifier,
 * and returns results in the same order as input claims.
 *
 * @param claims - All extracted claims from the answer
 * @param evidenceRecords - Structured evidence from tool observations
 * @param evidenceContext - Raw text of tool observations (for LLM verifier)
 * @param llm - LLM port (null to skip semantic verification)
 * @returns Verification results in same order as input claims
 */
export async function routeAndVerify(
  claims: readonly ExtractedClaim[],
  evidenceRecords: readonly EvidenceRecord[],
  evidenceContext: string,
  llm: ChatLlmPort | null,
): Promise<readonly ClaimVerification[]> {
  // Validate claim ID uniqueness — duplicates would silently overwrite in resultMap.
  const seenIds = new Set<string>();
  const dedupedClaims: ExtractedClaim[] = [];
  for (const c of claims) {
    if (!seenIds.has(c.id)) {
      seenIds.add(c.id);
      dedupedClaims.push(c);
    }
  }

  // Index results by claim ID for final ordering
  const resultMap = new Map<string, ClaimVerification>();

  // ── Group claims by verifier type ─────────────────────────────────────
  const deterministicClaims: ExtractedClaim[] = [];
  const semanticClaims: ExtractedClaim[] = [];
  const hybridClaims: ExtractedClaim[] = [];

  for (const claim of dedupedClaims) {
    const route = VERIFIER_ROUTING[claim.category];
    switch (route) {
      case 'deterministic':
        deterministicClaims.push(claim);
        break;
      case 'llm_semantic':
        semanticClaims.push(claim);
        break;
      case 'hybrid':
        hybridClaims.push(claim);
        break;
    }
  }

  // ── Deterministic verification (sync, zero LLM calls) ────────────────
  for (const claim of deterministicClaims) {
    resultMap.set(claim.id, verifyDeterministic(claim, evidenceRecords));
  }

  // ── Hybrid verification (deterministic first, LLM fallback) ──────────
  const hybridFallbackClaims: ExtractedClaim[] = [];
  for (const claim of hybridClaims) {
    const detResult = verifyDeterministic(claim, evidenceRecords);
    if (detResult.verdict !== 'not_entailed' || detResult.matchType !== 'no_match') {
      // Deterministic verifier found something — use it
      resultMap.set(claim.id, { ...detResult, verifierUsed: 'hybrid' });
    } else {
      // No deterministic evidence — queue for LLM fallback
      hybridFallbackClaims.push(claim);
    }
  }

  // ── LLM semantic verification (single batch call) ────────────────────
  const allSemanticClaims = [...semanticClaims, ...hybridFallbackClaims];
  const hybridFallbackIds = new Set(hybridFallbackClaims.map((c) => c.id));

  if (allSemanticClaims.length > 0 && llm !== null) {
    const semanticResults = await verifySemanticBatch(llm, allSemanticClaims, evidenceContext);
    for (const result of semanticResults) {
      const isHybridFallback = hybridFallbackIds.has(result.claimId);
      resultMap.set(result.claimId, {
        ...result,
        verifierUsed: isHybridFallback ? 'hybrid' : 'llm_semantic',
      });
    }
  } else if (allSemanticClaims.length > 0) {
    // No LLM available — emit skipped status so the aggregator can exclude these
    // claims from denominators (rather than counting them as 'not_entailed' which
    // would silently degrade faithfulness scores).
    for (const claim of allSemanticClaims) {
      resultMap.set(claim.id, {
        claimId: claim.id,
        verdict: 'not_entailed',
        matchType: 'no_match',
        verifierUsed: hybridFallbackIds.has(claim.id) ? 'hybrid' : 'llm_semantic',
        status: 'skipped_no_llm',
        confidence: 0,
        explanation: 'no LLM available for semantic verification',
      });
    }
  }

  // ── Return in deduped claim order ─────────────────────────────────────
  return dedupedClaims.map((c) => {
    const result = resultMap.get(c.id);
    if (result) return result;
    // Should not happen — every claim is routed
    return {
      claimId: c.id,
      verdict: 'not_entailed' as const,
      matchType: 'no_match' as const,
      verifierUsed: 'deterministic' as const,
      status: 'missing_in_response' as const,
      confidence: 0,
      explanation: 'claim not routed (internal error)',
    };
  });
}

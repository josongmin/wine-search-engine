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
import type { ExtractedClaim, ClaimVerification, FieldAnchor, WineField } from '../model/claim.js';
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
    // RC4: A comparative_claim ("Wine A is bolder than Wine B") whose named
    // wines are BOTH present in the evidence union has a deterministically
    // grounded factual basis — the two compared wines are real and were
    // retrieved. Comparison answers cite two legs (Side A / Side B); if we
    // routed every comparative sentence to the over-strict LLM (which treats
    // a relational opinion like "bolder" as unverifiable from structured
    // evidence → contradicted), the comparison_query hard-fail policy would
    // collapse faithfulness to 0 even when both wines are correctly grounded.
    // So we ground the comparative claim's wine identities deterministically
    // FIRST, across the unioned evidence (both legs), before any LLM fallback.
    if (claim.category === 'comparative_claim') {
      const comparativeGrounding = verifyComparativeGrounding(claim, evidenceRecords);
      if (comparativeGrounding !== undefined) {
        resultMap.set(claim.id, comparativeGrounding);
        continue;
      }
      // No named wine grounded deterministically — fall through to LLM semantic.
    }

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
    const semanticClaimsById = new Map(allSemanticClaims.map((claim) => [claim.id, claim]));
    for (const result of semanticResults) {
      const isHybridFallback = hybridFallbackIds.has(result.claimId);
      const claim = semanticClaimsById.get(result.claimId);
      const anchoredResult = claim === undefined
        ? result
        : attachSemanticEvidenceAnchor(result, claim, evidenceRecords);
      resultMap.set(result.claimId, {
        ...anchoredResult,
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

// ─── RC4: deterministic two-sided comparative-claim grounding ────────────
//
// A comparative_claim references one or more wines by name ("Sassicaia is
// fuller-bodied than Tignanello"). When the named wines appear in the
// evidence union we treat the comparison's factual subjects as grounded,
// rather than routing the relational opinion to the over-strict LLM judge.

/** Min token length for a label/producer token to be eligible as a wine reference
 *  (avoids matching short stopwords like "the"/"red"/"DOC" inside the claim text). */
const COMPARATIVE_LABEL_TOKEN_MIN_LEN = 4;
/** Distinct grounded wines required to call a comparison fully two-sided (entailed). */
const COMPARATIVE_TWO_SIDED_MIN_WINES = 2;
/** Confidence assigned when both compared wines ground deterministically. */
const COMPARATIVE_TWO_SIDED_CONFIDENCE = 0.9;
/** Confidence assigned when only one side of the comparison grounds. */
const COMPARATIVE_ONE_SIDED_CONFIDENCE = 0.5;
/** Stopwords that must never count as a wine-name reference on their own. */
const COMPARATIVE_LABEL_STOPWORDS: ReadonlySet<string> = new Set([
  'wine', 'wines', 'red', 'white', 'rose', 'rosé', 'blend', 'brut',
  'reserve', 'cuvee', 'cuvée', 'estate', 'grand', 'cru', 'vintage',
  'bottle', 'price', 'style', 'region', 'producer', 'than', 'more', 'less',
]);

/**
 * Normalize a string for comparative reference matching: NFKC + lowercase.
 */
function normalizeForComparison(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

/**
 * Decide whether an evidence wine is referenced inside the comparative claim
 * text. A wine is referenced when its canonical_label (or producer) appears as
 * a substring of the claim text after NFKC+lowercase normalization, OR when a
 * sufficiently distinctive label token (≥ COMPARATIVE_LABEL_TOKEN_MIN_LEN,
 * non-stopword) appears in the claim text.
 */
function evidenceWineReferencedInText(
  evidence: EvidenceRecord,
  normalizedClaimText: string,
): boolean {
  const candidates: string[] = [];
  for (const field of ['canonical_label', 'producer'] as const) {
    const value = evidence[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      candidates.push(value);
    }
  }
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeForComparison(candidate);
    // Full-label substring is the strongest signal.
    if (normalizedCandidate.length >= COMPARATIVE_LABEL_TOKEN_MIN_LEN
      && normalizedClaimText.includes(normalizedCandidate)) {
      return true;
    }
    // Otherwise look for a distinctive single token from the label.
    const tokens = normalizedCandidate.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
    for (const token of tokens) {
      if (token.length < COMPARATIVE_LABEL_TOKEN_MIN_LEN) continue;
      if (COMPARATIVE_LABEL_STOPWORDS.has(token)) continue;
      if (normalizedClaimText.includes(token)) return true;
    }
  }
  return false;
}

/**
 * RC4: ground a comparative claim against the evidence union by checking how
 * many distinct evidence wines it references.
 *
 *   ≥2 distinct grounded wines → entailed (both comparison legs grounded)
 *   exactly 1 grounded wine     → partially_entailed (single leg grounded;
 *                                  e.g. only one wine was retrieved)
 *   0 grounded wines            → undefined (caller routes to LLM semantic)
 *
 * Returns a deterministic ClaimVerification, or undefined to defer to the LLM.
 */
function verifyComparativeGrounding(
  claim: ExtractedClaim,
  evidenceRecords: readonly EvidenceRecord[],
): ClaimVerification | undefined {
  const normalizedClaimText = normalizeForComparison(claim.sourceText.length > 0 ? claim.sourceText : claim.value);
  if (normalizedClaimText.trim().length === 0) {
    return undefined;
  }

  // Track distinct grounded wines by a stable identity key (entity_id ?? label).
  const groundedWineKeys = new Set<string>();
  let firstAnchor: FieldAnchor | undefined;
  for (const evidence of evidenceRecords) {
    if (!evidenceWineReferencedInText(evidence, normalizedClaimText)) continue;
    const wineId = comparativeWineId(evidence);
    if (groundedWineKeys.has(wineId)) continue;
    groundedWineKeys.add(wineId);
    if (firstAnchor === undefined) {
      const label = evidence['canonical_label'] ?? evidence['producer'] ?? wineId;
      firstAnchor = {
        wineId,
        field: 'canonical_label',
        value: String(label),
        source: comparativeAnchorSource(evidence),
      };
    }
  }

  if (groundedWineKeys.size === 0) {
    return undefined;
  }

  const twoSided = groundedWineKeys.size >= COMPARATIVE_TWO_SIDED_MIN_WINES;
  return {
    claimId: claim.id,
    verdict: twoSided ? 'entailed' : 'partially_entailed',
    matchType: 'normalized_match',
    verifierUsed: 'deterministic',
    status: 'ok',
    ...(firstAnchor !== undefined ? { evidenceAnchor: firstAnchor } : {}),
    confidence: twoSided ? COMPARATIVE_TWO_SIDED_CONFIDENCE : COMPARATIVE_ONE_SIDED_CONFIDENCE,
    explanation: twoSided
      ? `comparative claim references ${groundedWineKeys.size} grounded wines (both legs present in evidence)`
      : `comparative claim references 1 grounded wine; counterpart not found in evidence union`,
  };
}

function comparativeWineId(evidence: EvidenceRecord): string {
  const entityId = evidence['entity_id'];
  if (typeof entityId === 'string' && entityId.trim().length > 0) return entityId;
  const label = evidence['canonical_label'];
  if (typeof label === 'string' && label.trim().length > 0) return normalizeForComparison(label);
  const producer = evidence['producer'];
  if (typeof producer === 'string' && producer.trim().length > 0) return normalizeForComparison(producer);
  return 'unknown';
}

function comparativeAnchorSource(evidence: EvidenceRecord): FieldAnchor['source'] {
  const toolName = evidence['__source_tool_name'];
  const stepIndex = evidence['__source_step_index'];
  if (typeof toolName === 'string' && toolName.trim().length > 0) {
    return {
      type: 'tool_observation',
      stepIndex: typeof stepIndex === 'number' && Number.isInteger(stepIndex) && stepIndex >= 0
        ? stepIndex
        : 0,
      toolName,
    };
  }
  return { type: 'tool_observation', stepIndex: 0, toolName: 'search_wines' };
}

/** Max chars of raw observation text kept in a semantic FieldAnchor.value (provenance excerpt). */
const RAW_EVIDENCE_ANCHOR_MAX_CHARS = 500;

const SEMANTIC_ANCHOR_FIELDS: readonly WineField[] = [
  'profile_evidence',
  'claimable_attributes',
  'pairing_tags',
  'occasion',
  'style',
  'sweetness',
  'acidity',
  'tannin',
  'body',
  'wine_type',
];

function attachSemanticEvidenceAnchor(
  verification: ClaimVerification,
  claim: ExtractedClaim,
  evidenceRecords: readonly EvidenceRecord[],
): ClaimVerification {
  if (
    verification.evidenceAnchor !== undefined
    || verification.status !== 'ok'
    || (verification.verdict !== 'entailed' && verification.verdict !== 'partially_entailed')
  ) {
    return verification;
  }

  const anchor = findSemanticEvidenceAnchor(claim, evidenceRecords);
  return anchor === undefined ? verification : { ...verification, evidenceAnchor: anchor };
}

function findSemanticEvidenceAnchor(
  claim: ExtractedClaim,
  evidenceRecords: readonly EvidenceRecord[],
): FieldAnchor | undefined {
  for (const field of SEMANTIC_ANCHOR_FIELDS) {
    for (const evidence of evidenceRecords) {
      const value = evidence[field];
      if (value === undefined || value === null) {
        continue;
      }
      const renderedValue = Array.isArray(value) ? value.join(', ') : String(value);
      if (renderedValue.trim().length === 0) {
        continue;
      }
      return {
        wineId: semanticAnchorWineId(evidence),
        field,
        value: renderedValue,
        source: semanticAnchorSource(evidence),
      };
    }
  }

  const rawEvidence = evidenceRecords.find((evidence) =>
    typeof evidence['__raw__'] === 'string' && evidence['__raw__'].trim().length > 0);
  if (rawEvidence !== undefined && typeof rawEvidence['__raw__'] === 'string') {
    return {
      wineId: semanticAnchorWineId(rawEvidence),
      field: claim.field,
      value: rawEvidence['__raw__'].slice(0, RAW_EVIDENCE_ANCHOR_MAX_CHARS),
      source: semanticAnchorSource(rawEvidence),
    };
  }

  return undefined;
}

function semanticAnchorWineId(evidence: EvidenceRecord): string {
  const entityId = evidence['entity_id'];
  if (typeof entityId === 'string' && entityId.trim().length > 0) {
    return entityId;
  }
  const label = evidence['canonical_label'];
  if (typeof label === 'string' && label.trim().length > 0) {
    return label;
  }
  return 'semantic-evidence';
}

function semanticAnchorSource(evidence: EvidenceRecord): FieldAnchor['source'] {
  const toolName = evidence['__source_tool_name'];
  const stepIndex = evidence['__source_step_index'];
  if (typeof toolName === 'string' && toolName.trim().length > 0) {
    return {
      type: 'tool_observation',
      stepIndex: typeof stepIndex === 'number' && Number.isInteger(stepIndex) && stepIndex >= 0
        ? stepIndex
        : 0,
      toolName,
    };
  }
  return { type: 'tool_observation', stepIndex: 0, toolName: 'search_wines' };
}

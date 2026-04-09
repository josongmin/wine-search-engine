/**
 * Claim-level evaluator orchestrator (RFC-020).
 *
 * Pipeline:
 *   1. Extract typed claims from answer (claim-extractor)
 *   2. Route claims to verifiers (claim-verifier-router)
 *   3. Aggregate verdicts into DiagnosticVector
 *   4. Compute faithfulness score + error rates + hard-fail check
 *
 * This replaces the monolithic RAGAS faithfulness LLM judge with a
 * schema-aware, hybrid deterministic+LLM evaluation pipeline.
 */

import type { ChatLlmPort } from '../../../domain/ai/port/chat-llm.port.js';
import type {
  ExtractedClaim,
  ClaimVerification,
  DiagnosticVector,
  CategoryDiagnostic,
  ClaimCategory,
  TaskType,
} from '../model/claim.js';
import { CLAIM_CATEGORY_WEIGHTS, VERDICT_SCORES, HARD_FAIL_POLICY } from '../model/claim.js';
import { extractClaims } from './claim-extractor.js';
import { routeAndVerify } from './claim-verifier-router.js';
import type { EvidenceRecord } from './claim-verifier-router.js';

export type { EvidenceRecord } from './claim-verifier-router.js';

/** All claim categories for iteration. */
const ALL_CATEGORIES: readonly ClaimCategory[] = [
  'identity_claim',
  'core_structured_claim',
  'derived_structured_claim',
  'semantic_claim',
  'comparative_claim',
];

/** Empty category diagnostic for categories with no claims. */
const EMPTY_CATEGORY: CategoryDiagnostic = {
  claimCount: 0,
  entailedCount: 0,
  partiallyEntailedCount: 0,
  notEntailedCount: 0,
  contradictedCount: 0,
  avgConfidence: 0,
  weightedScore: 0,
};
Object.freeze(EMPTY_CATEGORY);

/**
 * Evaluate an agent's answer at claim level.
 *
 * @param answer - The agent's answer text
 * @param evidenceRecords - Structured evidence parsed from tool observations
 * @param evidenceContext - Raw text of all tool observations
 * @param taskType - Task type for hard-fail policy selection
 * @param llm - LLM port for semantic verification (null to skip)
 * @returns Complete diagnostic vector with claim-level breakdown
 */
export async function evaluateClaims(
  answer: string,
  evidenceRecords: readonly EvidenceRecord[],
  evidenceContext: string,
  taskType: TaskType,
  llm: ChatLlmPort | null,
): Promise<DiagnosticVector> {
  // ── Step 1: Extract claims ──────────────────────────────────────────
  const claims = extractClaims(answer);

  if (claims.length === 0) {
    return emptyDiagnostic(claims, []);
  }

  // ── Step 2: Route and verify ────────────────────────────────────────
  const verifications = await routeAndVerify(claims, evidenceRecords, evidenceContext, llm);

  // ── Step 3: Aggregate ───────────────────────────────────────────────
  return aggregate(claims, verifications, taskType);
}

/**
 * Aggregate claim verifications into a DiagnosticVector.
 */
function aggregate(
  claims: readonly ExtractedClaim[],
  verifications: readonly ClaimVerification[],
  taskType: TaskType,
): DiagnosticVector {
  // Verifications that did not run successfully (LLM failed, no LLM, parse failed)
  // are excluded from faithfulness/contradiction denominators.
  const validVerifications = verifications.filter((v) => v.status === 'ok');
  const validVerificationMap = new Map<string, ClaimVerification>();
  for (const v of validVerifications) {
    validVerificationMap.set(v.claimId, v);
  }
  const verifiedClaimCount = validVerifications.length;
  const skippedClaimCount = verifications.length - validVerifications.length;

  // ── Per-category aggregation ────────────────────────────────────────
  const perCategory = {} as Record<ClaimCategory, CategoryDiagnostic>;
  for (const cat of ALL_CATEGORIES) {
    const catClaims = claims.filter((c) => c.category === cat);
    const catVerifications = catClaims
      .map((c) => validVerificationMap.get(c.id))
      .filter((v): v is ClaimVerification => v !== undefined);

    if (catClaims.length === 0) {
      perCategory[cat] = EMPTY_CATEGORY;
      continue;
    }

    const entailedCount = catVerifications.filter((v) => v.verdict === 'entailed').length;
    const partiallyEntailedCount = catVerifications.filter((v) => v.verdict === 'partially_entailed').length;
    const notEntailedCount = catVerifications.filter((v) => v.verdict === 'not_entailed').length;
    const contradictedCount = catVerifications.filter((v) => v.verdict === 'contradicted').length;

    const avgConfidence = catVerifications.length > 0
      ? catVerifications.reduce((sum, v) => sum + v.confidence, 0) / catVerifications.length
      : 0;

    const weightedScore = catVerifications.length > 0
      ? catVerifications.reduce((sum, v) => sum + VERDICT_SCORES[v.verdict], 0) / catVerifications.length
      : 0;

    perCategory[cat] = {
      claimCount: catClaims.length,
      entailedCount,
      partiallyEntailedCount,
      notEntailedCount,
      contradictedCount,
      avgConfidence,
      weightedScore,
    };
  }

  // ── Weighted faithfulness score ─────────────────────────────────────
  let weightedSum = 0;
  let weightTotal = 0;
  for (const cat of ALL_CATEGORIES) {
    const catDiag = perCategory[cat];
    const verifiedInCat = catDiag.entailedCount + catDiag.partiallyEntailedCount + catDiag.notEntailedCount + catDiag.contradictedCount;
    if (verifiedInCat === 0) continue;
    const weight = CLAIM_CATEGORY_WEIGHTS[cat];
    weightedSum += catDiag.weightedScore * weight * verifiedInCat;
    weightTotal += weight * verifiedInCat;
  }
  const faithfulnessScore = weightTotal > 0 ? weightedSum / weightTotal : 1.0;

  // ── Error rates ─────────────────────────────────────────────────────
  const verifiableClaims = validVerifications.filter((v) => v.verdict !== 'not_entailed');
  const contradictionRate = verifiableClaims.length > 0
    ? verifiableClaims.filter((v) => v.verdict === 'contradicted').length / verifiableClaims.length
    : 0;

  const criticalClaims = claims.filter(
    (c) => c.category === 'identity_claim' || c.category === 'core_structured_claim',
  );
  const criticalVerifications = criticalClaims
    .map((c) => validVerificationMap.get(c.id))
    .filter((v): v is ClaimVerification => v !== undefined);
  const criticalErrorRate = criticalVerifications.length > 0
    ? criticalVerifications.filter((v) => v.verdict === 'contradicted').length / criticalVerifications.length
    : 0;

  const semanticClaims = claims.filter((c) => c.category === 'semantic_claim');
  const semanticVerifications = semanticClaims
    .map((c) => validVerificationMap.get(c.id))
    .filter((v): v is ClaimVerification => v !== undefined);
  const unsupportedSoftClaimRate = semanticVerifications.length > 0
    ? semanticVerifications.filter((v) => v.verdict === 'not_entailed').length / semanticVerifications.length
    : 0;

  // ── Coverage ────────────────────────────────────────────────────────
  const provenanceCoverage = claims.length > 0
    ? validVerifications.filter((v) => v.evidenceAnchor !== undefined).length / claims.length
    : 0;

  const deterministicCoverage = claims.length > 0
    ? validVerifications.filter((v) => v.verifierUsed === 'deterministic').length / claims.length
    : 0;

  // ── Cost ────────────────────────────────────────────────────────────
  const llmCallCount = verifications.filter(
    (v) => v.verifierUsed === 'llm_semantic' ||
           (v.verifierUsed === 'hybrid' && v.matchType === 'semantic_match'),
  ).length;
  const deterministicCheckCount = verifications.filter((v) => v.verifierUsed === 'deterministic' || v.verifierUsed === 'hybrid').length;

  // ── Hard-fail check ─────────────────────────────────────────────────
  const policy = HARD_FAIL_POLICY[taskType];
  const hardFailReasons: string[] = [];

  for (const claim of claims) {
    const v = validVerificationMap.get(claim.id);
    if (v?.verdict === 'contradicted' && policy[claim.category]) {
      hardFailReasons.push(`${claim.category}/${claim.field}: "${claim.value}"`);
    }
  }
  const hardFail = hardFailReasons.length > 0;
  const hardFailReason: string | undefined = hardFail
    ? `${hardFailReasons.length} critical contradiction(s): ${hardFailReasons.join('; ')}`
    : undefined;

  // Invariant: hardFail=true ⇒ faithfulnessScore=0 (consistency)
  const finalFaithfulnessScore = hardFail ? 0 : faithfulnessScore;

  return {
    faithfulnessScore: finalFaithfulnessScore,
    contradictionRate,
    criticalErrorRate,
    unsupportedSoftClaimRate,
    provenanceCoverage,
    deterministicCoverage,
    llmCallCount,
    deterministicCheckCount,
    verifiedClaimCount,
    skippedClaimCount,
    perCategory,
    claims,
    verifications,
    hardFail,
    ...(hardFailReason !== undefined ? { hardFailReason } : {}),
  };
}

function emptyDiagnostic(
  claims: readonly ExtractedClaim[],
  verifications: readonly ClaimVerification[],
): DiagnosticVector {
  const perCategory = {} as Record<ClaimCategory, CategoryDiagnostic>;
  for (const cat of ALL_CATEGORIES) {
    perCategory[cat] = EMPTY_CATEGORY;
  }
  return {
    faithfulnessScore: 1.0, // no claims = no contradictions = perfect
    contradictionRate: 0,
    criticalErrorRate: 0,
    unsupportedSoftClaimRate: 0,
    provenanceCoverage: 0,
    deterministicCoverage: 0,
    llmCallCount: 0,
    deterministicCheckCount: 0,
    verifiedClaimCount: 0,
    skippedClaimCount: 0,
    perCategory,
    claims,
    verifications,
    hardFail: false,
  };
}

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
 * Options for {@link evaluateClaims}.
 */
export interface EvaluateClaimsOptions {
  /**
   * Deterministic "current year" used as the upper bound for accepted vintage
   * year claims. When omitted, falls back to `new Date().getFullYear()`.
   * Replay harnesses MUST pin this value so eval results are bit-stable
   * across a year boundary (see RFC-009 §8 / CLAUDE.md replay discipline).
   */
  readonly currentYear?: number;
}

/**
 * Evaluate an agent's answer at claim level.
 *
 * @param answer - The agent's answer text
 * @param evidenceRecords - Structured evidence parsed from tool observations
 * @param evidenceContext - Raw text of all tool observations
 * @param taskType - Task type for hard-fail policy selection
 * @param llm - LLM port for semantic verification (null to skip)
 * @param options - Optional knobs (e.g. pinned currentYear for replay determinism)
 * @returns Complete diagnostic vector with claim-level breakdown
 */
export async function evaluateClaims(
  answer: string,
  evidenceRecords: readonly EvidenceRecord[],
  evidenceContext: string,
  taskType: TaskType,
  llm: ChatLlmPort | null,
  options?: EvaluateClaimsOptions,
): Promise<DiagnosticVector> {
  // ── Step 1: Extract claims ──────────────────────────────────────────
  const claims = extractClaims(
    answer,
    options?.currentYear !== undefined ? { currentYear: options.currentYear } : undefined,
  );

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
  // ADR-016 §2.8 — evaluator-bias dual reporting. We compute two
  // aggregates: one with `status === 'ok'` filter (legacy behaviour)
  // and one without (treats skipped as `not_entailed`). The summary
  // reports BOTH; the ADR prescribes the LOWER as the effective gate.
  const validVerifications = verifications.filter((v) => v.status === 'ok');
  const validVerificationMap = new Map<string, ClaimVerification>();
  for (const v of validVerifications) {
    validVerificationMap.set(v.claimId, v);
  }
  const verifiedClaimCount = validVerifications.length;
  const skippedClaimCount = verifications.length - validVerifications.length;

  // Second-pass aggregate without the status filter. Computed alongside
  // the main aggregate so the dual-report pair is always consistent
  // (same `claims` / `verifications` inputs, different denominator).
  const faithfulnessScoreAll = computeFaithfulnessAcrossAllVerifications(
    claims,
    verifications,
  );

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

    let entailedCount = 0;
    let partiallyEntailedCount = 0;
    let notEntailedCount = 0;
    let contradictedCount = 0;
    for (const v of catVerifications) {
      switch (v.verdict) {
        case 'entailed': entailedCount++; break;
        case 'partially_entailed': partiallyEntailedCount++; break;
        case 'not_entailed': notEntailedCount++; break;
        case 'contradicted': contradictedCount++; break;
      }
    }

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
  const finalFaithfulnessScoreAll = hardFail ? 0 : faithfulnessScoreAll;

  return {
    faithfulnessScore: finalFaithfulnessScore,
    faithfulnessScoreAll: finalFaithfulnessScoreAll,
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

/**
 * ADR-016 §2.8 — faithfulness score across ALL verifications (no status
 * filter). Skipped / LLM-failed / parse-failed verifications count as
 * `not_entailed` (score = 0.0).
 */
function computeFaithfulnessAcrossAllVerifications(
  claims: readonly ExtractedClaim[],
  verifications: readonly ClaimVerification[],
): number {
  if (claims.length === 0) return 1.0;
  const verMap = new Map<string, ClaimVerification>();
  for (const v of verifications) verMap.set(v.claimId, v);

  let weightedSum = 0;
  let weightTotal = 0;
  for (const cat of ALL_CATEGORIES) {
    const catClaims = claims.filter((c) => c.category === cat);
    if (catClaims.length === 0) continue;
    let catScoreSum = 0;
    for (const c of catClaims) {
      const v = verMap.get(c.id);
      // Skipped verifications count as 0 (not_entailed equivalent).
      catScoreSum += v !== undefined && v.status === 'ok'
        ? VERDICT_SCORES[v.verdict]
        : 0;
    }
    const weight = CLAIM_CATEGORY_WEIGHTS[cat];
    weightedSum += catScoreSum * weight;
    weightTotal += weight * catClaims.length;
  }
  return weightTotal > 0 ? weightedSum / weightTotal : 1.0;
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
    faithfulnessScoreAll: 1.0,
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

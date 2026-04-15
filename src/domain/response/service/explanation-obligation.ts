/**
 * E4-U5: Query-Family Explanation Obligation Map
 *
 * Defines the minimum explanation obligations per query family.
 * Consumers (ResponseBuilder, interpret/explain adapters) read this map to
 * decide whether evidence items, counterfactuals, or clarification payloads
 * MUST be included in the response.
 *
 * Scope:
 *   - Obligation semantics only (what MUST be present)
 *   - NOT copywriting, format templates, or language generation
 *   - NOT a replacement for evidence-gate.ts (that owns obligation *enforcement*)
 *
 * Design:
 *   - One entry per QueryFamily label (matches QUERY_FAMILY_LABELS in query-observability-vocab.ts)
 *   - requiresEvidenceItems: at least one EvidenceItem must be surfaced
 *   - requiresCounterfactual: at least one CounterfactualReject should be included
 *     when rejected candidates exist
 *   - requiresClarification: clarification payload should be included when
 *     ambiguity is detected
 *   - suppressRawScores: callers must NOT expose raw finalScore / componentScores
 *     in the external response for this family
 */

import type { QueryFamily } from '../../retrieval/service/channel-mix-policy.js';

interface ExplanationObligation {
  /** At least one EvidenceItem must be present in results for this family. */
  readonly requiresEvidenceItems: boolean;

  /**
   * When rejected candidates exist, at least one CounterfactualReject should
   * be included in the response for transparency.
   */
  readonly requiresCounterfactual: boolean;

  /**
   * When decision returns ambiguous/clarify, clarification payload is required.
   * False for families where ambiguity is unexpected (e.g. exact lookup).
   */
  readonly requiresClarification: boolean;

  /**
   * Raw numeric scores (finalScore, componentScores) must not be surfaced
   * directly to external consumers for this family.
   */
  readonly suppressRawScores: boolean;
}

/**
 * Authoritative obligation map: QueryFamily → ExplanationObligation.
 *
 * Every QUERY_FAMILY_LABELS entry must be represented here.
 * Extend when a new label is added to query-observability-vocab.ts.
 */
const EXPLANATION_OBLIGATION_MAP: Record<QueryFamily, ExplanationObligation> = {
  // Exact entity lookup — high confidence, minimal explanation needed
  entity_exact: {
    requiresEvidenceItems: false,
    requiresCounterfactual: false,
    requiresClarification: false,
    suppressRawScores: true,
  },

  // Fuzzy entity lookup — low ambiguity, evidence helpful
  entity_fuzzy: {
    requiresEvidenceItems: true,
    requiresCounterfactual: false,
    requiresClarification: false,
    suppressRawScores: true,
  },

  // Entity resolution — may be ambiguous, evidence + clarification valuable
  entity_resolution: {
    requiresEvidenceItems: true,
    requiresCounterfactual: false,
    requiresClarification: true,
    suppressRawScores: true,
  },

  // Attribute-constrained — filter semantics, evidence required to justify constraints
  attribute_constrained: {
    requiresEvidenceItems: true,
    requiresCounterfactual: true,
    requiresClarification: false,
    suppressRawScores: true,
  },

  // Producer browse — listing, minimal explanation needed
  producer_browse: {
    requiresEvidenceItems: false,
    requiresCounterfactual: false,
    requiresClarification: false,
    suppressRawScores: true,
  },

  // Region browse — listing, minimal explanation needed
  region_browse: {
    requiresEvidenceItems: false,
    requiresCounterfactual: false,
    requiresClarification: false,
    suppressRawScores: true,
  },

  // Comparison — anchor-relative, full evidence required for both sides
  comparison: {
    requiresEvidenceItems: true,
    requiresCounterfactual: false,
    requiresClarification: false,
    suppressRawScores: true,
  },

  // Recommendation / semantic preference — ambiguous, full explanation
  recommendation: {
    requiresEvidenceItems: true,
    requiresCounterfactual: true,
    requiresClarification: true,
    suppressRawScores: true,
  },

  // Pairing — wine+food, evidence helpful for pairing rationale
  pairing: {
    requiresEvidenceItems: true,
    requiresCounterfactual: false,
    requiresClarification: false,
    suppressRawScores: true,
  },

  // Multi-intent — mixed signals, full explanation + clarification
  multi_intent: {
    requiresEvidenceItems: true,
    requiresCounterfactual: true,
    requiresClarification: true,
    suppressRawScores: true,
  },

  // No match — nothing to explain, clarification may help user rephrase
  no_match: {
    requiresEvidenceItems: false,
    requiresCounterfactual: false,
    requiresClarification: true,
    suppressRawScores: true,
  },

  // Ambiguous — full explanation + clarification mandatory
  ambiguous: {
    requiresEvidenceItems: false,
    requiresCounterfactual: false,
    requiresClarification: true,
    suppressRawScores: true,
  },

  // Unknown — fallback, safest: full explanation
  unknown: {
    requiresEvidenceItems: true,
    requiresCounterfactual: false,
    requiresClarification: true,
    suppressRawScores: true,
  },
} as const;

/**
 * Returns the explanation obligation for a given query family.
 * Falls back to the most conservative (unknown) obligation when the family
 * is unrecognized — unknown families should explain fully.
 */
export function getExplanationObligation(queryFamily: string): ExplanationObligation {
  if (Object.hasOwn(EXPLANATION_OBLIGATION_MAP, queryFamily)) {
    return EXPLANATION_OBLIGATION_MAP[queryFamily as QueryFamily];
  }
  return EXPLANATION_OBLIGATION_MAP.unknown;
}

/**
 * E4-U2: Machine Response Builder V2 — Machine/Tool Sidecar Surface
 * Exposed only via /v1/claude-tools route. NOT wired into /v2/search/* handlers.
 * See response-builder.ts (E4-U1) for the main runtime surface.
 */

/**
 * T6.3: Machine Response Builder V2
 *
 * Builds a structured provenance/evidence envelope for machine/LLM consumers.
 * Exposed only via the /v1/claude-tools seam — NOT via any /v2/search/* route.
 *
 * Design contract:
 * - Serialises the full ComponentScores object as-is.
 * - Maps EvidenceItem[] to structured { signal, value, weight } objects.
 * - Includes retrievalProvenance as a compact string when present.
 * - version: '2', responseType: 'machine' throughout.
 */

import type { RankedResult } from '../../ranking/model/ranked-result.js';
import { preferCanonicalRetrievalChannelLabels } from '../../retrieval/model/retrieval-channel.js';
import type {
  ResultItemV2Machine,
  SearchResponseV2Machine,
} from '../model/result-item-v2.js';

/** Decimal places for fusion score in compact provenance string. */
const RETRIEVAL_PROVENANCE_FUSION_SCORE_DECIMALS = 4;
/** Evidence strength → numeric weight for machine consumers. */
const EVIDENCE_WEIGHT_HIGH = 1;
const EVIDENCE_WEIGHT_MEDIUM = 0.5;
const EVIDENCE_WEIGHT_LOW = 0.1;

export interface MachineResponseBuildParamsV2 {
  readonly queryId: string;
  readonly results: readonly RankedResult[];
}

/**
 * Serialize a {@link CandidateProvenance} to a compact string suitable for
 * the {@link ResultItemV2MachineSchema} `retrievalProvenance` field.
 *
 * Format: `<channels>@<fusionProfile>/<fusionScore>`
 * Example: `sparse_bm25,dense_semantic@rrf-default/0.7812`
 */
function serializeProvenance(
  provenance: NonNullable<RankedResult['retrievalProvenance']>,
): string {
  const channels = preferCanonicalRetrievalChannelLabels(provenance.channels).join(',');
  const score = provenance.fusionScore.toFixed(RETRIEVAL_PROVENANCE_FUSION_SCORE_DECIMALS);
  return `${channels}@${provenance.fusionProfile}/${score}`;
}

/**
 * Build a machine-optimised V2 search response from ranked results.
 *
 * Each {@link RankedResult} is projected to a {@link ResultItemV2Machine}:
 * - Full ComponentScores object serialised as-is, preserving unsupported
 *   signals as omitted optional fields rather than synthetic defaults.
 * - EvidenceItems mapped to structured signal/value/weight objects.
 * - retrievalProvenance included as a compact string when present.
 *
 * @param params - queryId and ranked results from the ranking pipeline.
 * @returns A fully assembled {@link SearchResponseV2Machine} envelope.
 */
export function buildMachineResponseV2(
  params: MachineResponseBuildParamsV2,
): SearchResponseV2Machine {
  const items: ResultItemV2Machine[] = params.results.map((result) => {
    // Map EvidenceItem[] → structured { signal, value, weight } objects.
    // `type` is the signal name; `contribution` (e.g. "+0.42") is parsed to
    // a numeric value; `strength` is encoded as a weight: high=1, medium=0.5, low=0.1.
    const evidenceItems = result.evidenceItems.map((ei) => {
      const parsed = Number(ei.contribution);
      return {
        signal: ei.type,
        value: Number.isFinite(parsed) ? parsed : 0,
        weight:
          ei.strength === 'high' ? EVIDENCE_WEIGHT_HIGH
          : ei.strength === 'medium' ? EVIDENCE_WEIGHT_MEDIUM
          : EVIDENCE_WEIGHT_LOW,
      };
    });

    // Build the result item with conditional spread for retrievalProvenance
    const item: ResultItemV2Machine = {
      entityId: String(result.entityId),
      canonicalLabel: result.canonicalLabel,
      rank: result.rank,
      finalScore: result.finalScore,
      componentScores: {
        entityIntegrity: result.componentScores.entityIntegrity,
        ...(result.componentScores.anchorSimilarity !== undefined
          ? { anchorSimilarity: result.componentScores.anchorSimilarity }
          : {}),
        ...(result.componentScores.semantic !== undefined
          ? { semantic: result.componentScores.semantic }
          : {}),
        hardConstraintPass: result.componentScores.hardConstraintPass,
        softConstraint: result.componentScores.softConstraint,
        ...(result.componentScores.attributeAlignment !== undefined
          ? { attributeAlignment: result.componentScores.attributeAlignment }
          : {}),
        ...(result.componentScores.preferenceAlignment !== undefined
          ? { preferenceAlignment: result.componentScores.preferenceAlignment }
          : {}),
        ...(result.componentScores.popularity !== undefined
          ? { popularity: result.componentScores.popularity }
          : {}),
        ...(result.componentScores.availability !== undefined
          ? { availability: result.componentScores.availability }
          : {}),
        uncertaintyPenalty: result.componentScores.uncertaintyPenalty,
      },
      evidenceItems,
      ...(result.retrievalProvenance !== undefined
        ? { retrievalProvenance: serializeProvenance(result.retrievalProvenance) }
        : {}),
      version: '2',
      responseType: 'machine',
    };

    return item;
  });

  return {
    queryId: params.queryId,
    results: items,
    version: '2',
    responseType: 'machine',
  };
}

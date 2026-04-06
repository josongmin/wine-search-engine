/**
 * T6.2: Human Response Builder V2
 *
 * Builds a {@link SearchResponseV2Human} from ranked results.
 * This builder is strictly for human-oriented responses:
 * - Summarises evidence as readable text (no raw signal JSON)
 * - Normalises per-result confidence via min-max on finalScore
 * - Maps wine attributes to flat, UX-friendly fields
 *
 * It does NOT reuse or delegate to the V1 ResponseBuilder, and it
 * does NOT generate any machine/tool envelope fields.
 */

import type { RankedResult } from '../../ranking/model/ranked-result.js';
import type {
  ResultItemV2Human,
  SearchResponseV2HumanSearch,
} from '../model/result-item-v2.js';

// ---------------------------------------------------------------------------
// Public parameter type
// ---------------------------------------------------------------------------

export interface HumanResponseBuildParamsV2 {
  readonly queryId: string;
  readonly results: readonly RankedResult[];
  readonly totalCandidates: number;
}

// ---------------------------------------------------------------------------
// Evidence synthesis helpers
// ---------------------------------------------------------------------------

/**
 * Synthesise a human-readable evidence summary from the top-3 evidence items
 * sorted by absolute contribution weight.
 *
 * Output example: "Matched region (Burgundy), grape (Pinot Noir), vintage (2018)"
 *
 * Rules:
 * - Take at most 3 items, ordered by descending |contribution|.
 * - Format each item using the evidence `type` and a value extracted from
 *   `metadata` when available, falling back to the `provenance` string.
 * - Return a joined sentence — never raw JSON.
 */
function synthesiseEvidenceSummary(result: RankedResult): string {
  const items = [...result.evidenceItems]
    .sort((a, b) => {
      const wa = Math.abs(parseFloat(a.contribution));
      const wb = Math.abs(parseFloat(b.contribution));
      return wb - wa;
    })
    .slice(0, 3);

  if (items.length === 0) {
    return 'No specific match signals available';
  }

  const parts = items.map((item) => {
    // Attempt to extract a display value from metadata first
    const metaValue =
      item.metadata !== undefined && 'value' in item.metadata
        ? String(item.metadata['value'])
        : undefined;

    // Convert snake_case type to readable label
    const label = item.type
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());

    return metaValue !== undefined
      ? `${label} (${metaValue})`
      : `${label}: ${item.provenance}`;
  });

  return `Matched ${parts.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Confidence normalisation
// ---------------------------------------------------------------------------

/**
 * Compute per-result confidence scores via min-max normalisation over
 * `finalScore` values in the result set.
 *
 * - Single result → confidence = 1.0.
 * - Multiple results → rank-1 (highest score) = 1.0, last = 0.0.
 * - Ties are treated as equal confidence.
 */
function normaliseConfidences(results: readonly RankedResult[]): readonly number[] {
  if (results.length === 0) {
    return [];
  }

  if (results.length === 1) {
    return [1.0];
  }

  const scores = results.map((r) => r.finalScore);
  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);
  const range = maxScore - minScore;

  if (range === 0) {
    // All scores identical — every result gets equal confidence
    return results.map(() => 1.0);
  }

  return scores.map((s) => (s - minScore) / range);
}

// ---------------------------------------------------------------------------
// Main builder function
// ---------------------------------------------------------------------------

export function buildHumanResponseV2(params: HumanResponseBuildParamsV2): SearchResponseV2HumanSearch {
  const { queryId, results, totalCandidates } = params;

  const confidences = normaliseConfidences(results);

  const mappedResults: ResultItemV2Human[] = results.map((result, index) => {
    const vintage = result.vintageYear ?? result.vintage;
    const confidence = confidences[index] ?? 1.0;

    // Build drinkingWindow only if at least one bound is defined
    const hasDrinkingWindow =
      result.drinkingWindowStart !== undefined || result.drinkingWindowEnd !== undefined;

    const drinkingWindow = hasDrinkingWindow
      ? {
          ...(result.drinkingWindowStart !== undefined
            ? { start: result.drinkingWindowStart }
            : {}),
          ...(result.drinkingWindowEnd !== undefined
            ? { end: result.drinkingWindowEnd }
            : {}),
        }
      : undefined;

    const item: ResultItemV2Human = {
      entityId: result.entityId,
      canonicalLabel: result.canonicalLabel,
      rank: result.rank,
      ...(result.producer !== undefined ? { producer: result.producer } : {}),
      ...(result.region !== undefined ? { region: result.region } : {}),
      ...(vintage !== undefined ? { vintage } : {}),
      ...(result.grapePrimary !== undefined ? { grapePrimary: result.grapePrimary } : {}),
      ...(drinkingWindow !== undefined ? { drinkingWindow } : {}),
      evidenceSummary: synthesiseEvidenceSummary(result),
      confidence,
      version: '2',
      responseType: 'human',
    };

    return item;
  });

  return {
    queryId,
    queryType: 'search',
    results: mappedResults,
    totalCandidates,
    version: '2',
    responseType: 'human',
  };
}

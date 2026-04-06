import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { RetrievalDocument } from '../model/retrieval-document.js';
import {
  RETRIEVAL_HIT_SUMMARY_KEYS,
  type RetrievalHitSummary,
  type RetrievalHitSummaryKey,
} from '../port/search-index.port.js';

type HybridCandidateSummaryFields = Pick<HybridCandidate, RetrievalHitSummaryKey>;

const RERANK_SUMMARY_SEARCH_TEXT_MAX = 800;

export function trimNonEmptySummaryValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeSummarySearchText(value: string | undefined): string | undefined {
  const trimmed = trimNonEmptySummaryValue(value);
  return trimmed !== undefined && trimmed.length > RERANK_SUMMARY_SEARCH_TEXT_MAX
    ? trimmed.slice(0, RERANK_SUMMARY_SEARCH_TEXT_MAX)
    : trimmed;
}

export function normalizeRetrievalHitSummary(
  summary: Partial<RetrievalHitSummary> | undefined,
): RetrievalHitSummary | undefined {
  if (summary === undefined) return undefined;

  const normalized: Partial<RetrievalHitSummary> = {};
  const normalizedRecord = normalized as Record<RetrievalHitSummaryKey, unknown>;

  for (const key of RETRIEVAL_HIT_SUMMARY_KEYS) {
    const value = summary[key];
    if (value !== undefined) {
      normalizedRecord[key] = value;
    }
  }

  return Object.keys(normalized).length > 0
    ? (normalized as RetrievalHitSummary)
    : undefined;
}

export function mergeRetrievalHitSummaries(
  ...summaries: readonly (RetrievalHitSummary | undefined)[]
): RetrievalHitSummary | undefined {
  const merged: Partial<RetrievalHitSummary> = {};
  const mergedRecord = merged as Record<RetrievalHitSummaryKey, unknown>;

  for (const key of RETRIEVAL_HIT_SUMMARY_KEYS) {
    for (const summary of summaries) {
      const value = summary?.[key];
      if (value !== undefined) {
        mergedRecord[key] = value;
        break;
      }
    }
  }

  return normalizeRetrievalHitSummary(merged);
}

/**
 * Maps index-hit summary fields onto the HybridCandidate surface so every
 * retrieval mode propagates the same candidate metadata contract.
 */
export function summaryToHybridCandidateFields(
  summary: RetrievalHitSummary | undefined,
): HybridCandidateSummaryFields {
  return (normalizeRetrievalHitSummary(summary) ?? {}) as HybridCandidateSummaryFields;
}

export function retrievalDocumentToHitSummary(doc: RetrievalDocument): RetrievalHitSummary {
  const truncatedSearchTextEn = normalizeSummarySearchText(doc.searchTextEn);
  const grapePrimary = trimNonEmptySummaryValue(doc.grapePrimary)
    ?? doc.grapes
      .map((grape) => trimNonEmptySummaryValue(grape))
      .find((grape): grape is string => grape !== undefined);
  const producer = trimNonEmptySummaryValue(doc.producer);
  const region = trimNonEmptySummaryValue(doc.region);
  const style = trimNonEmptySummaryValue(doc.style);
  const priceBand = trimNonEmptySummaryValue(doc.priceBand);
  const wineType = trimNonEmptySummaryValue(doc.wineType);
  const country = trimNonEmptySummaryValue(doc.country);
  const appellation = trimNonEmptySummaryValue(doc.appellation);
  const classification = trimNonEmptySummaryValue(doc.classification);
  const drinkingWindowModelVersion = trimNonEmptySummaryValue(doc.drinkingWindowModelVersion);
  const soilType = trimNonEmptySummaryValue(doc.soilType);
  const producerType = trimNonEmptySummaryValue(doc.producerType);

  return normalizeRetrievalHitSummary({
    canonicalLabel: doc.canonicalLabel,
    ...(producer !== undefined ? { producer } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(truncatedSearchTextEn !== undefined ? { searchTextEn: truncatedSearchTextEn } : {}),
    ...(grapePrimary !== undefined ? { grapePrimary } : {}),
    ...(style !== undefined ? { style } : {}),
    ...(priceBand !== undefined ? { priceBand } : {}),
    ...(doc.pairing.length > 0 ? { pairing: [...doc.pairing] } : {}),
    ...(doc.occasion.length > 0 ? { occasion: [...doc.occasion] } : {}),
    ...(doc.vintageYear !== undefined ? { vintageYear: doc.vintageYear } : {}),
    body: doc.body,
    ...(doc.tannin !== undefined ? { tannin: doc.tannin } : {}),
    ...(doc.acidity !== undefined ? { acidity: doc.acidity } : {}),
    sweetness: doc.sweetness,
    ...(doc.finishLength !== undefined ? { finishLength: doc.finishLength } : {}),
    ...(wineType !== undefined ? { wineType } : {}),
    ...(doc.criticScoreNormalized !== undefined
      ? { criticScoreNormalized: doc.criticScoreNormalized }
      : {}),
    ...(doc.producerPrestige !== undefined ? { producerPrestige: doc.producerPrestige } : {}),
    ...(country !== undefined ? { country } : {}),
    ...(appellation !== undefined ? { appellation } : {}),
    ...(classification !== undefined ? { classification } : {}),
    ...(doc.alcoholPct !== undefined ? { alcoholPct: doc.alcoholPct } : {}),
    ...(doc.drinkingWindowStart !== undefined ? { drinkingWindowStart: doc.drinkingWindowStart } : {}),
    ...(doc.drinkingWindowEnd !== undefined ? { drinkingWindowEnd: doc.drinkingWindowEnd } : {}),
    ...(drinkingWindowModelVersion !== undefined ? { drinkingWindowModelVersion } : {}),
    ...(doc.priceUsd !== undefined ? { priceUsd: doc.priceUsd } : {}),
    ...(doc.certifications !== undefined ? { certifications: [...doc.certifications] } : {}),
    ...(soilType !== undefined ? { soilType } : {}),
    ...(producerType !== undefined ? { producerType } : {}),
  }) ?? { canonicalLabel: doc.canonicalLabel };
}

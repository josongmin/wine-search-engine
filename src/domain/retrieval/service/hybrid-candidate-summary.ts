import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { RetrievalDocument } from '../model/retrieval-document.js';
import {
  RETRIEVAL_HIT_SUMMARY_KEYS,
  type RetrievalHitSummary,
  type RetrievalHitSummaryKey,
} from '../port/search-index.port.js';

type HybridCandidateSummaryFields = Pick<HybridCandidate, RetrievalHitSummaryKey>;

const RERANK_SUMMARY_SEARCH_TEXT_MAX = 800;

function trimNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
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
  const searchTextEn = trimNonEmpty(doc.searchTextEn);
  const truncatedSearchTextEn =
    searchTextEn !== undefined && searchTextEn.length > RERANK_SUMMARY_SEARCH_TEXT_MAX
      ? searchTextEn.slice(0, RERANK_SUMMARY_SEARCH_TEXT_MAX)
      : searchTextEn;
  const grapePrimary = trimNonEmpty(doc.grapePrimary)
    ?? doc.grapes
      .map((grape) => trimNonEmpty(grape))
      .find((grape): grape is string => grape !== undefined);
  const producer = trimNonEmpty(doc.producer);
  const region = trimNonEmpty(doc.region);
  const style = trimNonEmpty(doc.style);
  const priceBand = trimNonEmpty(doc.priceBand);
  const wineType = trimNonEmpty(doc.wineType);
  const country = trimNonEmpty(doc.country);
  const appellation = trimNonEmpty(doc.appellation);
  const classification = trimNonEmpty(doc.classification);
  const drinkingWindowModelVersion = trimNonEmpty(doc.drinkingWindowModelVersion);
  const soilType = trimNonEmpty(doc.soilType);
  const producerType = trimNonEmpty(doc.producerType);

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

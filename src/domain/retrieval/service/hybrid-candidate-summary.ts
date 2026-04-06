import type { RetrievalHitSummary } from '../port/search-index.port.js';
import type { RetrievalDocument } from '../model/retrieval-document.js';

function trimNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Maps index-hit summary fields onto the HybridCandidate surface so every
 * retrieval mode propagates the same candidate metadata contract.
 */
export function summaryToHybridCandidateFields(
  summary: RetrievalHitSummary | undefined,
): {
  readonly canonicalLabel?: string;
  readonly producer?: string;
  readonly region?: string;
  readonly searchTextEn?: string;
  readonly grapePrimary?: string;
  readonly style?: string;
  readonly priceBand?: string;
  readonly pairing?: readonly string[];
  readonly occasion?: readonly string[];
  readonly vintageYear?: number;
  readonly body?: number;
  readonly tannin?: number;
  readonly acidity?: number;
  readonly sweetness?: number;
  readonly finishLength?: number;
  readonly wineType?: string;
  readonly criticScoreNormalized?: number;
  readonly producerPrestige?: number;
  readonly country?: string;
  readonly appellation?: string;
  readonly classification?: string;
  readonly alcoholPct?: number;
  readonly drinkingWindowStart?: number;
  readonly drinkingWindowEnd?: number;
  readonly drinkingWindowModelVersion?: string;
  readonly priceUsd?: number;
  readonly certifications?: readonly string[];
  readonly soilType?: string;
  readonly producerType?: string;
} {
  return {
    ...(summary?.canonicalLabel !== undefined ? { canonicalLabel: summary.canonicalLabel } : {}),
    ...(summary?.producer !== undefined ? { producer: summary.producer } : {}),
    ...(summary?.region !== undefined ? { region: summary.region } : {}),
    ...(summary?.searchTextEn !== undefined ? { searchTextEn: summary.searchTextEn } : {}),
    ...(summary?.grapePrimary !== undefined ? { grapePrimary: summary.grapePrimary } : {}),
    ...(summary?.style !== undefined ? { style: summary.style } : {}),
    ...(summary?.priceBand !== undefined ? { priceBand: summary.priceBand } : {}),
    ...(summary?.pairing !== undefined ? { pairing: summary.pairing } : {}),
    ...(summary?.occasion !== undefined ? { occasion: summary.occasion } : {}),
    ...(summary?.vintageYear !== undefined ? { vintageYear: summary.vintageYear } : {}),
    ...(summary?.body !== undefined ? { body: summary.body } : {}),
    ...(summary?.tannin !== undefined ? { tannin: summary.tannin } : {}),
    ...(summary?.acidity !== undefined ? { acidity: summary.acidity } : {}),
    ...(summary?.sweetness !== undefined ? { sweetness: summary.sweetness } : {}),
    ...(summary?.finishLength !== undefined ? { finishLength: summary.finishLength } : {}),
    ...(summary?.wineType !== undefined ? { wineType: summary.wineType } : {}),
    ...(summary?.criticScoreNormalized !== undefined
      ? { criticScoreNormalized: summary.criticScoreNormalized }
      : {}),
    ...(summary?.producerPrestige !== undefined ? { producerPrestige: summary.producerPrestige } : {}),
    ...(summary?.country !== undefined ? { country: summary.country } : {}),
    ...(summary?.appellation !== undefined ? { appellation: summary.appellation } : {}),
    ...(summary?.classification !== undefined ? { classification: summary.classification } : {}),
    ...(summary?.alcoholPct !== undefined ? { alcoholPct: summary.alcoholPct } : {}),
    ...(summary?.drinkingWindowStart !== undefined
      ? { drinkingWindowStart: summary.drinkingWindowStart }
      : {}),
    ...(summary?.drinkingWindowEnd !== undefined
      ? { drinkingWindowEnd: summary.drinkingWindowEnd }
      : {}),
    ...(summary?.drinkingWindowModelVersion !== undefined
      ? { drinkingWindowModelVersion: summary.drinkingWindowModelVersion }
      : {}),
    ...(summary?.priceUsd !== undefined ? { priceUsd: summary.priceUsd } : {}),
    ...(summary?.certifications !== undefined ? { certifications: summary.certifications } : {}),
    ...(summary?.soilType !== undefined ? { soilType: summary.soilType } : {}),
    ...(summary?.producerType !== undefined ? { producerType: summary.producerType } : {}),
  };
}

export function retrievalDocumentToHitSummary(doc: RetrievalDocument): RetrievalHitSummary {
  const searchTextEn = trimNonEmpty(doc.searchTextEn);
  const truncatedSearchTextEn =
    searchTextEn !== undefined && searchTextEn.length > 800
      ? searchTextEn.slice(0, 800)
      : searchTextEn;
  const grapePrimary = trimNonEmpty(doc.grapePrimary)
    ?? doc.grapes
      .map((grape) => trimNonEmpty(grape))
      .find((grape): grape is string => grape !== undefined);

  return {
    canonicalLabel: doc.canonicalLabel,
    ...(trimNonEmpty(doc.producer) !== undefined ? { producer: trimNonEmpty(doc.producer)! } : {}),
    ...(trimNonEmpty(doc.region) !== undefined ? { region: trimNonEmpty(doc.region)! } : {}),
    ...(truncatedSearchTextEn !== undefined ? { searchTextEn: truncatedSearchTextEn } : {}),
    ...(grapePrimary !== undefined ? { grapePrimary } : {}),
    ...(trimNonEmpty(doc.style) !== undefined ? { style: trimNonEmpty(doc.style)! } : {}),
    ...(trimNonEmpty(doc.priceBand) !== undefined ? { priceBand: trimNonEmpty(doc.priceBand)! } : {}),
    ...(doc.pairing.length > 0 ? { pairing: [...doc.pairing] } : {}),
    ...(doc.occasion.length > 0 ? { occasion: [...doc.occasion] } : {}),
    ...(doc.vintageYear !== undefined ? { vintageYear: doc.vintageYear } : {}),
    body: doc.body,
    ...(doc.tannin !== undefined ? { tannin: doc.tannin } : {}),
    ...(doc.acidity !== undefined ? { acidity: doc.acidity } : {}),
    sweetness: doc.sweetness,
    ...(doc.finishLength !== undefined ? { finishLength: doc.finishLength } : {}),
    ...(trimNonEmpty(doc.wineType) !== undefined ? { wineType: trimNonEmpty(doc.wineType)! } : {}),
    ...(doc.criticScoreNormalized !== undefined
      ? { criticScoreNormalized: doc.criticScoreNormalized }
      : {}),
    ...(doc.producerPrestige !== undefined ? { producerPrestige: doc.producerPrestige } : {}),
    ...(trimNonEmpty(doc.country) !== undefined ? { country: trimNonEmpty(doc.country)! } : {}),
    ...(trimNonEmpty(doc.appellation) !== undefined ? { appellation: trimNonEmpty(doc.appellation)! } : {}),
    ...(trimNonEmpty(doc.classification) !== undefined
      ? { classification: trimNonEmpty(doc.classification)! }
      : {}),
    ...(doc.alcoholPct !== undefined ? { alcoholPct: doc.alcoholPct } : {}),
    ...(doc.drinkingWindowStart !== undefined ? { drinkingWindowStart: doc.drinkingWindowStart } : {}),
    ...(doc.drinkingWindowEnd !== undefined ? { drinkingWindowEnd: doc.drinkingWindowEnd } : {}),
    ...(trimNonEmpty(doc.drinkingWindowModelVersion) !== undefined
      ? { drinkingWindowModelVersion: trimNonEmpty(doc.drinkingWindowModelVersion)! }
      : {}),
    ...(doc.priceUsd !== undefined ? { priceUsd: doc.priceUsd } : {}),
    ...(doc.certifications !== undefined ? { certifications: [...doc.certifications] } : {}),
    ...(trimNonEmpty(doc.soilType) !== undefined ? { soilType: trimNonEmpty(doc.soilType)! } : {}),
    ...(trimNonEmpty(doc.producerType) !== undefined ? { producerType: trimNonEmpty(doc.producerType)! } : {}),
  };
}

import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { RetrievalDocument } from '../model/retrieval-document.js';
import {
  SourceRecordRefListSchema,
  type SourceRecordRef,
} from '../../entity/model/source-record-ref.js';
import {
  RETRIEVAL_HIT_SUMMARY_KEYS,
  type RetrievalHitSummary,
  type RetrievalHitSummaryKey,
  type RetrievalSummaryCarrier,
} from '../port/search-index.port.js';
import type { CanonicalEntityId } from '../../shared/types/index.js';

type HybridCandidateSummaryFields = Pick<
  HybridCandidate,
  RetrievalHitSummaryKey | 'sourceRecordRefs'
>;

/**
 * Runtime-safe set of keys allowed in HybridCandidateSummaryFields.
 * Used by {@link toSafeHybridCandidateSummaryFields} to strip unknown keys
 * and validate value types, replacing the previous unsafe `as` cast.
 */
const SUMMARY_KEY_SET: ReadonlySet<string> = new Set([
  ...RETRIEVAL_HIT_SUMMARY_KEYS,
  'sourceRecordRefs',
]);

/**
 * Safely project a normalized summary into HybridCandidateSummaryFields
 * by copying only known keys with valid value types (string, number,
 * readonly string[]). Unknown keys and non-matching value types are dropped.
 */
function toSafeHybridCandidateSummaryFields(
  summary: RetrievalHitSummary | undefined,
): HybridCandidateSummaryFields {
  const normalized = normalizeRetrievalHitSummary(summary);
  if (normalized === undefined) return {} as HybridCandidateSummaryFields;

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(normalized)) {
    if (!SUMMARY_KEY_SET.has(key)) continue;
    const value = (normalized as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === 'sourceRecordRefs') {
      const parsed = SourceRecordRefListSchema.safeParse(value);
      if (parsed.success && parsed.data.length > 0) {
        result[key] = parsed.data;
      }
      continue;
    }
    // Accept string, number, and string[] — the three value families in RetrievalHitSummaryKey
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      (Array.isArray(value) && value.every((v) => typeof v === 'string'))
    ) {
      result[key] = value;
    }
  }
  return result as HybridCandidateSummaryFields;
}
type NormalizableRetrievalHitSummary = {
  [Key in RetrievalHitSummaryKey]?: RetrievalHitSummary[Key] | undefined;
} & {
  readonly sourceRecordRefs?: readonly SourceRecordRef[] | undefined;
};

const RERANK_SUMMARY_SEARCH_TEXT_MAX = 800;

function trimNonEmptySummaryValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeSummarySearchText(value: string | undefined): string | undefined {
  const trimmed = trimNonEmptySummaryValue(value);
  return trimmed !== undefined && trimmed.length > RERANK_SUMMARY_SEARCH_TEXT_MAX
    ? trimmed.slice(0, RERANK_SUMMARY_SEARCH_TEXT_MAX)
    : trimmed;
}

function normalizeSummaryStringList(
  value: readonly string[] | undefined,
  options: { readonly allowEmpty: boolean },
): readonly string[] | undefined {
  if (value === undefined) return undefined;

  const normalized = value
    .map((entry) => (typeof entry === 'string' ? trimNonEmptySummaryValue(entry) : undefined))
    .filter((entry): entry is string => entry !== undefined);
  if (!options.allowEmpty && normalized.length === 0) return undefined;
  return normalized;
}

function normalizeRetrievalHitSummaryValue(
  key: RetrievalHitSummaryKey,
  value: RetrievalHitSummary[RetrievalHitSummaryKey] | undefined,
): RetrievalHitSummary[RetrievalHitSummaryKey] | undefined {
  switch (key) {
    case 'canonicalLabel':
    case 'producer':
    case 'region':
    case 'grapePrimary':
    case 'style':
    case 'priceBand':
    case 'wineType':
    case 'country':
    case 'appellation':
    case 'classification':
    case 'drinkingWindowModelVersion':
    case 'soilType':
    case 'producerType':
      return trimNonEmptySummaryValue(
        typeof value === 'string' ? value : undefined,
      ) as RetrievalHitSummary[RetrievalHitSummaryKey] | undefined;
    case 'searchTextEn':
    case 'searchTextKo':
    case 'semanticSummary':
      return normalizeSummarySearchText(
        typeof value === 'string' ? value : undefined,
      ) as RetrievalHitSummary[RetrievalHitSummaryKey] | undefined;
    case 'pairing':
    case 'occasion':
      return normalizeSummaryStringList(
        Array.isArray(value) ? value : undefined,
        { allowEmpty: false },
      ) as RetrievalHitSummary[RetrievalHitSummaryKey] | undefined;
    case 'certifications':
      return normalizeSummaryStringList(
        Array.isArray(value) ? value : undefined,
        { allowEmpty: true },
      ) as RetrievalHitSummary[RetrievalHitSummaryKey] | undefined;
    case 'grapeFamily':
      // String field like other name strings — trim whitespace, reject empty.
      return trimNonEmptySummaryValue(
        typeof value === 'string' ? value : undefined,
      ) as RetrievalHitSummary[RetrievalHitSummaryKey] | undefined;
    case 'flavorProfiles':
    case 'regionHierarchy':
      // String array fields — normalize like pairing/occasion (reject empty entries).
      return normalizeSummaryStringList(
        Array.isArray(value) ? value : undefined,
        { allowEmpty: false },
      ) as RetrievalHitSummary[RetrievalHitSummaryKey] | undefined;
    default:
      return value;
  }
}

export function normalizeRetrievalHitSummary(
  summary: NormalizableRetrievalHitSummary | undefined,
): RetrievalHitSummary | undefined {
  if (summary === undefined) return undefined;

  const normalized: Partial<RetrievalHitSummary> = {};
  const normalizedRecord = normalized as Record<RetrievalHitSummaryKey, unknown>;

  for (const key of RETRIEVAL_HIT_SUMMARY_KEYS) {
    const value = normalizeRetrievalHitSummaryValue(key, summary[key]);
    if (value !== undefined) {
      normalizedRecord[key] = value;
    }
  }

  if (summary.sourceRecordRefs !== undefined) {
    const parsed = SourceRecordRefListSchema.safeParse(summary.sourceRecordRefs);
    if (parsed.success && parsed.data.length > 0) {
      (normalized as Record<string, unknown>).sourceRecordRefs = parsed.data;
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

  for (const summary of summaries) {
    const refs = summary?.sourceRecordRefs;
    if (refs !== undefined && refs.length > 0) {
      (merged as Record<string, unknown>).sourceRecordRefs = refs;
      break;
    }
  }

  return normalizeRetrievalHitSummary(merged);
}

export function findRetrievalHitSummaryForEntity(
  hits: readonly RetrievalSummaryCarrier[],
  entityId: CanonicalEntityId,
): RetrievalHitSummary | undefined {
  for (const hit of hits) {
    if (hit.entityId === entityId) return normalizeRetrievalHitSummary(hit.summary);
  }
  return undefined;
}

export function mergeRetrievalHitSummariesForEntity(
  entityId: CanonicalEntityId,
  ...hitLists: readonly (readonly RetrievalSummaryCarrier[])[]
): RetrievalHitSummary | undefined {
  return mergeRetrievalHitSummaries(
    ...hitLists.map((hits) => findRetrievalHitSummaryForEntity(hits, entityId)),
  );
}

/**
 * Maps index-hit summary fields onto the HybridCandidate surface so every
 * retrieval mode propagates the same candidate metadata contract.
 */
export function summaryToHybridCandidateFields(
  summary: RetrievalHitSummary | undefined,
): HybridCandidateSummaryFields {
  return toSafeHybridCandidateSummaryFields(summary);
}

export function retrievalDocumentToHitSummary(doc: RetrievalDocument): RetrievalHitSummary {
  const grapePrimary = trimNonEmptySummaryValue(doc.grapePrimary)
    ?? doc.grapes
      .map((grape) => trimNonEmptySummaryValue(grape))
      .find((grape): grape is string => grape !== undefined);

  return normalizeRetrievalHitSummary({
    canonicalLabel: doc.canonicalLabel,
    producer: doc.producer,
    region: doc.region,
    searchTextEn: doc.searchTextEn,
    searchTextKo: doc.searchTextKo,
    grapePrimary,
    style: doc.style,
    priceBand: doc.priceBand,
    pairing: doc.pairing,
    occasion: doc.occasion,
    vintageYear: doc.vintageYear,
    body: doc.body,
    tannin: doc.tannin,
    acidity: doc.acidity,
    sweetness: doc.sweetness,
    finishLength: doc.finishLength,
    wineType: doc.wineType,
    criticScoreNormalized: doc.criticScoreNormalized,
    producerPrestige: doc.producerPrestige,
    country: doc.country,
    appellation: doc.appellation,
    classification: doc.classification,
    alcoholPct: doc.alcoholPct,
    drinkingWindowStart: doc.drinkingWindowStart,
    drinkingWindowEnd: doc.drinkingWindowEnd,
    drinkingWindowModelVersion: doc.drinkingWindowModelVersion,
    priceUsd: doc.priceUsd,
    certifications: doc.certifications,
    flavorProfiles: doc.flavorProfiles,
    soilType: doc.soilType,
    producerType: doc.producerType,
    grapeFamily: doc.grapeFamily,
    ...(doc.sourceRecordRefs !== undefined && doc.sourceRecordRefs.length > 0
      ? { sourceRecordRefs: [...doc.sourceRecordRefs] }
      : {}),
  }) ?? { canonicalLabel: doc.canonicalLabel };
}

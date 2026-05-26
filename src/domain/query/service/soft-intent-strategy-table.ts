import {
  expandSemanticStyleRetrievalTerms,
  resolveSemanticStyleEvidenceProfile,
} from './semantic-style-query-terms.js';
import type { WineTypeValue } from '../model/wine-type-patterns.js';

export type SoftIntentAttribute =
  | 'style'
  | 'occasion'
  | 'price_band'
  | 'gift_suitability'
  | 'beginner_suitability'
  | 'drinking_window';

export type SoftIntentPrimaryStrategy =
  | 'hard_filter'
  | 'retrieval_expansion'
  | 'candidate_shaping'
  | 'ranking_only';

export interface SoftIntentStrategy {
  readonly attribute: SoftIntentAttribute;
  readonly primaryStrategy: SoftIntentPrimaryStrategy;
  readonly semanticExpansion: boolean;
  readonly candidateShaping: boolean;
  readonly typedRecommendationDiscovery: boolean;
  readonly retrievalUnsupportedReason?: string | undefined;
}

export const SOFT_INTENT_STRATEGY_VERSION = '2026-05-26-soft-intent-strategy-v1' as const;

const PRICE_BAND_NORMALIZATION: Readonly<Record<string, string>> = {
  budget: 'value',
  affordable: 'value',
  cheap: 'value',
  value: 'value',
  mid: 'mid',
  'mid-range': 'mid',
  premium: 'premium',
  'high-end': 'premium',
  luxury: 'luxury',
  fine: 'luxury',
};

const SOFT_INTENT_STRATEGY_TABLE = {
  style: {
    attribute: 'style',
    primaryStrategy: 'retrieval_expansion',
    semanticExpansion: true,
    candidateShaping: true,
    typedRecommendationDiscovery: true,
  },
  occasion: {
    attribute: 'occasion',
    primaryStrategy: 'retrieval_expansion',
    semanticExpansion: true,
    candidateShaping: true,
    typedRecommendationDiscovery: true,
  },
  price_band: {
    attribute: 'price_band',
    primaryStrategy: 'candidate_shaping',
    semanticExpansion: false,
    candidateShaping: true,
    typedRecommendationDiscovery: true,
  },
  gift_suitability: {
    attribute: 'gift_suitability',
    primaryStrategy: 'candidate_shaping',
    semanticExpansion: true,
    candidateShaping: true,
    typedRecommendationDiscovery: true,
  },
  beginner_suitability: {
    attribute: 'beginner_suitability',
    primaryStrategy: 'candidate_shaping',
    semanticExpansion: true,
    candidateShaping: true,
    typedRecommendationDiscovery: true,
  },
  drinking_window: {
    attribute: 'drinking_window',
    primaryStrategy: 'ranking_only',
    semanticExpansion: false,
    candidateShaping: false,
    typedRecommendationDiscovery: false,
    retrievalUnsupportedReason: 'post_search_verification_only',
  },
} as const satisfies Record<SoftIntentAttribute, SoftIntentStrategy>;

function isSoftIntentAttribute(attribute: string): attribute is SoftIntentAttribute {
  return attribute in SOFT_INTENT_STRATEGY_TABLE;
}

export function resolveSoftIntentStrategy(attribute: string): SoftIntentStrategy | undefined {
  return isSoftIntentAttribute(attribute) ? SOFT_INTENT_STRATEGY_TABLE[attribute] : undefined;
}

function normalizeStringValues(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? [normalized] : [];
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

function firstFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const min = record['min'];
    if (typeof min === 'number' && Number.isFinite(min)) {
      return min;
    }
    const max = record['max'];
    if (typeof max === 'number' && Number.isFinite(max)) {
      return max;
    }
  }
  return undefined;
}

function normalizePriceBandValues(value: unknown): readonly string[] {
  return normalizeStringValues(value).map((entry) => PRICE_BAND_NORMALIZATION[entry] ?? entry);
}

function phrasesForPriceBand(value: unknown): readonly string[] {
  return [...new Set(
    normalizePriceBandValues(value).flatMap((band) => {
      switch (band) {
        case 'value':
          return ['value wine', 'affordable wine', 'budget friendly wine'];
        case 'mid':
          return ['mid priced wine', 'good value wine'];
        case 'premium':
          return ['premium wine', 'refined wine'];
        case 'luxury':
          return ['luxury wine', 'collector wine'];
        default:
          return [band];
      }
    }),
  )];
}

function phrasesForSuitability(attribute: 'gift_suitability' | 'beginner_suitability', value: unknown): readonly string[] {
  const score = firstFiniteNumber(value);
  const isHighConfidence = score !== undefined && score >= 0.65;
  if (attribute === 'gift_suitability') {
    return isHighConfidence
      ? ['gift wine', 'giftable wine', 'presentable bottle']
      : ['gift wine'];
  }
  return isHighConfidence
    ? ['beginner friendly wine', 'easy drinking wine', 'approachable wine']
    : ['beginner friendly wine'];
}

export function softIntentRetrievalPhrases(
  attribute: string,
  value: unknown,
  wineTypeContext?: WineTypeValue,
): readonly string[] | undefined {
  switch (attribute) {
    case 'style':
      if (typeof value === 'string') {
        return expandSemanticStyleRetrievalTerms({ style: value, wineType: wineTypeContext });
      }
      if (Array.isArray(value)) {
        return expandSemanticStyleRetrievalTerms({
          styles: value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0),
          wineType: wineTypeContext,
        });
      }
      return [];
    case 'occasion':
      return normalizeStringValues(value).map((entry) => entry.replaceAll('_', ' '));
    case 'price_band':
      return phrasesForPriceBand(value);
    case 'gift_suitability':
    case 'beginner_suitability':
      return phrasesForSuitability(attribute, value);
    case 'drinking_window':
      return [];
    default:
      return undefined;
  }
}

export function isSemanticSoftIntentAttribute(attribute: string): boolean {
  return resolveSoftIntentStrategy(attribute)?.semanticExpansion ?? false;
}

export function isSoftIntentCandidateShapingAttribute(attribute: string): boolean {
  return resolveSoftIntentStrategy(attribute)?.candidateShaping ?? false;
}

export function shouldRunTypedRecommendationDiscoveryForSoftIntent(
  attribute: string,
  value: unknown,
): boolean {
  const strategy = resolveSoftIntentStrategy(attribute);
  if (strategy === undefined || !strategy.typedRecommendationDiscovery) {
    return false;
  }
  if (attribute === 'style') {
    return normalizeStringValues(value)
      .some((candidate) => resolveSemanticStyleEvidenceProfile(candidate) !== undefined);
  }
  if (attribute === 'drinking_window') {
    return false;
  }
  if (attribute === 'gift_suitability' || attribute === 'beginner_suitability') {
    const score = firstFiniteNumber(value);
    return score !== undefined && score > 0;
  }
  return normalizeStringValues(value).length > 0;
}

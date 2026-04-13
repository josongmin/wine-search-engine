import type { SourceRecordRef } from '../../entity/model/source-record-ref.js';
import type { CandidateProvenance } from '../../retrieval/model/candidate-envelope.js';
import type { HybridCandidate } from '../../retrieval/model/hybrid-candidate.js';
import type { RankedResult } from '../model/ranked-result.js';
import type { WineAttributeEncoderPort } from '../port/wine-attribute-encoder.port.js';
import { clamp01 } from '../../shared/utils/clamp.js';

const CRITIC_PROXY_SCORE_DISPLAY_BASE = 80;
const CRITIC_PROXY_SCORE_DISPLAY_SPAN = 20;

export type RankedResultAttributeProjection = Pick<
  RankedResult,
  | 'producer'
  | 'region'
  | 'grapePrimary'
  | 'appellation'
  | 'producerPrestige'
  | 'retrievalProvenance'
  | 'sparseRank'
  | 'drinkingWindowStart'
  | 'drinkingWindowEnd'
  | 'drinkingWindowModelVersion'
  | 'vintageYear'
  | 'body'
  | 'tannin'
  | 'acidity'
  | 'sweetness'
  | 'avgCriticProxyScore'
  | 'criticScoreNormalized'
  | 'grapePrimaryEnc'
  | 'regionEnc'
  | 'countryEnc'
  | 'style'
  | 'classification'
  | 'alcoholPct'
  | 'certifications'
  | 'pairingTags'
  | 'occasion'
  | 'priceBand'
  | 'priceUsd'
  | 'sourceRecordRefs'
>;

export interface RankedResultAttributeSource {
  readonly producer?: string | undefined;
  readonly region?: string | undefined;
  readonly grapePrimary?: string | undefined;
  readonly appellation?: string | undefined;
  readonly producerPrestige?: number | undefined;
  readonly retrievalProvenance?: CandidateProvenance | undefined;
  readonly sparseRank?: number | undefined;
  readonly drinkingWindowStart?: number | undefined;
  readonly drinkingWindowEnd?: number | undefined;
  readonly drinkingWindowModelVersion?: string | undefined;
  readonly vintageYear?: number | undefined;
  readonly body?: number | undefined;
  readonly tannin?: number | undefined;
  readonly acidity?: number | undefined;
  readonly sweetness?: number | undefined;
  readonly criticScoreNormalized?: number | undefined;
  readonly grapePrimaryEnc?: number | undefined;
  readonly regionEnc?: number | undefined;
  readonly countryEnc?: number | undefined;
  readonly style?: string | undefined;
  readonly classification?: string | undefined;
  readonly alcoholPct?: number | undefined;
  readonly certifications?: readonly string[] | undefined;
  readonly pairingTags?: readonly string[] | undefined;
  readonly occasion?: readonly string[] | undefined;
  readonly priceBand?: string | undefined;
  readonly priceUsd?: number | undefined;
  readonly sourceRecordRefs?: readonly SourceRecordRef[] | undefined;
}

function buildAvgCriticProxyScore(
  criticScoreNormalized: number | undefined,
): number | undefined {
  if (criticScoreNormalized === undefined) {
    return undefined;
  }
  return Math.round(
    CRITIC_PROXY_SCORE_DISPLAY_BASE +
      clamp01(criticScoreNormalized) * CRITIC_PROXY_SCORE_DISPLAY_SPAN,
  );
}

function buildRankedResultProjection(
  source: RankedResultAttributeSource,
): RankedResultAttributeProjection {
  const avgCriticProxyScore = buildAvgCriticProxyScore(source.criticScoreNormalized);

  return {
    ...(source.producer !== undefined ? { producer: source.producer } : {}),
    ...(source.region !== undefined ? { region: source.region } : {}),
    ...(source.grapePrimary !== undefined ? { grapePrimary: source.grapePrimary } : {}),
    ...(source.appellation !== undefined ? { appellation: source.appellation } : {}),
    ...(source.producerPrestige !== undefined
      ? { producerPrestige: source.producerPrestige }
      : {}),
    ...(source.retrievalProvenance !== undefined
      ? { retrievalProvenance: source.retrievalProvenance }
      : {}),
    ...(source.sparseRank !== undefined ? { sparseRank: source.sparseRank } : {}),
    ...(source.drinkingWindowStart !== undefined
      ? { drinkingWindowStart: source.drinkingWindowStart }
      : {}),
    ...(source.drinkingWindowEnd !== undefined
      ? { drinkingWindowEnd: source.drinkingWindowEnd }
      : {}),
    ...(source.drinkingWindowModelVersion !== undefined
      ? { drinkingWindowModelVersion: source.drinkingWindowModelVersion }
      : {}),
    ...(source.vintageYear !== undefined ? { vintageYear: source.vintageYear } : {}),
    ...(source.body !== undefined ? { body: source.body } : {}),
    ...(source.tannin !== undefined ? { tannin: source.tannin } : {}),
    ...(source.acidity !== undefined ? { acidity: source.acidity } : {}),
    ...(source.sweetness !== undefined ? { sweetness: source.sweetness } : {}),
    ...(avgCriticProxyScore !== undefined ? { avgCriticProxyScore } : {}),
    ...(source.criticScoreNormalized !== undefined
      ? { criticScoreNormalized: source.criticScoreNormalized }
      : {}),
    ...(source.grapePrimaryEnc !== undefined
      ? { grapePrimaryEnc: source.grapePrimaryEnc }
      : {}),
    ...(source.regionEnc !== undefined ? { regionEnc: source.regionEnc } : {}),
    ...(source.countryEnc !== undefined ? { countryEnc: source.countryEnc } : {}),
    ...(source.style !== undefined ? { style: source.style } : {}),
    ...(source.classification !== undefined
      ? { classification: source.classification }
      : {}),
    ...(source.alcoholPct !== undefined ? { alcoholPct: source.alcoholPct } : {}),
    ...(source.certifications !== undefined
      ? { certifications: source.certifications }
      : {}),
    ...(source.pairingTags !== undefined ? { pairingTags: source.pairingTags } : {}),
    ...(source.occasion !== undefined ? { occasion: source.occasion } : {}),
    ...(source.priceBand !== undefined ? { priceBand: source.priceBand } : {}),
    ...(source.priceUsd !== undefined ? { priceUsd: source.priceUsd } : {}),
    ...(source.sourceRecordRefs !== undefined && source.sourceRecordRefs.length > 0
      ? { sourceRecordRefs: source.sourceRecordRefs }
      : {}),
  };
}

export function projectHybridCandidateToRankedResultAttributes(
  candidate: HybridCandidate,
  attributeEncoder: WineAttributeEncoderPort,
): RankedResultAttributeProjection {
  return buildRankedResultProjection({
    producer: candidate.producer,
    region: candidate.region,
    grapePrimary: candidate.grapePrimary,
    appellation: candidate.appellation,
    producerPrestige: candidate.producerPrestige,
    retrievalProvenance: candidate.retrievalProvenance,
    sparseRank: candidate.sparseRank,
    drinkingWindowStart: candidate.drinkingWindowStart,
    drinkingWindowEnd: candidate.drinkingWindowEnd,
    drinkingWindowModelVersion: candidate.drinkingWindowModelVersion,
    vintageYear: candidate.vintageYear,
    body: candidate.body,
    tannin: candidate.tannin,
    acidity: candidate.acidity,
    sweetness: candidate.sweetness,
    criticScoreNormalized: candidate.criticScoreNormalized,
    ...(candidate.grapePrimary !== undefined
      ? { grapePrimaryEnc: attributeEncoder.encodeGrape(candidate.grapePrimary) }
      : {}),
    ...(candidate.region !== undefined
      ? { regionEnc: attributeEncoder.encodeRegion(candidate.region) }
      : {}),
    ...(candidate.country !== undefined
      ? { countryEnc: attributeEncoder.encodeCountry(candidate.country) }
      : {}),
    style: candidate.style,
    classification: candidate.classification,
    alcoholPct: candidate.alcoholPct,
    certifications: candidate.certifications,
    pairingTags: candidate.pairing,
    occasion: candidate.occasion,
    priceBand: candidate.priceBand,
    priceUsd: candidate.priceUsd,
    sourceRecordRefs: candidate.sourceRecordRefs,
  });
}

export function projectRankedResultSourceAttributes(
  source: RankedResultAttributeSource,
): RankedResultAttributeProjection {
  return buildRankedResultProjection(source);
}

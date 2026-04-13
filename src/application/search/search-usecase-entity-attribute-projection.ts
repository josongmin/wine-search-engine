import type { RetrievalDocument } from '../../domain/retrieval/model/retrieval-document.js';
import type { HybridCandidate } from '../../domain/retrieval/model/hybrid-candidate.js';

type HintValue = string | number | readonly string[];

interface HintProjector {
  readonly hintKey: string;
  readonly fromDocument: (doc: RetrievalDocument) => HintValue | undefined;
  readonly applyToSyntheticCandidate: (
    candidate: Record<string, unknown>,
    value: unknown,
  ) => void;
}

function stringHint(
  hintKey: string,
  fromDocument: (doc: RetrievalDocument) => string | undefined,
  candidateField: string,
): HintProjector {
  return {
    hintKey,
    fromDocument: (doc) => {
      const value = fromDocument(doc);
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    },
    applyToSyntheticCandidate: (candidate, value) => {
      if (typeof value === 'string' && value.length > 0) {
        candidate[candidateField] = value;
      }
    },
  };
}

function numberHint(
  hintKey: string,
  fromDocument: (doc: RetrievalDocument) => number | undefined,
  candidateField: string,
): HintProjector {
  return {
    hintKey,
    fromDocument: (doc) => {
      const value = fromDocument(doc);
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    },
    applyToSyntheticCandidate: (candidate, value) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        candidate[candidateField] = value;
      }
    },
  };
}

function stringArrayHint(
  hintKey: string,
  fromDocument: (doc: RetrievalDocument) => readonly string[] | undefined,
  candidateField: string,
): HintProjector {
  return {
    hintKey,
    fromDocument: (doc) => {
      const value = fromDocument(doc);
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string') && value.length > 0
        ? value
        : undefined;
    },
    applyToSyntheticCandidate: (candidate, value) => {
      if (Array.isArray(value) && value.every((entry) => typeof entry === 'string') && value.length > 0) {
        candidate[candidateField] = value;
      }
    },
  };
}

const ENTITY_ATTRIBUTE_HINT_PROJECTORS: readonly HintProjector[] = [
  stringHint('producer', (doc) => doc.producer, 'producer'),
  stringHint('region', (doc) => doc.region, 'region'),
  stringHint('appellation', (doc) => doc.appellation, 'appellation'),
  stringHint('country', (doc) => doc.country, 'country'),
  stringHint('grape_primary', (doc) => doc.grapePrimary, 'grapePrimary'),
  stringArrayHint('grapes', (doc) => doc.grapes, 'grapes'),
  stringHint('style', (doc) => doc.style, 'style'),
  stringHint('price_band', (doc) => doc.priceBand, 'priceBand'),
  stringArrayHint('pairing', (doc) => doc.pairing, 'pairing'),
  stringArrayHint('occasion', (doc) => doc.occasion, 'occasion'),
  numberHint('vintage', (doc) => doc.vintageYear, 'vintageYear'),
  numberHint('vintage_year', (doc) => doc.vintageYear, 'vintageYear'),
  numberHint('body', (doc) => doc.body, 'body'),
  numberHint('tannin', (doc) => doc.tannin, 'tannin'),
  numberHint('acidity', (doc) => doc.acidity, 'acidity'),
  numberHint('sweetness', (doc) => doc.sweetness, 'sweetness'),
  numberHint('finish_length', (doc) => doc.finishLength, 'finishLength'),
  stringHint('wine_type', (doc) => doc.wineType, 'wineType'),
  stringHint('classification', (doc) => doc.classification, 'classification'),
  numberHint('alcohol_pct', (doc) => doc.alcoholPct, 'alcoholPct'),
  numberHint('price_usd', (doc) => doc.priceUsd, 'priceUsd'),
  numberHint('producer_prestige', (doc) => doc.producerPrestige, 'producerPrestige'),
  numberHint('critic_score_normalized', (doc) => doc.criticScoreNormalized, 'criticScoreNormalized'),
  stringArrayHint('certifications', (doc) => doc.certifications, 'certifications'),
  stringHint('soil_type', (doc) => doc.soilType, 'soilType'),
  stringHint('producer_type', (doc) => doc.producerType, 'producerType'),
  stringHint('grape_family', (doc) => doc.grapeFamily, 'grapeFamily'),
  stringArrayHint('flavor_profiles', (doc) => doc.flavorProfiles, 'flavorProfiles'),
  numberHint('drinking_window_start', (doc) => doc.drinkingWindowStart, 'drinkingWindowStart'),
  numberHint('drinking_window_end', (doc) => doc.drinkingWindowEnd, 'drinkingWindowEnd'),
  stringHint(
    'drinking_window_model_version',
    (doc) => doc.drinkingWindowModelVersion,
    'drinkingWindowModelVersion',
  ),
];

export const ENTITY_ATTRIBUTE_HINT_KEYS = ENTITY_ATTRIBUTE_HINT_PROJECTORS.map(
  (projector) => projector.hintKey,
);

export function buildResolverCandidateAttributeHints(
  doc: RetrievalDocument,
): Readonly<Record<string, unknown>> | undefined {
  const hints: Record<string, unknown> = {};

  for (const projector of ENTITY_ATTRIBUTE_HINT_PROJECTORS) {
    const value = projector.fromDocument(doc);
    if (value !== undefined) {
      hints[projector.hintKey] = value;
    }
  }

  return Object.keys(hints).length > 0 ? hints : undefined;
}

export function applyAttributeHintsToSyntheticHybridCandidate(
  candidate: HybridCandidate,
  hints: Readonly<Record<string, unknown>> | undefined,
): HybridCandidate {
  if (hints === undefined) {
    return candidate;
  }

  const projected: Record<string, unknown> = { ...candidate };
  for (const projector of ENTITY_ATTRIBUTE_HINT_PROJECTORS) {
    const value = hints[projector.hintKey];
    if (value !== undefined && value !== null) {
      projector.applyToSyntheticCandidate(projected, value);
    }
  }

  return projected as unknown as HybridCandidate;
}

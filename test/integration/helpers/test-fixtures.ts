/**
 * Realistic wine entity fixtures for integration tests.
 *
 * Provides 10 wine entities with their aliases and corresponding
 * RetrievalDocuments for the InMemorySearchIndex.
 */

import { createEntityId, type EntityId } from '../../../src/domain/shared/types/index.js';
import type { RetrievalDocument } from '../../../src/domain/retrieval/model/retrieval-document.js';
import type { Alias } from '../../../src/domain/alias/model/alias.js';
import type { HybridCandidate } from '../../../src/domain/retrieval/model/hybrid-candidate.js';
import type { RetrievalTrace } from '../../../src/domain/retrieval/model/retrieval-trace.js';
import type { AnchorEntityData } from '../../../src/domain/mixed/service/anchor-profiler.js';
import type { SimilarityCandidate } from '../../../src/domain/mixed/service/similarity-scorer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Entity IDs (stable, deterministic)
// ─────────────────────────────────────────────────────────────────────────────

export const OPUS_ONE_ID = createEntityId('opus-one-2018');
export const CHATEAU_MARGAUX_ID = createEntityId('chateau-margaux-2015');
export const ROMANEE_CONTI_ID = createEntityId('romanee-conti-2019');
export const SASSICAIA_ID = createEntityId('sassicaia-2018');
export const PENFOLDS_GRANGE_ID = createEntityId('penfolds-grange-2017');
export const CLOUDY_BAY_ID = createEntityId('cloudy-bay-2022');
export const MOET_BRUT_ID = createEntityId('moet-brut');
export const SAUTERNES_ID = createEntityId('sauternes-2015');
export const BAROLO_GIACOMO_ID = createEntityId('barolo-giacomo');
export const MASI_AMARONE_ID = createEntityId('masi-amarone');

// ─────────────────────────────────────────────────────────────────────────────
// Entity fixture objects (entityId + display metadata)
// ─────────────────────────────────────────────────────────────────────────────

export const OPUS_ONE_2018 = {
  entityId: OPUS_ONE_ID,
  entityType: 'wine' as const,
  canonicalLabel: 'Opus One 2018',
  region: 'Napa Valley',
  grapes: ['Cabernet Sauvignon', 'Merlot', 'Cabernet Franc', 'Malbec', 'Petit Verdot'],
  body: 0.9,
  sweetness: 0.1,
  style: 'bold red',
  priceBand: 'luxury',
  popularityScore: 0.95,
};

export const CHATEAU_MARGAUX_2015 = {
  entityId: CHATEAU_MARGAUX_ID,
  entityType: 'wine' as const,
  canonicalLabel: 'Château Margaux 2015',
  region: 'Bordeaux',
  grapes: ['Cabernet Sauvignon', 'Merlot', 'Cabernet Franc', 'Petit Verdot'],
  body: 0.85,
  sweetness: 0.05,
  style: 'bold red',
  priceBand: 'luxury',
  popularityScore: 0.93,
};

export const ROMANEE_CONTI_2019 = {
  entityId: ROMANEE_CONTI_ID,
  entityType: 'wine' as const,
  canonicalLabel: 'Romanée-Conti 2019',
  region: 'Burgundy',
  grapes: ['Pinot Noir'],
  body: 0.6,
  sweetness: 0.1,
  style: 'light red',
  priceBand: 'luxury',
  popularityScore: 0.91,
};

export const SASSICAIA_2018 = {
  entityId: SASSICAIA_ID,
  entityType: 'wine' as const,
  canonicalLabel: 'Sassicaia 2018',
  region: 'Tuscany',
  grapes: ['Cabernet Sauvignon', 'Cabernet Franc'],
  body: 0.85,
  sweetness: 0.05,
  style: 'bold red',
  priceBand: 'premium',
  popularityScore: 0.88,
};

export const PENFOLDS_GRANGE_2017 = {
  entityId: PENFOLDS_GRANGE_ID,
  entityType: 'wine' as const,
  canonicalLabel: 'Penfolds Grange 2017',
  region: 'Barossa Valley',
  grapes: ['Shiraz', 'Cabernet Sauvignon'],
  body: 0.95,
  sweetness: 0.1,
  style: 'bold red',
  priceBand: 'luxury',
  popularityScore: 0.87,
};

export const CLOUDY_BAY_2022 = {
  entityId: CLOUDY_BAY_ID,
  entityType: 'wine' as const,
  canonicalLabel: 'Cloudy Bay Sauvignon Blanc 2022',
  region: 'Marlborough',
  grapes: ['Sauvignon Blanc'],
  body: 0.3,
  sweetness: 0.1,
  style: 'crisp white',
  priceBand: 'mid',
  popularityScore: 0.82,
};

export const MOET_BRUT = {
  entityId: MOET_BRUT_ID,
  entityType: 'wine' as const,
  canonicalLabel: 'Moët & Chandon Brut Impérial',
  region: 'Champagne',
  grapes: ['Chardonnay', 'Pinot Noir', 'Pinot Meunier'],
  body: 0.3,
  sweetness: 0.2,
  style: 'sparkling',
  priceBand: 'mid',
  popularityScore: 0.90,
};

export const SAUTERNES_2015 = {
  entityId: SAUTERNES_ID,
  entityType: 'wine' as const,
  canonicalLabel: "Château d'Yquem Sauternes 2015",
  region: 'Bordeaux',
  grapes: ['Sémillon', 'Sauvignon Blanc'],
  body: 0.5,
  sweetness: 0.95,
  style: 'sweet white',
  priceBand: 'luxury',
  popularityScore: 0.85,
};

export const BAROLO_GIACOMO = {
  entityId: BAROLO_GIACOMO_ID,
  entityType: 'wine' as const,
  canonicalLabel: 'Giacomo Conterno Barolo Monfortino',
  region: 'Piedmont',
  grapes: ['Nebbiolo'],
  body: 0.85,
  sweetness: 0.05,
  style: 'bold red',
  priceBand: 'luxury',
  popularityScore: 0.83,
};

export const MASI_AMARONE = {
  entityId: MASI_AMARONE_ID,
  entityType: 'wine' as const,
  canonicalLabel: 'Masi Amarone della Valpolicella Classico',
  region: 'Veneto',
  grapes: ['Corvina', 'Rondinella', 'Molinara'],
  body: 0.9,
  sweetness: 0.15,
  style: 'bold red',
  priceBand: 'premium',
  popularityScore: 0.80,
};

// ─────────────────────────────────────────────────────────────────────────────
// All fixture entities as an array
// ─────────────────────────────────────────────────────────────────────────────

export const ALL_TEST_FIXTURES = [
  OPUS_ONE_2018,
  CHATEAU_MARGAUX_2015,
  ROMANEE_CONTI_2019,
  SASSICAIA_2018,
  PENFOLDS_GRANGE_2017,
  CLOUDY_BAY_2022,
  MOET_BRUT,
  SAUTERNES_2015,
  BAROLO_GIACOMO,
  MASI_AMARONE,
];

/**
 * Shared mixed-query fixture topology.
 *
 * The mixed solver needs three pieces of in-memory state:
 * - anchor entity resolution
 * - a neighborhood of similar candidates per anchor
 * - candidate attributes for overlay / preservation checks
 *
 * The neighborhoods below are intentionally small but real-world shaped.
 */
export interface MixedNeighborhoodFixture {
  readonly anchorId: EntityId;
  readonly candidateIds: readonly EntityId[];
}

export const MIXED_NEIGHBORHOOD_FIXTURES: readonly MixedNeighborhoodFixture[] = [
  {
    anchorId: OPUS_ONE_ID,
    candidateIds: [
      OPUS_ONE_ID,
      CHATEAU_MARGAUX_ID,
      SASSICAIA_ID,
      PENFOLDS_GRANGE_ID,
      BAROLO_GIACOMO_ID,
      MASI_AMARONE_ID,
    ],
  },
  {
    anchorId: CHATEAU_MARGAUX_ID,
    candidateIds: [
      CHATEAU_MARGAUX_ID,
      OPUS_ONE_ID,
      SASSICAIA_ID,
      PENFOLDS_GRANGE_ID,
      BAROLO_GIACOMO_ID,
      MASI_AMARONE_ID,
    ],
  },
  {
    anchorId: ROMANEE_CONTI_ID,
    candidateIds: [
      ROMANEE_CONTI_ID,
      OPUS_ONE_ID,
      CHATEAU_MARGAUX_ID,
      SASSICAIA_ID,
      PENFOLDS_GRANGE_ID,
      BAROLO_GIACOMO_ID,
      MASI_AMARONE_ID,
    ],
  },
  {
    anchorId: SASSICAIA_ID,
    candidateIds: [
      SASSICAIA_ID,
      OPUS_ONE_ID,
      CHATEAU_MARGAUX_ID,
      PENFOLDS_GRANGE_ID,
      BAROLO_GIACOMO_ID,
      MASI_AMARONE_ID,
    ],
  },
  {
    anchorId: PENFOLDS_GRANGE_ID,
    candidateIds: [
      PENFOLDS_GRANGE_ID,
      OPUS_ONE_ID,
      CHATEAU_MARGAUX_ID,
      SASSICAIA_ID,
      BAROLO_GIACOMO_ID,
      MASI_AMARONE_ID,
    ],
  },
  {
    anchorId: CLOUDY_BAY_ID,
    candidateIds: [
      CLOUDY_BAY_ID,
      SAUTERNES_ID,
      MOET_BRUT_ID,
    ],
  },
  {
    anchorId: SAUTERNES_ID,
    candidateIds: [
      SAUTERNES_ID,
      CLOUDY_BAY_ID,
      MOET_BRUT_ID,
    ],
  },
  {
    anchorId: MOET_BRUT_ID,
    candidateIds: [
      MOET_BRUT_ID,
      CLOUDY_BAY_ID,
      SAUTERNES_ID,
    ],
  },
  {
    anchorId: BAROLO_GIACOMO_ID,
    candidateIds: [
      BAROLO_GIACOMO_ID,
      OPUS_ONE_ID,
      CHATEAU_MARGAUX_ID,
      SASSICAIA_ID,
      PENFOLDS_GRANGE_ID,
      MASI_AMARONE_ID,
    ],
  },
  {
    anchorId: MASI_AMARONE_ID,
    candidateIds: [
      MASI_AMARONE_ID,
      OPUS_ONE_ID,
      CHATEAU_MARGAUX_ID,
      SASSICAIA_ID,
      PENFOLDS_GRANGE_ID,
      BAROLO_GIACOMO_ID,
    ],
  },
];

function makeEmbedding(entityId: string, dim = 16): readonly number[] {
  const vec = new Array<number>(dim).fill(0);
  for (let i = 0; i < entityId.length; i++) {
    const code = entityId.charCodeAt(i);
    const idx = (code * (i + 1)) % dim;
    vec[idx] = ((vec[idx] ?? 0) + code / 255) % 1;
  }
  const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vec.map((value) => value / norm);
}

function inferWineType(style: string): string {
  if (style.includes('sparkling')) return 'sparkling';
  if (style.includes('white')) return 'white';
  return 'red';
}

function inferColor(style: string): string {
  if (style.includes('sparkling')) return 'white';
  if (style.includes('white')) return 'white';
  return 'red';
}

function inferCountry(region: string): string {
  const lower = region.toLowerCase();
  if (lower.includes('napa') || lower.includes('california')) return 'United States';
  if (lower.includes('bordeaux') || lower.includes('burgundy') || lower.includes('champagne')) return 'France';
  if (lower.includes('tuscany') || lower.includes('piedmont') || lower.includes('veneto')) return 'Italy';
  if (lower.includes('barossa')) return 'Australia';
  if (lower.includes('marlborough')) return 'New Zealand';
  return 'Unknown';
}

export function toAnchorEntityData(doc: RetrievalDocument): AnchorEntityData {
  return {
    entityId: doc.entityId,
    canonicalLabel: doc.canonicalLabel,
    region: doc.region,
    grapes: [...doc.grapes],
    body: doc.body,
    sweetness: doc.sweetness,
    style: doc.style,
    embedding: makeEmbedding(String(doc.entityId)),
  };
}

export function toSimilarityCandidate(doc: RetrievalDocument): SimilarityCandidate {
  return {
    region: doc.region,
    grapes: [...doc.grapes],
    body: doc.body,
    sweetness: doc.sweetness,
    style: doc.style,
    embedding: makeEmbedding(String(doc.entityId)),
  };
}

export function toCandidateAttributes(doc: RetrievalDocument): Readonly<Record<string, unknown>> {
  const wineType = doc.wineType ?? inferWineType(doc.style);
  const color = inferColor(doc.style);
  const country = doc.country ?? inferCountry(doc.region);
  const grapePrimary = doc.grapePrimary ?? doc.grapes[0] ?? '';

  return {
    ...doc,
    wineType,
    wine_type: wineType,
    color,
    country,
    grapePrimary,
    grape_primary: grapePrimary,
    appellation: doc.appellation ?? doc.region,
    producerType: doc.producerType ?? 'winery',
    producer_type: doc.producerType ?? 'winery',
    price_band: doc.priceBand,
    body: doc.body,
    sweetness: doc.sweetness,
    style: doc.style,
    region: doc.region,
    producer: doc.producer,
  };
}

export function toHybridCandidate(
  doc: RetrievalDocument,
  rank: number,
  candidateSources: readonly string[],
  retrievalProfile = 'test-mixed-neighborhood',
): HybridCandidate {
  const anchorRank = Math.max(1, rank);
  const retrievalFusionScore = Math.max(0.01, 0.25 - (anchorRank - 1) * 0.02);

  return {
    entityId: doc.entityId,
    canonicalLabel: doc.canonicalLabel,
    producer: doc.producer,
    region: doc.region,
    searchTextEn: doc.searchTextEn,
    grapePrimary: doc.grapePrimary ?? doc.grapes[0],
    vintageYear: doc.vintageYear,
    body: doc.body,
    tannin: doc.tannin,
    acidity: doc.acidity,
    sweetness: doc.sweetness,
    country: doc.country,
    appellation: doc.appellation ?? doc.region,
    sparseRank: anchorRank,
    denseRank: anchorRank,
    anchorRank,
    retrievalFusionScore,
    matchedConstraints: [],
    retrievalTrace: {
      retrievalProfile,
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
      candidateSources: [...candidateSources],
    } satisfies RetrievalTrace,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Alias definitions
// ─────────────────────────────────────────────────────────────────────────────

export interface TestAlias {
  surfaceForm: string;
  entityId: EntityId;
  confidence: number;
}

export const TEST_ALIASES: readonly TestAlias[] = [
  // Opus One — English + Korean
  { surfaceForm: 'Opus One 2018', entityId: OPUS_ONE_ID, confidence: 1.0 },
  { surfaceForm: 'opus one', entityId: OPUS_ONE_ID, confidence: 0.97 },
  { surfaceForm: 'Opus One', entityId: OPUS_ONE_ID, confidence: 0.95 },
  { surfaceForm: '오푸스원', entityId: OPUS_ONE_ID, confidence: 0.96 },
  { surfaceForm: '오퍼스 원', entityId: OPUS_ONE_ID, confidence: 0.90 },

  // Château Margaux — English + Korean + French
  { surfaceForm: 'Château Margaux 2015', entityId: CHATEAU_MARGAUX_ID, confidence: 1.0 },
  { surfaceForm: 'Château Margaux', entityId: CHATEAU_MARGAUX_ID, confidence: 0.96 },
  { surfaceForm: 'Chateau Margaux', entityId: CHATEAU_MARGAUX_ID, confidence: 0.94 },
  { surfaceForm: '마고', entityId: CHATEAU_MARGAUX_ID, confidence: 0.70 },  // ambiguous with region
  { surfaceForm: '샤토 마고', entityId: CHATEAU_MARGAUX_ID, confidence: 0.95 },

  // Romanée-Conti
  { surfaceForm: 'Romanée-Conti 2019', entityId: ROMANEE_CONTI_ID, confidence: 1.0 },
  { surfaceForm: 'DRC', entityId: ROMANEE_CONTI_ID, confidence: 0.88 },
  { surfaceForm: 'romanee conti', entityId: ROMANEE_CONTI_ID, confidence: 0.94 },

  // Sassicaia
  { surfaceForm: 'Sassicaia 2018', entityId: SASSICAIA_ID, confidence: 1.0 },
  { surfaceForm: 'Sassicaia', entityId: SASSICAIA_ID, confidence: 0.95 },
  { surfaceForm: '사시카이아', entityId: SASSICAIA_ID, confidence: 0.92 },

  // Penfolds Grange
  { surfaceForm: 'Penfolds Grange 2017', entityId: PENFOLDS_GRANGE_ID, confidence: 1.0 },
  { surfaceForm: 'Grange', entityId: PENFOLDS_GRANGE_ID, confidence: 0.88 },
  { surfaceForm: '펜폴즈 그레인지', entityId: PENFOLDS_GRANGE_ID, confidence: 0.93 },

  // Cloudy Bay
  { surfaceForm: 'Cloudy Bay Sauvignon Blanc 2022', entityId: CLOUDY_BAY_ID, confidence: 1.0 },
  { surfaceForm: 'Cloudy Bay', entityId: CLOUDY_BAY_ID, confidence: 0.95 },
  { surfaceForm: '클라우디베이', entityId: CLOUDY_BAY_ID, confidence: 0.94 },
  { surfaceForm: '클라우디 베이', entityId: CLOUDY_BAY_ID, confidence: 0.91 },

  // Moët Brut
  { surfaceForm: "Moët & Chandon Brut Impérial", entityId: MOET_BRUT_ID, confidence: 1.0 },
  { surfaceForm: 'Moet Brut', entityId: MOET_BRUT_ID, confidence: 0.94 },
  { surfaceForm: '모에 샹동', entityId: MOET_BRUT_ID, confidence: 0.92 },
  { surfaceForm: '모엣', entityId: MOET_BRUT_ID, confidence: 0.88 },

  // Sauternes
  { surfaceForm: "Château d'Yquem Sauternes 2015", entityId: SAUTERNES_ID, confidence: 1.0 },
  { surfaceForm: "Château d'Yquem", entityId: SAUTERNES_ID, confidence: 0.95 },
  { surfaceForm: '이켐', entityId: SAUTERNES_ID, confidence: 0.90 },

  // Barolo
  { surfaceForm: 'Giacomo Conterno Barolo Monfortino', entityId: BAROLO_GIACOMO_ID, confidence: 1.0 },
  { surfaceForm: 'Barolo Monfortino', entityId: BAROLO_GIACOMO_ID, confidence: 0.94 },
  { surfaceForm: '바롤로 자코모', entityId: BAROLO_GIACOMO_ID, confidence: 0.90 },

  // Masi Amarone
  { surfaceForm: 'Masi Amarone della Valpolicella Classico', entityId: MASI_AMARONE_ID, confidence: 1.0 },
  { surfaceForm: 'Masi Amarone', entityId: MASI_AMARONE_ID, confidence: 0.95 },
  { surfaceForm: '마시 아마로네', entityId: MASI_AMARONE_ID, confidence: 0.91 },
];

// ─────────────────────────────────────────────────────────────────────────────
// RetrievalDocuments for the InMemorySearchIndex
// ─────────────────────────────────────────────────────────────────────────────

export const TEST_DOCUMENTS: readonly RetrievalDocument[] = [
  {
    entityId: OPUS_ONE_ID,
    entityType: 'wine',
    canonicalLabel: 'Opus One 2018',
    aliasesIdentitySafe: ['Opus One 2018', 'opus one 2018'],
    aliasesNoisyRecall: ['오푸스원', '오퍼스 원', 'opus one'],
    producer: 'Opus One Winery',
    region: 'Napa Valley',
    grapes: ['Cabernet Sauvignon', 'Merlot', 'Cabernet Franc', 'Malbec', 'Petit Verdot'],
    searchTextKo: '오푸스원 2018 나파밸리 카베르네 소비뇽 블렌드 풀바디 레드 와인',
    searchTextEn: 'Opus One 2018 Napa Valley Cabernet Sauvignon blend full body red wine',
    semanticSummary:
      'Opus One is a prestigious Napa Valley Cabernet-dominant blend, known for its full body, rich tannins, and complex dark fruit flavors.',
    body: 0.9,
    sweetness: 0.1,
    style: 'bold red',
    priceBand: 'luxury',
    pairing: ['beef', 'lamb', 'aged cheese'],
    occasion: ['celebration', 'special dinner'],
    availability: true,
    popularityScore: 0.95,
  },
  {
    entityId: CHATEAU_MARGAUX_ID,
    entityType: 'wine',
    canonicalLabel: 'Château Margaux 2015',
    aliasesIdentitySafe: ['Château Margaux 2015', 'chateau margaux 2015'],
    aliasesNoisyRecall: ['마고', '샤토 마고', 'Chateau Margaux', 'margaux'],
    producer: 'Château Margaux',
    region: 'Bordeaux',
    grapes: ['Cabernet Sauvignon', 'Merlot', 'Cabernet Franc', 'Petit Verdot'],
    searchTextKo: '샤토 마고 2015 보르도 카베르네 소비뇽 풀바디 레드 와인 프리미어 그랑 크뤼',
    searchTextEn: 'Château Margaux 2015 Bordeaux Cabernet Sauvignon first growth Grand Cru',
    semanticSummary:
      'Château Margaux is a legendary Bordeaux first growth, famous for its elegance, silky texture, and long aging potential.',
    body: 0.85,
    sweetness: 0.05,
    style: 'bold red',
    priceBand: 'luxury',
    pairing: ['duck', 'lamb', 'truffle'],
    occasion: ['celebration', 'investment wine'],
    availability: true,
    popularityScore: 0.93,
  },
  {
    entityId: ROMANEE_CONTI_ID,
    entityType: 'wine',
    canonicalLabel: 'Romanée-Conti 2019',
    aliasesIdentitySafe: ['Romanée-Conti 2019', 'romanee-conti 2019'],
    aliasesNoisyRecall: ['DRC', '로마네꽁티', 'romanee conti'],
    producer: 'Domaine de la Romanée-Conti',
    region: 'Burgundy',
    grapes: ['Pinot Noir'],
    searchTextKo: '로마네 콩티 2019 부르고뉴 피노누아 라이트바디 레드 와인',
    searchTextEn: 'Romanée-Conti 2019 Burgundy Pinot Noir light body red wine DRC',
    semanticSummary:
      'Romanée-Conti is considered the most prestigious wine in the world, a single-vineyard Burgundy Pinot Noir of extraordinary complexity.',
    body: 0.6,
    sweetness: 0.1,
    style: 'light red',
    priceBand: 'luxury',
    pairing: ['duck', 'game', 'truffle'],
    occasion: ['once in a lifetime', 'investment'],
    availability: false,
    popularityScore: 0.91,
  },
  {
    entityId: SASSICAIA_ID,
    entityType: 'wine',
    canonicalLabel: 'Sassicaia 2018',
    aliasesIdentitySafe: ['Sassicaia 2018', 'sassicaia 2018'],
    aliasesNoisyRecall: ['사시카이아', 'Sassicaia', 'bolgheri sassicaia'],
    producer: 'Tenuta San Guido',
    region: 'Tuscany',
    grapes: ['Cabernet Sauvignon', 'Cabernet Franc'],
    searchTextKo: '사시카이아 2018 토스카나 카베르네 소비뇽 풀바디 슈퍼 투스칸',
    searchTextEn: 'Sassicaia 2018 Tuscany Bolgheri Cabernet Sauvignon Super Tuscan full body',
    semanticSummary:
      'Sassicaia is the original Super Tuscan, a Cabernet Sauvignon-dominant blend from the Bolgheri coast of Tuscany.',
    body: 0.85,
    sweetness: 0.05,
    style: 'bold red',
    priceBand: 'premium',
    pairing: ['steak', 'wild boar', 'hard cheese'],
    occasion: ['special dinner', 'gifting'],
    availability: true,
    popularityScore: 0.88,
  },
  {
    entityId: PENFOLDS_GRANGE_ID,
    entityType: 'wine',
    canonicalLabel: 'Penfolds Grange 2017',
    aliasesIdentitySafe: ['Penfolds Grange 2017', 'penfolds grange 2017'],
    aliasesNoisyRecall: ['펜폴즈 그레인지', 'Grange', 'grange hermitage'],
    producer: 'Penfolds',
    region: 'Barossa Valley',
    grapes: ['Shiraz', 'Cabernet Sauvignon'],
    searchTextKo: '펜폴즈 그레인지 2017 바로사 밸리 쉬라즈 매우 풀바디 레드 와인',
    searchTextEn: 'Penfolds Grange 2017 Barossa Valley Shiraz very full body bold red wine',
    semanticSummary:
      'Penfolds Grange is Australia\'s most iconic wine, a Shiraz-dominant blend of immense power and aging potential.',
    body: 0.95,
    sweetness: 0.1,
    style: 'bold red',
    priceBand: 'luxury',
    pairing: ['wagyu beef', 'barbecue', 'dark chocolate'],
    occasion: ['celebration', 'investment wine'],
    availability: true,
    popularityScore: 0.87,
  },
  {
    entityId: CLOUDY_BAY_ID,
    entityType: 'wine',
    canonicalLabel: 'Cloudy Bay Sauvignon Blanc 2022',
    aliasesIdentitySafe: ['Cloudy Bay Sauvignon Blanc 2022', 'cloudy bay 2022'],
    aliasesNoisyRecall: ['클라우디베이', '클라우디 베이', 'Cloudy Bay', 'cloudy bay sauvignon'],
    producer: 'Cloudy Bay Vineyards',
    region: 'Marlborough',
    grapes: ['Sauvignon Blanc'],
    searchTextKo: '클라우디 베이 소비뇽 블랑 2022 말보로 가볍고 상큼한 화이트 와인',
    searchTextEn: 'Cloudy Bay Sauvignon Blanc 2022 Marlborough New Zealand crisp light white wine',
    semanticSummary:
      'Cloudy Bay Sauvignon Blanc is a benchmark New Zealand white wine, celebrated for its zesty citrus and passionfruit aromatics.',
    body: 0.3,
    sweetness: 0.1,
    style: 'crisp white',
    priceBand: 'mid',
    pairing: ['seafood', 'salad', 'goat cheese'],
    occasion: ['summer', 'casual dinner'],
    availability: true,
    popularityScore: 0.82,
  },
  {
    entityId: MOET_BRUT_ID,
    entityType: 'wine',
    canonicalLabel: 'Moët & Chandon Brut Impérial',
    aliasesIdentitySafe: ["Moët & Chandon Brut Impérial", 'moet & chandon brut imperial'],
    aliasesNoisyRecall: ['모에 샹동', '모엣', 'Moet Brut', 'moet chandon', '스파클링'],
    producer: 'Moët & Chandon',
    region: 'Champagne',
    grapes: ['Chardonnay', 'Pinot Noir', 'Pinot Meunier'],
    searchTextKo: '모에 샹동 브뤼 임페리얼 샴페인 스파클링 와인 축하 파티',
    searchTextEn: 'Moët & Chandon Brut Impérial Champagne sparkling wine celebration party',
    semanticSummary:
      'Moët & Chandon Brut Impérial is the world\'s most popular Champagne, a fresh and vibrant sparkling wine perfect for celebrations.',
    body: 0.3,
    sweetness: 0.2,
    style: 'sparkling',
    priceBand: 'mid',
    pairing: ['oysters', 'sushi', 'light appetizers'],
    occasion: ['celebration', 'party', 'wedding'],
    availability: true,
    popularityScore: 0.90,
  },
  {
    entityId: SAUTERNES_ID,
    entityType: 'wine',
    canonicalLabel: "Château d'Yquem Sauternes 2015",
    aliasesIdentitySafe: ["Château d'Yquem Sauternes 2015", "chateau d'yquem 2015"],
    aliasesNoisyRecall: ['이켐', "d'Yquem", 'yquem sauternes', '달달한 와인', '디저트 와인'],
    producer: "Château d'Yquem",
    region: 'Bordeaux',
    grapes: ['Sémillon', 'Sauvignon Blanc'],
    searchTextKo: '샤토 디켐 소테른 2015 보르도 달달한 스위트 디저트 와인',
    searchTextEn: "Château d'Yquem Sauternes 2015 Bordeaux sweet dessert wine botrytis",
    semanticSummary:
      "Château d'Yquem is the world's greatest sweet wine, made from botrytis-affected grapes in Sauternes, Bordeaux.",
    body: 0.5,
    sweetness: 0.95,
    style: 'sweet white',
    priceBand: 'luxury',
    pairing: ['foie gras', 'blue cheese', 'fruit desserts'],
    occasion: ['dessert', 'special occasion'],
    availability: true,
    popularityScore: 0.85,
  },
  {
    entityId: BAROLO_GIACOMO_ID,
    entityType: 'wine',
    canonicalLabel: 'Giacomo Conterno Barolo Monfortino',
    aliasesIdentitySafe: ['Giacomo Conterno Barolo Monfortino', 'barolo monfortino'],
    aliasesNoisyRecall: ['바롤로 자코모', 'Barolo Giacomo', 'barolo monfortino conterno'],
    producer: 'Giacomo Conterno',
    region: 'Piedmont',
    grapes: ['Nebbiolo'],
    searchTextKo: '자코모 콘테르노 바롤로 몬포르티노 피에몬테 네비올로 풀바디 강한 타닌',
    searchTextEn: 'Giacomo Conterno Barolo Monfortino Piedmont Nebbiolo full body strong tannin aged',
    semanticSummary:
      'Giacomo Conterno Barolo Monfortino is the pinnacle of Piedmont winemaking, a powerful Nebbiolo of extraordinary longevity.',
    body: 0.85,
    sweetness: 0.05,
    style: 'bold red',
    priceBand: 'luxury',
    pairing: ['truffle', 'braised meat', 'aged cheese'],
    occasion: ['special dinner', 'investment wine'],
    availability: true,
    popularityScore: 0.83,
  },
  {
    entityId: MASI_AMARONE_ID,
    entityType: 'wine',
    canonicalLabel: 'Masi Amarone della Valpolicella Classico',
    aliasesIdentitySafe: ['Masi Amarone della Valpolicella Classico', 'masi amarone'],
    aliasesNoisyRecall: ['마시 아마로네', 'Masi Amarone', 'amarone valpolicella', '아마로네'],
    producer: 'Masi Agricola',
    region: 'Veneto',
    grapes: ['Corvina', 'Rondinella', 'Molinara'],
    searchTextKo: '마시 아마로네 발폴리첼라 베네토 코르비나 풀바디 강렬한 레드 와인',
    searchTextEn: 'Masi Amarone della Valpolicella Veneto Corvina full body intense rich red wine',
    semanticSummary:
      'Masi Amarone della Valpolicella is a celebrated Italian red wine made from partially dried grapes, known for its incredible richness.',
    body: 0.9,
    sweetness: 0.15,
    style: 'bold red',
    priceBand: 'premium',
    pairing: ['braised beef', 'venison', 'aged parmesan'],
    occasion: ['winter dinner', 'special occasion'],
    availability: true,
    popularityScore: 0.80,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: all full-body wines (body >= 0.7) for query assertions
// ─────────────────────────────────────────────────────────────────────────────

export const FULL_BODY_ENTITY_IDS: readonly EntityId[] = ALL_TEST_FIXTURES
  .filter((f) => f.body >= 0.7)
  .map((f) => f.entityId);

export const SPARKLING_ENTITY_IDS: readonly EntityId[] = [MOET_BRUT_ID];

export const SWEET_ENTITY_IDS: readonly EntityId[] = [SAUTERNES_ID];

export const WHITE_ENTITY_IDS: readonly EntityId[] = [CLOUDY_BAY_ID, SAUTERNES_ID];

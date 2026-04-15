/**
 * Test fixtures for the Vespa E2E test suite.
 *
 * These documents must be seeded into Vespa before the tests run.
 * The seed script lives at scripts/seed-wines-real.ts.
 *
 * NOTE: romanee-conti-2015 has availability=false so it will NOT be returned
 * by sparseSearch / denseSearch (which filter `availability = true`).
 * Tests that verify it is absent are intentional.
 */

import { createEntityId, type EntityId } from '../../../../src/domain/shared/types/index.js';
import type { RetrievalDocument } from '../../../../src/domain/retrieval/model/retrieval-document.js';

// ---------------------------------------------------------------------------
// Entity IDs
// ---------------------------------------------------------------------------

export const OPUS_ONE_ID = createEntityId('opus-one-2018');
export const CHATEAU_MARGAUX_ID = createEntityId('chateau-margaux-2015');
export const SASSICAIA_ID = createEntityId('sassicaia-2018');
export const PENFOLDS_GRANGE_ID = createEntityId('penfolds-grange-2017');
export const ROMANEE_CONTI_ID = createEntityId('romanee-conti-2015');
export const CLOUDY_BAY_ID = createEntityId('cloudy-bay-2022');
const MOET_BRUT_ID = createEntityId('moet-brut-nv');
export const SAUTERNES_ID = createEntityId('yquem-2015');
export const BAROLO_GIACOMO_ID = createEntityId('barolo-conterno-2015');
export const MASI_AMARONE_ID = createEntityId('masi-amarone-2015');

// ---------------------------------------------------------------------------
// Alias definitions
// ---------------------------------------------------------------------------

interface VespaTestAlias {
  readonly surfaceForm: string;
  readonly entityId: EntityId;
  readonly confidence: number;
}

const _VESPA_TEST_ALIASES: readonly VespaTestAlias[] = [
  // Opus One
  { surfaceForm: 'Opus One 2018',  entityId: OPUS_ONE_ID, confidence: 1.0 },
  { surfaceForm: 'Opus One',       entityId: OPUS_ONE_ID, confidence: 0.95 },
  { surfaceForm: '오푸스원',        entityId: OPUS_ONE_ID, confidence: 0.96 },
  { surfaceForm: '오퍼스 원',       entityId: OPUS_ONE_ID, confidence: 0.90 },

  // Château Margaux
  { surfaceForm: 'Château Margaux', entityId: CHATEAU_MARGAUX_ID, confidence: 0.96 },
  { surfaceForm: 'Chateau Margaux', entityId: CHATEAU_MARGAUX_ID, confidence: 0.94 },
  { surfaceForm: '샤토 마고',        entityId: CHATEAU_MARGAUX_ID, confidence: 0.95 },

  // Sassicaia
  { surfaceForm: 'Sassicaia 2018',  entityId: SASSICAIA_ID, confidence: 1.0 },
  { surfaceForm: 'Sassicaia',       entityId: SASSICAIA_ID, confidence: 0.95 },
  { surfaceForm: '사시카이아',       entityId: SASSICAIA_ID, confidence: 0.92 },

  // Penfolds Grange
  { surfaceForm: 'Penfolds Grange', entityId: PENFOLDS_GRANGE_ID, confidence: 0.95 },
  { surfaceForm: '그레인지',         entityId: PENFOLDS_GRANGE_ID, confidence: 0.90 },

  // Romanée-Conti (availability=false, won't appear in search results)
  { surfaceForm: 'Romanée-Conti',   entityId: ROMANEE_CONTI_ID, confidence: 0.97 },
  { surfaceForm: 'romanee conti',   entityId: ROMANEE_CONTI_ID, confidence: 0.94 },
  { surfaceForm: '로마네 꽁티',      entityId: ROMANEE_CONTI_ID, confidence: 0.95 },

  // Cloudy Bay
  { surfaceForm: 'Cloudy Bay',      entityId: CLOUDY_BAY_ID, confidence: 0.95 },
  { surfaceForm: '클라우디베이',     entityId: CLOUDY_BAY_ID, confidence: 0.94 },

  // Moët Brut
  { surfaceForm: 'Moët Brut',       entityId: MOET_BRUT_ID, confidence: 0.95 },
  { surfaceForm: '모에 샹동',        entityId: MOET_BRUT_ID, confidence: 0.92 },

  // Sauternes
  { surfaceForm: "Château d'Yquem", entityId: SAUTERNES_ID, confidence: 0.95 },
  { surfaceForm: '이켐',             entityId: SAUTERNES_ID, confidence: 0.90 },

  // Barolo
  { surfaceForm: 'Barolo Giacomo Conterno', entityId: BAROLO_GIACOMO_ID, confidence: 0.94 },

  // Masi Amarone
  { surfaceForm: 'Masi Amarone',    entityId: MASI_AMARONE_ID, confidence: 0.95 },
  { surfaceForm: '아마로네',         entityId: MASI_AMARONE_ID, confidence: 0.91 },
];

// ---------------------------------------------------------------------------
// RetrievalDocuments — seeded into Vespa before tests
// ---------------------------------------------------------------------------

/**
 * Deterministic embedding vector based on entity ID hash.
 * Produces a normalised 1024-dim vector matching the Vespa schema tensor<float>(x[1024]).
 */
function makeEmbedding(entityId: string, dim = 1024): readonly number[] {
  const vec = new Array<number>(dim).fill(0);
  for (let i = 0; i < entityId.length; i++) {
    const code = entityId.charCodeAt(i);
    const idx = (code * (i + 1)) % dim;
    vec[idx] = ((vec[idx] ?? 0) + code / 255) % 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

const VESPA_TEST_DOCUMENTS: readonly RetrievalDocument[] = [
  {
    entityId: OPUS_ONE_ID,
    entityType: 'wine',
    canonicalLabel: 'Opus One 2018',
    aliasesIdentitySafe: ['Opus One 2018', 'opus one 2018'],
    aliasesNoisyRecall: ['오푸스원', '오퍼스 원', 'opus one'],
    producer: 'Opus One Winery',
    region: 'Napa Valley',
    grapes: ['Cabernet Sauvignon', 'Merlot', 'Cabernet Franc'],
    searchTextKo: '오푸스원 2018 나파밸리 카베르네 소비뇽 블렌드 풀바디 레드 와인',
    searchTextEn: 'Opus One 2018 Napa Valley Cabernet Sauvignon blend full-body red wine',
    semanticSummary:
      'Opus One is a prestigious Napa Valley Cabernet-dominant blend, known for its full body, rich tannins, and complex dark fruit flavors.',
    body: 0.9,
    sweetness: 0.1,
    style: 'full-body red',
    priceBand: 'luxury',
    pairing: ['beef', 'lamb', 'aged cheese'],
    occasion: ['celebration', 'special dinner'],
    availability: true,
    popularityScore: 0.95,
    embedding: makeEmbedding('opus-one-2018'),
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
    searchTextEn: 'Château Margaux 2015 Bordeaux Cabernet Sauvignon first growth Grand Cru full-body red',
    semanticSummary:
      'Château Margaux is a legendary Bordeaux first growth, famous for its elegance, silky texture, and long aging potential.',
    body: 0.85,
    sweetness: 0.05,
    style: 'full-body red',
    priceBand: 'luxury',
    pairing: ['duck', 'lamb', 'truffle'],
    occasion: ['celebration', 'investment wine'],
    availability: true,
    popularityScore: 0.93,
    embedding: makeEmbedding('chateau-margaux-2015'),
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
    searchTextKo: '사시카이아 2018 토스카나 카베르네 소비뇽 풀바디 슈퍼 투스칸 레드 와인',
    searchTextEn: 'Sassicaia 2018 Tuscany Bolgheri Cabernet Sauvignon Super Tuscan full-body red',
    semanticSummary:
      'Sassicaia is the original Super Tuscan, a Cabernet Sauvignon-dominant blend from the Bolgheri coast of Tuscany.',
    body: 0.85,
    sweetness: 0.05,
    style: 'full-body red',
    priceBand: 'premium',
    pairing: ['steak', 'wild boar', 'hard cheese'],
    occasion: ['special dinner', 'gifting'],
    availability: true,
    popularityScore: 0.88,
    embedding: makeEmbedding('sassicaia-2018'),
  },
  {
    entityId: PENFOLDS_GRANGE_ID,
    entityType: 'wine',
    canonicalLabel: 'Penfolds Grange 2017',
    aliasesIdentitySafe: ['Penfolds Grange 2017', 'penfolds grange 2017'],
    aliasesNoisyRecall: ['그레인지', 'Penfolds Grange', 'grange hermitage'],
    producer: 'Penfolds',
    region: 'Barossa Valley',
    grapes: ['Shiraz', 'Cabernet Sauvignon'],
    searchTextKo: '펜폴즈 그레인지 2017 바로사 밸리 쉬라즈 풀바디 레드 와인',
    searchTextEn: 'Penfolds Grange 2017 Barossa Valley Shiraz very full-body bold red wine',
    semanticSummary:
      "Penfolds Grange is Australia's most iconic wine, a Shiraz-dominant blend of immense power and aging potential.",
    body: 0.95,
    sweetness: 0.1,
    style: 'full-body red',
    priceBand: 'luxury',
    pairing: ['wagyu beef', 'barbecue', 'dark chocolate'],
    occasion: ['celebration', 'investment wine'],
    availability: true,
    popularityScore: 0.87,
    embedding: makeEmbedding('penfolds-grange-2017'),
  },
  {
    entityId: ROMANEE_CONTI_ID,
    entityType: 'wine',
    canonicalLabel: 'Romanée-Conti DRC 2015',
    aliasesIdentitySafe: ['Romanée-Conti DRC 2015', 'romanee-conti 2015'],
    aliasesNoisyRecall: ['로마네 꽁티', 'romanee conti', 'DRC'],
    producer: 'Domaine de la Romanée-Conti',
    region: 'Burgundy',
    grapes: ['Pinot Noir'],
    searchTextKo: '로마네 꽁티 2015 부르고뉴 피노누아 라이트바디 레드 와인',
    searchTextEn: 'Romanée-Conti 2015 Burgundy Pinot Noir light body red wine DRC',
    semanticSummary:
      'Romanée-Conti is considered the most prestigious wine in the world, a single-vineyard Burgundy Pinot Noir of extraordinary complexity.',
    body: 0.3,
    sweetness: 0.1,
    style: 'light red',
    priceBand: 'luxury',
    pairing: ['duck', 'game', 'truffle'],
    occasion: ['once in a lifetime', 'investment'],
    // availability=false intentionally — tests that verify filtering out of results
    availability: false,
    popularityScore: 0.91,
    embedding: makeEmbedding('romanee-conti-2015'),
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
    searchTextKo: '클라우디 베이 소비뇽 블랑 2022 말보로 가볍고 상큼한 화이트 와인 라이트 화이트',
    searchTextEn: 'Cloudy Bay Sauvignon Blanc 2022 Marlborough New Zealand crisp light white wine',
    semanticSummary:
      'Cloudy Bay Sauvignon Blanc is a benchmark New Zealand white wine, celebrated for its zesty citrus and passionfruit aromatics.',
    body: 0.3,
    sweetness: 0.1,
    style: 'light white',
    priceBand: 'mid',
    pairing: ['seafood', 'salad', 'goat cheese'],
    occasion: ['summer', 'casual dinner'],
    availability: true,
    popularityScore: 0.82,
    embedding: makeEmbedding('cloudy-bay-2022'),
  },
  {
    entityId: MOET_BRUT_ID,
    entityType: 'wine',
    canonicalLabel: 'Moët & Chandon Brut Impérial',
    aliasesIdentitySafe: ['Moët & Chandon Brut Impérial', 'moet & chandon brut imperial'],
    aliasesNoisyRecall: ['모에 샹동', '모엣', 'Moët Brut', 'moet chandon', 'sparkling'],
    producer: 'Moët & Chandon',
    region: 'Champagne',
    grapes: ['Chardonnay', 'Pinot Noir', 'Pinot Meunier'],
    searchTextKo: '모에 샹동 브뤼 임페리얼 샴페인 스파클링 와인 축하 파티',
    searchTextEn: 'Moët & Chandon Brut Impérial Champagne sparkling wine celebration party',
    semanticSummary:
      "Moët & Chandon Brut Impérial is the world's most popular Champagne, a fresh and vibrant sparkling wine perfect for celebrations.",
    body: 0.3,
    sweetness: 0.2,
    style: 'sparkling',
    priceBand: 'mid',
    pairing: ['oysters', 'sushi', 'light appetizers'],
    occasion: ['celebration', 'party', 'wedding'],
    availability: true,
    popularityScore: 0.90,
    embedding: makeEmbedding('moet-brut-nv'),
  },
  {
    entityId: SAUTERNES_ID,
    entityType: 'wine',
    canonicalLabel: "Château d'Yquem Sauternes 2015",
    aliasesIdentitySafe: ["Château d'Yquem Sauternes 2015", "chateau d'yquem 2015"],
    aliasesNoisyRecall: ['이켐', "d'Yquem", '달달한 와인', '디저트 와인', 'sweet wine'],
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
    embedding: makeEmbedding('yquem-2015'),
  },
  {
    entityId: BAROLO_GIACOMO_ID,
    entityType: 'wine',
    canonicalLabel: 'Giacomo Conterno Barolo Monfortino',
    aliasesIdentitySafe: ['Giacomo Conterno Barolo Monfortino', 'barolo monfortino'],
    aliasesNoisyRecall: ['Barolo Giacomo Conterno', 'barolo giacomo', 'monfortino'],
    producer: 'Giacomo Conterno',
    region: 'Piedmont',
    grapes: ['Nebbiolo'],
    searchTextKo: '자코모 콘테르노 바롤로 몬포르티노 피에몬테 네비올로 풀바디 강한 타닌 레드 와인',
    searchTextEn: 'Giacomo Conterno Barolo Monfortino Piedmont Nebbiolo full-body red wine strong tannin aged',
    semanticSummary:
      'Giacomo Conterno Barolo Monfortino is the pinnacle of Piedmont winemaking, a powerful Nebbiolo of extraordinary longevity.',
    body: 0.9,
    sweetness: 0.05,
    style: 'full-body red',
    priceBand: 'luxury',
    pairing: ['truffle', 'braised meat', 'aged cheese'],
    occasion: ['special dinner', 'investment wine'],
    availability: true,
    popularityScore: 0.83,
    embedding: makeEmbedding('barolo-conterno-2015'),
  },
  {
    entityId: MASI_AMARONE_ID,
    entityType: 'wine',
    canonicalLabel: 'Masi Amarone della Valpolicella Classico',
    aliasesIdentitySafe: ['Masi Amarone della Valpolicella Classico', 'masi amarone'],
    aliasesNoisyRecall: ['아마로네', 'Masi Amarone', 'amarone valpolicella'],
    producer: 'Masi Agricola',
    region: 'Veneto',
    grapes: ['Corvina', 'Rondinella', 'Molinara'],
    searchTextKo: '마시 아마로네 발폴리첼라 베네토 코르비나 풀바디 강렬한 레드 와인',
    searchTextEn: 'Masi Amarone della Valpolicella Veneto Corvina full-body intense rich red wine',
    semanticSummary:
      'Masi Amarone della Valpolicella is a celebrated Italian red wine made from partially dried grapes, known for its incredible richness.',
    body: 0.8,
    sweetness: 0.15,
    style: 'full-body red',
    priceBand: 'premium',
    pairing: ['braised beef', 'venison', 'aged parmesan'],
    occasion: ['winter dinner', 'special occasion'],
    availability: true,
    popularityScore: 0.80,
    embedding: makeEmbedding('masi-amarone-2015'),
  },
];

// ---------------------------------------------------------------------------
// Convenience lookups
// ---------------------------------------------------------------------------

/** Entity IDs of all documents that have availability=true and body >= 0.8 */
const _FULL_BODY_AVAILABLE_IDS: readonly EntityId[] = VESPA_TEST_DOCUMENTS
  .filter((d) => d.availability && d.body >= 0.8)
  .map((d) => d.entityId);

/** Entity IDs of documents with style='full-body red' */
const _FULL_BODY_RED_IDS: readonly EntityId[] = VESPA_TEST_DOCUMENTS
  .filter((d) => d.style === 'full-body red')
  .map((d) => d.entityId);

/** Entity IDs of documents with sweetness >= 0.5 */
const _SWEET_WINE_IDS: readonly EntityId[] = VESPA_TEST_DOCUMENTS
  .filter((d) => d.sweetness >= 0.5)
  .map((d) => d.entityId);

/** Entity IDs of sparkling wines */
const _SPARKLING_IDS: readonly EntityId[] = VESPA_TEST_DOCUMENTS
  .filter((d) => d.style === 'sparkling')
  .map((d) => d.entityId);

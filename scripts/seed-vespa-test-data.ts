#!/usr/bin/env tsx
/**
 * seed-vespa-test-data.ts
 *
 * Feeds 20 comprehensive wine documents to Vespa via the Document v1 API.
 * Connects to the test Vespa instance at http://localhost:18080 by default.
 *
 * Usage:
 *   tsx scripts/seed-vespa-test-data.ts
 *
 * Override the Vespa URL:
 *   VESPA_URL=http://localhost:18080 tsx scripts/seed-vespa-test-data.ts
 */

import { VespaClient } from '../src/infrastructure/vespa/vespa-client.js';
import { toVespaFields } from '../src/infrastructure/vespa/mapping.js';
import { createCanonicalEntityId } from '../src/domain/shared/types/entity-id.js';
import type { RetrievalDocument } from '../src/domain/retrieval/model/retrieval-document.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const VESPA_URL = process.env['VESPA_URL'] ?? 'http://localhost:18080';
const NAMESPACE = 'wine';
const APP_NAME = 'wine_entity';

// ── Deterministic pseudo-random embedding generator ───────────────────────────
// Seeded LCG so vectors are stable across runs without a dependency on a
// crypto library.  Dimension must match the Vespa schema (x[1024]).

const EMBEDDING_DIM = 1024;

function seededEmbedding(seed: number): readonly number[] {
  const vec: number[] = new Array(EMBEDDING_DIM) as number[];
  let s = seed;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    // 32-bit LCG (Numerical Recipes constants)
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    // Map [0, 2^32) → [-1, 1)
    vec[i] = (s / 0x80000000) - 1;
  }
  // L2-normalise so angular distance makes sense
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
  return vec.map((v) => v / norm);
}

// ── Seed documents ────────────────────────────────────────────────────────────

const SEED_DOCUMENTS: readonly RetrievalDocument[] = [
  // ── Red wines (10) ─────────────────────────────────────────────────────────

  {
    entityId: createCanonicalEntityId('opus-one-2018'),
    entityType: 'wine',
    canonicalLabel: 'Opus One 2018',
    aliasesIdentitySafe: ['Opus One 2018', 'opus one 2018'],
    aliasesNoisyRecall: ['오푸스원', '오퍼스 원', 'opus one'],
    producer: 'Opus One Winery',
    region: 'Napa Valley',
    grapes: ['Cabernet Sauvignon', 'Merlot', 'Cabernet Franc', 'Malbec', 'Petit Verdot'],
    searchTextKo: '오푸스원 2018 나파밸리 카베르네 소비뇽 블렌드 풀바디 드라이 레드 와인',
    searchTextEn: 'Opus One 2018 Napa Valley Cabernet Sauvignon blend full body dry red wine',
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
    embedding: seededEmbedding(1001),
  },
  {
    entityId: createCanonicalEntityId('chateau-margaux-2015'),
    entityType: 'wine',
    canonicalLabel: 'Château Margaux 2015',
    aliasesIdentitySafe: ['Château Margaux 2015', 'chateau margaux 2015'],
    aliasesNoisyRecall: ['마고', '샤토 마고', 'Chateau Margaux', 'margaux'],
    producer: 'Château Margaux',
    region: 'Bordeaux',
    grapes: ['Cabernet Sauvignon', 'Merlot', 'Cabernet Franc', 'Petit Verdot'],
    searchTextKo: '샤토 마고 2015 보르도 카베르네 소비뇽 풀바디 드라이 레드 와인 프리미어 그랑 크뤼',
    searchTextEn: 'Château Margaux 2015 Bordeaux Cabernet Sauvignon first growth Grand Cru full body dry',
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
    embedding: seededEmbedding(1002),
  },
  {
    entityId: createCanonicalEntityId('romanee-conti-2019'),
    entityType: 'wine',
    canonicalLabel: 'Romanée-Conti 2019',
    aliasesIdentitySafe: ['Romanée-Conti 2019', 'romanee-conti 2019'],
    aliasesNoisyRecall: ['DRC', '로마네꽁티', 'romanee conti'],
    producer: 'Domaine de la Romanée-Conti',
    region: 'Burgundy',
    grapes: ['Pinot Noir'],
    searchTextKo: '로마네 콩티 2019 부르고뉴 피노누아 미디엄바디 드라이 레드 와인',
    searchTextEn: 'Romanée-Conti 2019 Burgundy Pinot Noir medium body dry red wine DRC',
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
    embedding: seededEmbedding(1003),
  },
  {
    entityId: createCanonicalEntityId('sassicaia-2018'),
    entityType: 'wine',
    canonicalLabel: 'Sassicaia 2018',
    aliasesIdentitySafe: ['Sassicaia 2018', 'sassicaia 2018'],
    aliasesNoisyRecall: ['사시카이아', 'Sassicaia', 'bolgheri sassicaia'],
    producer: 'Tenuta San Guido',
    region: 'Tuscany',
    grapes: ['Cabernet Sauvignon', 'Cabernet Franc'],
    searchTextKo: '사시카이아 2018 토스카나 볼게리 카베르네 소비뇽 풀바디 드라이 슈퍼 투스칸',
    searchTextEn: 'Sassicaia 2018 Tuscany Bolgheri Cabernet Sauvignon Super Tuscan full body dry',
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
    embedding: seededEmbedding(1004),
  },
  {
    entityId: createCanonicalEntityId('penfolds-grange-2017'),
    entityType: 'wine',
    canonicalLabel: 'Penfolds Grange 2017',
    aliasesIdentitySafe: ['Penfolds Grange 2017', 'penfolds grange 2017'],
    aliasesNoisyRecall: ['펜폴즈 그레인지', 'Grange', 'grange hermitage'],
    producer: 'Penfolds',
    region: 'Barossa Valley',
    grapes: ['Shiraz', 'Cabernet Sauvignon'],
    searchTextKo: '펜폴즈 그레인지 2017 바로사 밸리 쉬라즈 매우 풀바디 드라이 레드 와인',
    searchTextEn: 'Penfolds Grange 2017 Barossa Valley Shiraz very full body bold dry red wine',
    semanticSummary:
      "Penfolds Grange is Australia's most iconic wine, a Shiraz-dominant blend of immense power and aging potential.",
    body: 0.95,
    sweetness: 0.1,
    style: 'bold red',
    priceBand: 'luxury',
    pairing: ['wagyu beef', 'barbecue', 'dark chocolate'],
    occasion: ['celebration', 'investment wine'],
    availability: true,
    popularityScore: 0.87,
    embedding: seededEmbedding(1005),
  },
  {
    entityId: createCanonicalEntityId('barolo-giacomo'),
    entityType: 'wine',
    canonicalLabel: 'Giacomo Conterno Barolo Monfortino',
    aliasesIdentitySafe: ['Giacomo Conterno Barolo Monfortino', 'barolo monfortino'],
    aliasesNoisyRecall: ['바롤로 자코모', 'Barolo Giacomo', 'barolo monfortino conterno'],
    producer: 'Giacomo Conterno',
    region: 'Piedmont',
    grapes: ['Nebbiolo'],
    searchTextKo: '자코모 콘테르노 바롤로 몬포르티노 피에몬테 네비올로 풀바디 드라이 강한 타닌',
    searchTextEn: 'Giacomo Conterno Barolo Monfortino Piedmont Nebbiolo full body dry strong tannin aged',
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
    embedding: seededEmbedding(1006),
  },
  {
    entityId: createCanonicalEntityId('masi-amarone'),
    entityType: 'wine',
    canonicalLabel: 'Masi Amarone della Valpolicella Classico',
    aliasesIdentitySafe: ['Masi Amarone della Valpolicella Classico', 'masi amarone'],
    aliasesNoisyRecall: ['마시 아마로네', 'Masi Amarone', 'amarone valpolicella', '아마로네'],
    producer: 'Masi Agricola',
    region: 'Veneto',
    grapes: ['Corvina', 'Rondinella', 'Molinara'],
    searchTextKo: '마시 아마로네 발폴리첼라 베네토 코르비나 풀바디 드라이 강렬한 레드 와인',
    searchTextEn: 'Masi Amarone della Valpolicella Veneto Corvina full body dry intense rich red wine',
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
    embedding: seededEmbedding(1007),
  },
  {
    entityId: createCanonicalEntityId('caymus-cabernet-2020'),
    entityType: 'wine',
    canonicalLabel: 'Caymus Cabernet Sauvignon 2020',
    aliasesIdentitySafe: ['Caymus Cabernet Sauvignon 2020', 'caymus 2020'],
    aliasesNoisyRecall: ['케이머스', '케이무스', 'Caymus Cabernet', 'caymus napa'],
    producer: 'Caymus Vineyards',
    region: 'Napa Valley',
    grapes: ['Cabernet Sauvignon'],
    searchTextKo: '케이머스 카베르네 소비뇽 2020 나파밸리 풀바디 드라이 레드 와인',
    searchTextEn: 'Caymus Cabernet Sauvignon 2020 Napa Valley full body dry red wine',
    semanticSummary:
      'Caymus Cabernet Sauvignon is a consistently rich and approachable Napa Valley red, beloved for its ripe fruit and velvety tannins.',
    body: 0.85,
    sweetness: 0.12,
    style: 'bold red',
    priceBand: 'premium',
    pairing: ['ribeye steak', 'lamb chops', 'blue cheese'],
    occasion: ['special dinner', 'date night'],
    availability: true,
    popularityScore: 0.84,
    embedding: seededEmbedding(1008),
  },
  {
    entityId: createCanonicalEntityId('silver-oak-cabernet-2018'),
    entityType: 'wine',
    canonicalLabel: 'Silver Oak Cabernet Sauvignon Alexander Valley 2018',
    aliasesIdentitySafe: ['Silver Oak Alexander Valley 2018', 'silver oak 2018'],
    aliasesNoisyRecall: ['실버 오크', 'Silver Oak Cabernet', 'silver oak alex valley'],
    producer: 'Silver Oak Cellars',
    region: 'Alexander Valley',
    grapes: ['Cabernet Sauvignon'],
    searchTextKo: '실버 오크 카베르네 소비뇽 알렉산더 밸리 2018 풀바디 드라이 레드 와인',
    searchTextEn: 'Silver Oak Cabernet Sauvignon Alexander Valley 2018 full body dry red wine Sonoma',
    semanticSummary:
      'Silver Oak Alexander Valley Cabernet Sauvignon is famed for its approachable style, American oak character, and consistent quality.',
    body: 0.8,
    sweetness: 0.1,
    style: 'bold red',
    priceBand: 'premium',
    pairing: ['grilled steak', 'BBQ ribs', 'cheddar'],
    occasion: ['casual dinner', 'gifting'],
    availability: true,
    popularityScore: 0.79,
    embedding: seededEmbedding(1009),
  },
  {
    entityId: createCanonicalEntityId('chateau-petrus-2016'),
    entityType: 'wine',
    canonicalLabel: 'Château Pétrus 2016',
    aliasesIdentitySafe: ['Château Pétrus 2016', 'chateau petrus 2016'],
    aliasesNoisyRecall: ['페트뤼스', 'Petrus 2016', '페트뤼스 2016'],
    producer: 'Château Pétrus',
    region: 'Pomerol',
    grapes: ['Merlot'],
    searchTextKo: '샤토 페트뤼스 2016 포므롤 메를로 풀바디 드라이 레드 와인 명품',
    searchTextEn: 'Château Pétrus 2016 Pomerol Merlot full body dry red wine prestige Bordeaux',
    semanticSummary:
      'Château Pétrus is one of the most coveted wines in the world, a near-pure Merlot from the Pomerol appellation of Bordeaux.',
    body: 0.9,
    sweetness: 0.08,
    style: 'bold red',
    priceBand: 'luxury',
    pairing: ['beef tenderloin', 'truffle risotto', 'foie gras'],
    occasion: ['once in a lifetime', 'investment'],
    availability: false,
    popularityScore: 0.92,
    embedding: seededEmbedding(1010),
  },

  // ── White wines (3) ────────────────────────────────────────────────────────

  {
    entityId: createCanonicalEntityId('cloudy-bay-2022'),
    entityType: 'wine',
    canonicalLabel: 'Cloudy Bay Sauvignon Blanc 2022',
    aliasesIdentitySafe: ['Cloudy Bay Sauvignon Blanc 2022', 'cloudy bay 2022'],
    aliasesNoisyRecall: ['클라우디베이', '클라우디 베이', 'Cloudy Bay', 'cloudy bay sauvignon'],
    producer: 'Cloudy Bay Vineyards',
    region: 'Marlborough',
    grapes: ['Sauvignon Blanc'],
    searchTextKo: '클라우디 베이 소비뇽 블랑 2022 말보로 가볍고 상큼한 드라이 화이트 와인',
    searchTextEn: 'Cloudy Bay Sauvignon Blanc 2022 Marlborough New Zealand crisp light dry white wine',
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
    embedding: seededEmbedding(2001),
  },
  {
    entityId: createCanonicalEntityId('sauternes-2015'),
    entityType: 'wine',
    canonicalLabel: "Château d'Yquem Sauternes 2015",
    aliasesIdentitySafe: ["Château d'Yquem Sauternes 2015", "chateau d'yquem 2015"],
    aliasesNoisyRecall: ['이켐', "d'Yquem", 'yquem sauternes', '달달한 와인', '디저트 와인'],
    producer: "Château d'Yquem",
    region: 'Bordeaux',
    grapes: ['Sémillon', 'Sauvignon Blanc'],
    searchTextKo: '샤토 디켐 소테른 2015 보르도 스위트 달달한 디저트 화이트 와인',
    searchTextEn: "Château d'Yquem Sauternes 2015 Bordeaux sweet dessert white wine botrytis",
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
    embedding: seededEmbedding(2002),
  },
  {
    entityId: createCanonicalEntityId('pouilly-fume-dagueneau-2019'),
    entityType: 'wine',
    canonicalLabel: 'Didier Dagueneau Pouilly-Fumé Silex 2019',
    aliasesIdentitySafe: ['Dagueneau Pouilly-Fumé Silex 2019', 'dagueneau silex 2019'],
    aliasesNoisyRecall: ['다기노 푸이 퓌메', 'Silex Dagueneau', '푸이 퓌메 실렉스'],
    producer: 'Domaine Didier Dagueneau',
    region: 'Loire Valley',
    grapes: ['Sauvignon Blanc'],
    searchTextKo: '다기노 푸이 퓌메 실렉스 2019 루아르 소비뇽 블랑 미디엄바디 드라이 화이트 와인',
    searchTextEn: 'Didier Dagueneau Pouilly-Fumé Silex 2019 Loire Valley Sauvignon Blanc medium body dry white wine',
    semanticSummary:
      'Didier Dagueneau Pouilly-Fumé Silex is a benchmark Loire Sauvignon Blanc of remarkable minerality and complexity.',
    body: 0.4,
    sweetness: 0.05,
    style: 'crisp white',
    priceBand: 'premium',
    pairing: ['oysters', 'grilled fish', 'chèvre'],
    occasion: ['casual dinner', 'summer lunch'],
    availability: true,
    popularityScore: 0.72,
    embedding: seededEmbedding(2003),
  },

  // ── Sparkling wines (2) ────────────────────────────────────────────────────

  {
    entityId: createCanonicalEntityId('moet-brut'),
    entityType: 'wine',
    canonicalLabel: 'Moët & Chandon Brut Impérial',
    aliasesIdentitySafe: ["Moët & Chandon Brut Impérial", 'moet & chandon brut imperial'],
    aliasesNoisyRecall: ['모에 샹동', '모엣', 'Moet Brut', 'moet chandon', '스파클링'],
    producer: 'Moët & Chandon',
    region: 'Champagne',
    grapes: ['Chardonnay', 'Pinot Noir', 'Pinot Meunier'],
    searchTextKo: '모에 샹동 브뤼 임페리얼 샴페인 스파클링 드라이 와인 축하 파티',
    searchTextEn: 'Moët & Chandon Brut Impérial Champagne sparkling dry wine celebration party',
    semanticSummary:
      "Moët & Chandon Brut Impérial is the world's most popular Champagne, a fresh and vibrant sparkling wine perfect for celebrations.",
    body: 0.3,
    sweetness: 0.1,
    style: 'sparkling',
    priceBand: 'mid',
    pairing: ['oysters', 'sushi', 'light appetizers'],
    occasion: ['celebration', 'party', 'wedding'],
    availability: true,
    popularityScore: 0.90,
    embedding: seededEmbedding(3001),
  },
  {
    entityId: createCanonicalEntityId('dom-perignon-2013'),
    entityType: 'wine',
    canonicalLabel: 'Dom Pérignon 2013',
    aliasesIdentitySafe: ['Dom Pérignon 2013', 'dom perignon 2013'],
    aliasesNoisyRecall: ['돔 페리뇽', '돔페리뇽', 'Dom Perignon', '돔페리'],
    producer: 'Dom Pérignon',
    region: 'Champagne',
    grapes: ['Chardonnay', 'Pinot Noir'],
    searchTextKo: '돔 페리뇽 2013 샴페인 프레스티지 퀴베 스파클링 드라이 와인',
    searchTextEn: 'Dom Pérignon 2013 Champagne prestige cuvée sparkling dry wine vintage',
    semanticSummary:
      'Dom Pérignon is the iconic vintage prestige cuvée from Moët & Chandon, renowned for its complexity and aging potential.',
    body: 0.3,
    sweetness: 0.1,
    style: 'sparkling',
    priceBand: 'luxury',
    pairing: ['caviar', 'lobster', 'truffle dishes'],
    occasion: ['celebration', 'luxury event', 'wedding'],
    availability: true,
    popularityScore: 0.89,
    embedding: seededEmbedding(3002),
  },

  // ── Additional red wines to reach 20 total (5 more) ───────────────────────

  {
    entityId: createCanonicalEntityId('screaming-eagle-2019'),
    entityType: 'wine',
    canonicalLabel: 'Screaming Eagle Cabernet Sauvignon 2019',
    aliasesIdentitySafe: ['Screaming Eagle 2019', 'screaming eagle 2019'],
    aliasesNoisyRecall: ['스크리밍 이글', 'Screaming Eagle Cab', '스크리밍이글'],
    producer: 'Screaming Eagle Winery',
    region: 'Napa Valley',
    grapes: ['Cabernet Sauvignon', 'Merlot', 'Cabernet Franc'],
    searchTextKo: '스크리밍 이글 카베르네 소비뇽 2019 나파밸리 풀바디 드라이 컬트 레드 와인',
    searchTextEn: 'Screaming Eagle Cabernet Sauvignon 2019 Napa Valley full body dry cult red wine',
    semanticSummary:
      'Screaming Eagle is one of the most sought-after cult wines from Napa Valley, produced in tiny quantities with extraordinary concentration.',
    body: 0.9,
    sweetness: 0.08,
    style: 'bold red',
    priceBand: 'luxury',
    pairing: ['prime beef', 'lamb rack', 'truffle'],
    occasion: ['once in a lifetime', 'investment'],
    availability: false,
    popularityScore: 0.90,
    embedding: seededEmbedding(1011),
  },
  {
    entityId: createCanonicalEntityId('harlan-estate-2018'),
    entityType: 'wine',
    canonicalLabel: 'Harlan Estate 2018',
    aliasesIdentitySafe: ['Harlan Estate 2018', 'harlan estate 2018'],
    aliasesNoisyRecall: ['할란 에스테이트', 'Harlan 2018', '할란'],
    producer: 'Harlan Estate',
    region: 'Napa Valley',
    grapes: ['Cabernet Sauvignon', 'Merlot', 'Cabernet Franc', 'Petit Verdot'],
    searchTextKo: '할란 에스테이트 2018 나파밸리 카베르네 소비뇽 블렌드 풀바디 드라이 컬트 레드 와인',
    searchTextEn: 'Harlan Estate 2018 Napa Valley Cabernet Sauvignon blend full body dry cult red wine',
    semanticSummary:
      'Harlan Estate is a highly coveted Napa Valley cult wine, a Cabernet-dominant blend of profound depth and structure.',
    body: 0.88,
    sweetness: 0.1,
    style: 'bold red',
    priceBand: 'luxury',
    pairing: ['dry-aged steak', 'venison', 'hard aged cheese'],
    occasion: ['investment wine', 'special dinner'],
    availability: false,
    popularityScore: 0.86,
    embedding: seededEmbedding(1012),
  },
  {
    entityId: createCanonicalEntityId('ridge-monte-bello-2017'),
    entityType: 'wine',
    canonicalLabel: 'Ridge Monte Bello 2017',
    aliasesIdentitySafe: ['Ridge Monte Bello 2017', 'ridge monte bello 2017'],
    aliasesNoisyRecall: ['리지 몬테 벨로', 'Monte Bello Ridge', 'ridge vineyards monte bello'],
    producer: 'Ridge Vineyards',
    region: 'Santa Cruz Mountains',
    grapes: ['Cabernet Sauvignon', 'Merlot', 'Petit Verdot', 'Cabernet Franc'],
    searchTextKo: '리지 몬테 벨로 2017 산타크루즈 마운틴 카베르네 소비뇽 블렌드 풀바디 드라이 레드 와인',
    searchTextEn: 'Ridge Monte Bello 2017 Santa Cruz Mountains Cabernet Sauvignon blend full body dry red wine California',
    semanticSummary:
      'Ridge Monte Bello is a landmark California Cabernet blend from the Santa Cruz Mountains, celebrated for its Bordeaux-like structure and longevity.',
    body: 0.82,
    sweetness: 0.07,
    style: 'bold red',
    priceBand: 'luxury',
    pairing: ['roasted lamb', 'beef tenderloin', 'walnuts and cheese'],
    occasion: ['special dinner', 'investment wine'],
    availability: true,
    popularityScore: 0.76,
    embedding: seededEmbedding(1013),
  },
  {
    entityId: createCanonicalEntityId('guado-al-tasso-2019'),
    entityType: 'wine',
    canonicalLabel: 'Guado al Tasso 2019',
    aliasesIdentitySafe: ['Guado al Tasso 2019', 'guado al tasso 2019'],
    aliasesNoisyRecall: ['구아도 알 타소', 'Guado al Tasso Antinori', '구아도알타소'],
    producer: 'Antinori',
    region: 'Tuscany',
    grapes: ['Cabernet Sauvignon', 'Merlot', 'Syrah'],
    searchTextKo: '구아도 알 타소 2019 토스카나 볼게리 카베르네 소비뇽 풀바디 드라이 슈퍼 투스칸',
    searchTextEn: 'Guado al Tasso 2019 Tuscany Bolgheri Cabernet Sauvignon Merlot Super Tuscan full body dry red',
    semanticSummary:
      'Guado al Tasso is Antinori\'s flagship Super Tuscan from Bolgheri, a powerful Cabernet-Merlot blend of great elegance.',
    body: 0.83,
    sweetness: 0.07,
    style: 'bold red',
    priceBand: 'premium',
    pairing: ['grilled red meat', 'aged pecorino', 'wild boar'],
    occasion: ['special dinner', 'gifting'],
    availability: true,
    popularityScore: 0.73,
    embedding: seededEmbedding(1014),
  },
  {
    entityId: createCanonicalEntityId('dominus-estate-2016'),
    entityType: 'wine',
    canonicalLabel: 'Dominus Estate 2016',
    aliasesIdentitySafe: ['Dominus Estate 2016', 'dominus estate 2016'],
    aliasesNoisyRecall: ['도미누스', 'Dominus 2016', '도미너스 에스테이트'],
    producer: 'Dominus Estate',
    region: 'Napa Valley',
    grapes: ['Cabernet Sauvignon', 'Cabernet Franc', 'Petit Verdot'],
    searchTextKo: '도미누스 에스테이트 2016 나파밸리 카베르네 소비뇽 블렌드 풀바디 드라이 레드 와인',
    searchTextEn: 'Dominus Estate 2016 Napa Valley Cabernet Sauvignon blend full body dry red wine Yountville',
    semanticSummary:
      'Dominus Estate is a benchmark Napa Valley Cabernet blend crafted by Christian Moueix of Pétrus fame, combining Old and New World sensibilities.',
    body: 0.87,
    sweetness: 0.08,
    style: 'bold red',
    priceBand: 'luxury',
    pairing: ['lamb rack', 'duck breast', 'strong cheese'],
    occasion: ['special dinner', 'celebration'],
    availability: true,
    popularityScore: 0.77,
    embedding: seededEmbedding(1015),
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Connecting to Vespa at ${VESPA_URL} ...`);
  const client = new VespaClient(VESPA_URL, NAMESPACE, APP_NAME);

  const total = SEED_DOCUMENTS.length;
  console.log(`Feeding ${total} wine documents ...`);

  let successCount = 0;
  let failureCount = 0;

  for (const doc of SEED_DOCUMENTS) {
    const fields = toVespaFields(doc);
    try {
      await client.put(doc.entityId, fields);
      successCount++;
      process.stdout.write(`  [OK] ${doc.canonicalLabel}\n`);
    } catch (err) {
      failureCount++;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  [FAIL] ${doc.canonicalLabel}: ${message}\n`);
    }
  }

  console.log('');
  console.log(`Done. Success: ${successCount}/${total}  Failures: ${failureCount}/${total}`);

  if (failureCount > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${message}`);
  process.exit(1);
});

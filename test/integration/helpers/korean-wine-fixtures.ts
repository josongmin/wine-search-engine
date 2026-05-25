/**
 * Korea-market wine catalog for the Korean KIL benchmark.
 *
 * Distinct from the shared 10-entity `test-fixtures.ts` corpus: this one is
 * built around wines that are *actually high-volume or famous in Korea*
 * (mass-market best-sellers like 1865 / 몬테스 알파 / 카시예로 델 디아블로,
 * the 5대 샤토, Super Tuscans, popular Champagnes, and the premium Napa
 * names Korean buyers search for). It is injected into `createTestContainer`
 * via `fixtureDocuments` / `fixtureAliases` so it never perturbs the shared
 * default fixture (blast radius = the Korean benchmark only).
 *
 * Each seed registers realistic Korean alias surface forms — those drive the
 * alias matcher, so the benchmark's noise variants (spacing, IME jamo,
 * loanword spelling, vintage glue, …) resolve through the same pipeline a
 * production query would hit.
 */
import { createEntityId, type EntityId } from '../../../src/domain/shared/types/index.js';
import type { RetrievalDocument } from '../../../src/domain/retrieval/model/retrieval-document.js';
import type { TestFixtureAlias } from './test-container.js';

interface KoWineSeed {
  readonly id: string;
  /** English canonical label. */
  readonly canonical: string;
  readonly producer: string;
  readonly region: string;
  readonly country: string;
  readonly grapes: readonly string[];
  readonly vintage?: number;
  readonly priceBand: 'value' | 'mid' | 'premium' | 'luxury';
  readonly style: string;
  readonly popularity: number;
  /** Korean surface forms to register as aliases (primary first). */
  readonly koAliases: readonly string[];
  /** Optional English alias surfaces (in addition to the canonical label). */
  readonly enAliases?: readonly string[];
}

/**
 * Korea-famous / best-selling wine seeds.
 *
 * The list mixes two market tiers:
 *  - mass-market best-sellers (1865, 몬테스 알파, 카시예로 델 디아블로,
 *    옐로우테일, 빌라엠, 모스카토 다스티, 제이콥스 크릭, 베린저) — these
 *    dominate Korean retail volume
 *  - famous premium (5대 샤토, 슈퍼투스칸, 돔페리뇽/뵈브클리코, 케이머스,
 *    실버오크, 펜폴즈, 가야, DRC, 디켐) — high search frequency in Korea
 */
const KO_WINE_SEEDS: readonly KoWineSeed[] = [
  // ── Mass-market best-sellers (Korea) ──────────────────────────────────
  {
    id: '1865-cabernet-sauvignon',
    canonical: '1865 Cabernet Sauvignon',
    producer: 'San Pedro',
    region: 'Maipo Valley',
    country: 'Chile',
    grapes: ['Cabernet Sauvignon'],
    priceBand: 'value',
    style: 'bold red',
    popularity: 0.99,
    koAliases: ['1865', '천팔백육십오', '일팔육오', '1865 까베르네', '1865 카베르네 소비뇽', '1865 카베르네'],
    enAliases: ['1865 Cab'],
  },
  {
    id: 'montes-alpha-cabernet',
    canonical: 'Montes Alpha Cabernet Sauvignon',
    producer: 'Montes',
    region: 'Colchagua Valley',
    country: 'Chile',
    grapes: ['Cabernet Sauvignon'],
    priceBand: 'mid',
    style: 'bold red',
    popularity: 0.97,
    koAliases: ['몬테스 알파', '몬테스알파', '몬테스 알파 카베르네', '몬테스'],
    enAliases: ['Montes Alpha'],
  },
  {
    id: 'casillero-del-diablo-cabernet',
    canonical: 'Casillero del Diablo Cabernet Sauvignon',
    producer: 'Concha y Toro',
    region: 'Central Valley',
    country: 'Chile',
    grapes: ['Cabernet Sauvignon'],
    priceBand: 'value',
    style: 'medium red',
    popularity: 0.95,
    koAliases: ['카시예로 델 디아블로', '카시예로델디아블로', '디아블로', '악마의 와인', '까시예로 델 디아블로'],
    enAliases: ['Casillero del Diablo'],
  },
  {
    id: 'yellow-tail-shiraz',
    canonical: 'Yellow Tail Shiraz',
    producer: 'Casella Family Brands',
    region: 'South Eastern Australia',
    country: 'Australia',
    grapes: ['Shiraz'],
    priceBand: 'value',
    style: 'bold red',
    popularity: 0.92,
    koAliases: ['옐로우 테일', '옐로우테일', '옐로테일', '노란 캥거루', '옐로우 테일 시라즈'],
    enAliases: ['Yellow Tail'],
  },
  {
    id: 'villa-m-rosso',
    canonical: 'Villa M Rosso',
    producer: 'Fontanafredda',
    region: 'Piedmont',
    country: 'Italy',
    grapes: ['Brachetto', 'Malvasia'],
    priceBand: 'value',
    style: 'sweet red sparkling',
    popularity: 0.93,
    koAliases: ['빌라엠', '빌라 엠', '빌라엠 로쏘', '빌라엠 레드'],
    enAliases: ['Villa M'],
  },
  {
    id: 'moscato-dasti-saracco',
    canonical: "Saracco Moscato d'Asti",
    producer: 'Paolo Saracco',
    region: 'Piedmont',
    country: 'Italy',
    grapes: ['Moscato Bianco'],
    priceBand: 'value',
    style: 'sweet white sparkling',
    popularity: 0.9,
    koAliases: ['모스카토 다스티', '모스카토다스티', '모스카토', '사라코 모스카토'],
    enAliases: ["Moscato d'Asti"],
  },
  {
    id: 'jacobs-creek-shiraz',
    canonical: "Jacob's Creek Shiraz",
    producer: "Jacob's Creek",
    region: 'South Australia',
    country: 'Australia',
    grapes: ['Shiraz'],
    priceBand: 'value',
    style: 'medium red',
    popularity: 0.88,
    koAliases: ['제이콥스 크릭', '제이콥스크릭', '야곱의 시내', '제이콥스 크릭 시라즈'],
    enAliases: ["Jacob's Creek"],
  },
  {
    id: 'beringer-white-zinfandel',
    canonical: 'Beringer White Zinfandel',
    producer: 'Beringer',
    region: 'California',
    country: 'United States',
    grapes: ['Zinfandel'],
    priceBand: 'value',
    style: 'sweet rose',
    popularity: 0.85,
    koAliases: ['베린저', '베린저 화이트 진판델', '베린저 화이트진판델'],
    enAliases: ['Beringer'],
  },
  // ── Famous premium (Korea high-search) ────────────────────────────────
  {
    id: 'opus-one-2018',
    canonical: 'Opus One 2018',
    producer: 'Opus One Winery',
    region: 'Napa Valley',
    country: 'United States',
    grapes: ['Cabernet Sauvignon', 'Merlot'],
    vintage: 2018,
    priceBand: 'luxury',
    style: 'bold red',
    popularity: 0.96,
    koAliases: ['오푸스 원', '오푸스원', '오퍼스 원', '오퍼스원'],
    enAliases: ['Opus One'],
  },
  {
    id: 'caymus-cabernet',
    canonical: 'Caymus Cabernet Sauvignon',
    producer: 'Caymus Vineyards',
    region: 'Napa Valley',
    country: 'United States',
    grapes: ['Cabernet Sauvignon'],
    priceBand: 'premium',
    style: 'bold red',
    popularity: 0.94,
    koAliases: ['케이머스', '케이머스 카베르네', '케이머스 까베르네', '카이무스'],
    enAliases: ['Caymus'],
  },
  {
    id: 'silver-oak-cabernet',
    canonical: 'Silver Oak Cabernet Sauvignon',
    producer: 'Silver Oak',
    region: 'Alexander Valley',
    country: 'United States',
    grapes: ['Cabernet Sauvignon'],
    priceBand: 'premium',
    style: 'bold red',
    popularity: 0.9,
    koAliases: ['실버 오크', '실버오크', '실버 오크 카베르네'],
    enAliases: ['Silver Oak'],
  },
  {
    id: 'chateau-margaux-2015',
    canonical: 'Château Margaux 2015',
    producer: 'Château Margaux',
    region: 'Bordeaux',
    country: 'France',
    grapes: ['Cabernet Sauvignon', 'Merlot'],
    vintage: 2015,
    priceBand: 'luxury',
    style: 'bold red',
    popularity: 0.95,
    koAliases: ['샤토 마고', '샤또 마고', '마고'],
    enAliases: ['Chateau Margaux', 'Margaux'],
  },
  {
    id: 'chateau-lafite-rothschild-2016',
    canonical: 'Château Lafite Rothschild 2016',
    producer: 'Château Lafite Rothschild',
    region: 'Bordeaux',
    country: 'France',
    grapes: ['Cabernet Sauvignon', 'Merlot'],
    vintage: 2016,
    priceBand: 'luxury',
    style: 'bold red',
    popularity: 0.95,
    koAliases: ['샤토 라피트', '샤또 라피트', '라피트', '라피트 로칠드', '샤토 라피트 로칠드'],
    enAliases: ['Chateau Lafite', 'Lafite'],
  },
  {
    id: 'chateau-latour-2016',
    canonical: 'Château Latour 2016',
    producer: 'Château Latour',
    region: 'Bordeaux',
    country: 'France',
    grapes: ['Cabernet Sauvignon', 'Merlot'],
    vintage: 2016,
    priceBand: 'luxury',
    style: 'bold red',
    popularity: 0.93,
    koAliases: ['샤토 라투르', '샤또 라뚜르', '라투르', '라뚜르'],
    enAliases: ['Chateau Latour', 'Latour'],
  },
  {
    id: 'chateau-mouton-rothschild-2016',
    canonical: 'Château Mouton Rothschild 2016',
    producer: 'Château Mouton Rothschild',
    region: 'Bordeaux',
    country: 'France',
    grapes: ['Cabernet Sauvignon', 'Merlot'],
    vintage: 2016,
    priceBand: 'luxury',
    style: 'bold red',
    popularity: 0.93,
    koAliases: ['샤토 무통', '샤또 무똥', '무통 로칠드', '무통', '무똥'],
    enAliases: ['Chateau Mouton', 'Mouton Rothschild'],
  },
  {
    id: 'sassicaia-2018',
    canonical: 'Sassicaia 2018',
    producer: 'Tenuta San Guido',
    region: 'Tuscany',
    country: 'Italy',
    grapes: ['Cabernet Sauvignon', 'Cabernet Franc'],
    vintage: 2018,
    priceBand: 'luxury',
    style: 'bold red',
    popularity: 0.9,
    koAliases: ['사시카이아', '사씨카이아', '사시카이아 2018'],
    enAliases: ['Sassicaia'],
  },
  {
    id: 'tignanello-antinori',
    canonical: 'Antinori Tignanello',
    producer: 'Marchesi Antinori',
    region: 'Tuscany',
    country: 'Italy',
    grapes: ['Sangiovese', 'Cabernet Sauvignon'],
    priceBand: 'premium',
    style: 'bold red',
    popularity: 0.89,
    koAliases: ['티냐넬로', '안티노리 티냐넬로', '티그나넬로'],
    enAliases: ['Tignanello'],
  },
  {
    id: 'solaia-antinori',
    canonical: 'Antinori Solaia',
    producer: 'Marchesi Antinori',
    region: 'Tuscany',
    country: 'Italy',
    grapes: ['Cabernet Sauvignon', 'Sangiovese'],
    priceBand: 'luxury',
    style: 'bold red',
    popularity: 0.86,
    koAliases: ['솔라이아', '안티노리 솔라이아'],
    enAliases: ['Solaia'],
  },
  {
    id: 'penfolds-grange-2017',
    canonical: 'Penfolds Grange 2017',
    producer: 'Penfolds',
    region: 'Barossa Valley',
    country: 'Australia',
    grapes: ['Shiraz'],
    vintage: 2017,
    priceBand: 'luxury',
    style: 'bold red',
    popularity: 0.88,
    koAliases: ['펜폴즈 그레인지', '펜폴스 그레인지', '그레인지', '펜폴즈'],
    enAliases: ['Penfolds Grange', 'Grange'],
  },
  {
    id: 'penfolds-bin-389',
    canonical: 'Penfolds Bin 389 Cabernet Shiraz',
    producer: 'Penfolds',
    region: 'South Australia',
    country: 'Australia',
    grapes: ['Cabernet Sauvignon', 'Shiraz'],
    priceBand: 'premium',
    style: 'bold red',
    popularity: 0.87,
    koAliases: ['펜폴즈 빈 389', '빈 389', '펜폴즈 389', '빈389'],
    enAliases: ['Penfolds Bin 389', 'Bin 389'],
  },
  {
    id: 'kendall-jackson-chardonnay',
    canonical: 'Kendall-Jackson Vintner\'s Reserve Chardonnay',
    producer: 'Kendall-Jackson',
    region: 'California',
    country: 'United States',
    grapes: ['Chardonnay'],
    priceBand: 'mid',
    style: 'rich white',
    popularity: 0.84,
    koAliases: ['켄달 잭슨', '켄달잭슨', '켄달 잭슨 샤르도네'],
    enAliases: ['Kendall-Jackson'],
  },
  {
    id: 'cloudy-bay-2022',
    canonical: 'Cloudy Bay Sauvignon Blanc 2022',
    producer: 'Cloudy Bay Vineyards',
    region: 'Marlborough',
    country: 'New Zealand',
    grapes: ['Sauvignon Blanc'],
    vintage: 2022,
    priceBand: 'mid',
    style: 'crisp white',
    popularity: 0.85,
    koAliases: ['클라우디 베이', '클라우디베이', '클라우디'],
    enAliases: ['Cloudy Bay'],
  },
  {
    id: 'moet-brut',
    canonical: 'Moët & Chandon Brut Impérial',
    producer: 'Moët & Chandon',
    region: 'Champagne',
    country: 'France',
    grapes: ['Chardonnay', 'Pinot Noir', 'Pinot Meunier'],
    priceBand: 'mid',
    style: 'sparkling',
    popularity: 0.92,
    koAliases: ['모에 샹동', '모엣 샹동', '모에', '모엣', '모엣 샹동 브뤼'],
    enAliases: ['Moet Chandon', 'Moet'],
  },
  {
    id: 'dom-perignon',
    canonical: 'Dom Pérignon Vintage',
    producer: 'Moët & Chandon',
    region: 'Champagne',
    country: 'France',
    grapes: ['Chardonnay', 'Pinot Noir'],
    priceBand: 'luxury',
    style: 'sparkling',
    popularity: 0.94,
    koAliases: ['돔 페리뇽', '돔페리뇽', '돔 페리뇸', '돔페리뇨'],
    enAliases: ['Dom Perignon'],
  },
  {
    id: 'veuve-clicquot-yellow-label',
    canonical: 'Veuve Clicquot Yellow Label Brut',
    producer: 'Veuve Clicquot',
    region: 'Champagne',
    country: 'France',
    grapes: ['Pinot Noir', 'Chardonnay', 'Pinot Meunier'],
    priceBand: 'mid',
    style: 'sparkling',
    popularity: 0.9,
    koAliases: ['뵈브 클리코', '뵈브클리코', '뵈브 클리꼬', '클리코', '베브 클리코'],
    enAliases: ['Veuve Clicquot'],
  },
  {
    id: 'romanee-conti-2015',
    canonical: 'Romanée-Conti 2015',
    producer: 'Domaine de la Romanée-Conti',
    region: 'Burgundy',
    country: 'France',
    grapes: ['Pinot Noir'],
    vintage: 2015,
    priceBand: 'luxury',
    style: 'light red',
    popularity: 0.95,
    koAliases: ['로마네 콩티', '로마네콩티', '로마네 꽁띠', '로마네꽁띠', '로마네 꼰띠'],
    enAliases: ['Romanee-Conti', 'DRC'],
  },
  {
    id: 'sauternes-2015',
    canonical: "Château d'Yquem Sauternes 2015",
    producer: "Château d'Yquem",
    region: 'Bordeaux',
    country: 'France',
    grapes: ['Sémillon', 'Sauvignon Blanc'],
    vintage: 2015,
    priceBand: 'luxury',
    style: 'sweet white',
    popularity: 0.85,
    koAliases: ['샤토 디켐', '샤또 디켐', '디켐', '이켐'],
    enAliases: ["Chateau d'Yquem", "d'Yquem"],
  },
  {
    id: 'barolo-giacomo',
    canonical: 'Giacomo Conterno Barolo Monfortino',
    producer: 'Giacomo Conterno',
    region: 'Piedmont',
    country: 'Italy',
    grapes: ['Nebbiolo'],
    priceBand: 'luxury',
    style: 'bold red',
    popularity: 0.83,
    koAliases: ['바롤로 자코모', '바롤로 몬포르티노', '자코모 콘테르노', '바롤로'],
    enAliases: ['Barolo Monfortino', 'Giacomo Conterno'],
  },
  {
    id: 'masi-amarone',
    canonical: 'Masi Amarone della Valpolicella Classico',
    producer: 'Masi Agricola',
    region: 'Veneto',
    country: 'Italy',
    grapes: ['Corvina', 'Rondinella'],
    priceBand: 'premium',
    style: 'bold red',
    popularity: 0.8,
    koAliases: ['마시 아마로네', '마시아마로네', '아마로네', '마시'],
    enAliases: ['Masi Amarone', 'Amarone'],
  },
  {
    id: 'gaja-barbaresco',
    canonical: 'Gaja Barbaresco',
    producer: 'Gaja',
    region: 'Piedmont',
    country: 'Italy',
    grapes: ['Nebbiolo'],
    priceBand: 'luxury',
    style: 'bold red',
    popularity: 0.84,
    koAliases: ['가야 바르바레스코', '가야', '바르바레스코', '가야 바르바레스꼬'],
    enAliases: ['Gaja Barbaresco', 'Gaja'],
  },
];

const PRICE_BAND_NUMERIC: Readonly<Record<KoWineSeed['priceBand'], number>> = {
  value: 0.2,
  mid: 0.45,
  premium: 0.7,
  luxury: 0.95,
};

function entityIdFor(seed: KoWineSeed): EntityId {
  return createEntityId(seed.id);
}

function makeDoc(seed: KoWineSeed): RetrievalDocument {
  const koAliasText = seed.koAliases.join(' ');
  const enAliasText = [seed.canonical, ...(seed.enAliases ?? [])].join(' ');
  return {
    entityId: entityIdFor(seed),
    entityType: 'wine',
    canonicalLabel: seed.canonical,
    aliasesIdentitySafe: [seed.canonical, ...(seed.enAliases ?? [])],
    aliasesNoisyRecall: [...seed.koAliases],
    producer: seed.producer,
    region: seed.region,
    grapes: [...seed.grapes],
    searchTextKo: `${koAliasText} ${seed.region} ${seed.grapes.join(' ')}`,
    searchTextEn: `${enAliasText} ${seed.region} ${seed.country} ${seed.grapes.join(' ')}`,
    semanticSummary: `${seed.canonical} — ${seed.producer}, ${seed.region}, ${seed.country}.`,
    style: seed.style,
    priceBand: seed.priceBand,
    pairing: ['beef', 'cheese'],
    availability: true,
    popularityScore: seed.popularity,
    grapePrimary: seed.grapes[0] ?? '',
    country: seed.country,
    wineType: seed.style.includes('white')
      ? 'white'
      : seed.style.includes('sparkling')
        ? 'sparkling'
        : seed.style.includes('rose')
          ? 'rose'
          : 'red',
    priceBandNumeric: PRICE_BAND_NUMERIC[seed.priceBand],
    ...(seed.vintage !== undefined ? { vintageYear: seed.vintage } : {}),
  };
}

function makeAliases(seed: KoWineSeed): TestFixtureAlias[] {
  const entityId = entityIdFor(seed);
  const aliases: TestFixtureAlias[] = [];
  // Canonical label (English) — highest confidence.
  aliases.push({ surfaceForm: seed.canonical, entityId, confidence: 1.0 });
  // Korean aliases: first is primary (curated, high), rest are variants.
  seed.koAliases.forEach((surface, index) => {
    aliases.push({ surfaceForm: surface, entityId, confidence: index === 0 ? 0.96 : 0.9 });
  });
  for (const en of seed.enAliases ?? []) {
    aliases.push({ surfaceForm: en, entityId, confidence: 0.92 });
  }
  return aliases;
}

/** RetrievalDocuments for the Korea-market catalog. */
export const KOREAN_WINE_DOCUMENTS: readonly RetrievalDocument[] = KO_WINE_SEEDS.map(makeDoc);

/** Curated alias surfaces for the Korea-market catalog. */
export const KOREAN_WINE_ALIASES: readonly TestFixtureAlias[] = KO_WINE_SEEDS.flatMap(makeAliases);

/** Stable entity-id list (for assertions / introspection). */
const _KOREAN_WINE_ENTITY_IDS: readonly EntityId[] = KO_WINE_SEEDS.map(entityIdFor);

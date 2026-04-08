/**
 * Coverage-expansion scenarios — fills gaps identified in benchmark audit.
 *
 * New tiers:
 *   - wine_name_lookup   (real-world #1 query type: brand/producer/label search)
 *   - taste_descriptor    (sensory/aroma/flavor-driven search)
 *   - rating_score        (critic score / platform rating based)
 *   - wine_type_basic     (rosé, sparkling, dessert, orange, fortified)
 *   - negation_complex    (multi-negation, double exclusion)
 *   - arithmetic_query    (per-person budget, quantity calc, ratio)
 *   - bilingual_mixed     (English + Korean mixed queries)
 *   - cellar_aging        (aging potential, drinking window, cellaring)
 *
 * IDs start at 200 to avoid collision with existing 1-116 + phase2.
 */

import type { AgentBenchmarkScenario } from './scenario.js';

export const COVERAGE_SCENARIOS: readonly AgentBenchmarkScenario[] = [
  // ═══════════════════════════════════════════════════════════════════════
  // wine_name_lookup — 실사용 #1 (30-35% of real queries)
  // ═══════════════════════════════════════════════════════════════════════

  {
    id: 200,
    tier: 'wine_name_lookup',
    query: 'Sassicaia',
    description: 'Single producer name, no vintage',
    expectation: {
      tools: [{ tool: 'search_wines', inputContains: ['Sassicaia'] }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(sassicaia|사시카이아)'],
      rubric:
        'Must return information about Sassicaia (Tenuta San Guido). '
        + 'Should include region (Bolgheri) and general character.',
    },
  },
  {
    id: 201,
    tier: 'wine_name_lookup',
    query: 'DRC 가격 알려줘',
    description: 'Abbreviation: DRC = Domaine de la Romanée-Conti',
    expectation: {
      tools: [{ tool: 'search_wines', inputContains: ['Romanée-Conti'] }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(romanée|romanee|로마네\\s*콩티|DRC)'],
      rubric:
        'Must resolve DRC to Domaine de la Romanée-Conti. '
        + 'Price info or range expected. Must not confuse with another producer.',
    },
  },
  {
    id: 202,
    tier: 'wine_name_lookup',
    query: '페트뤼스 어떤 와인이야?',
    description: 'Korean transliteration: 페트뤼스 = Pétrus',
    expectation: {
      tools: [{ tool: 'search_wines', inputContains: ['Pétrus'] }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(pétrus|petrus|페트뤼스)'],
      rubric:
        'Must resolve 페트뤼스 to Pétrus (Pomerol, Bordeaux). '
        + 'Should mention Merlot dominance and prestige.',
    },
  },
  {
    id: 203,
    tier: 'wine_name_lookup',
    query: 'Tignanello 2019 정보',
    description: 'Producer + vintage lookup',
    expectation: {
      tools: [{ tool: 'search_wines', inputContains: ['Tignanello'] }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(tignanello|티냐넬로)', '(2019)'],
      rubric:
        'Must return info about Tignanello 2019 (Antinori, Super Tuscan). '
        + 'Should mention Sangiovese blend and Toscana IGT.',
    },
  },
  {
    id: 204,
    tier: 'wine_name_lookup',
    query: '돔페리뇽 추천해줘',
    description: 'Korean transliteration: 돔페리뇽 = Dom Pérignon',
    expectation: {
      tools: [{ tool: 'search_wines', inputContains: ['Dom'] }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(dom\\s*p[eé]rignon|돔\\s*페리뇽)'],
      rubric:
        'Must resolve 돔페리뇽 to Dom Pérignon. '
        + 'Should include Champagne context and prestige positioning.',
    },
  },
  {
    id: 205,
    tier: 'wine_name_lookup',
    query: '그 Penfolds 뭐시기... 빨간 라벨',
    description: 'Fuzzy brand + visual hint',
    expectation: {
      tools: [{ tool: 'search_wines', inputContains: ['Penfolds'] }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(penfolds|펜폴즈)'],
      rubric:
        'Must resolve to Penfolds (likely Grange or Bin 389 given red label hint). '
        + 'Should present candidates when exact match is uncertain.',
    },
  },
  {
    id: 206,
    tier: 'wine_name_lookup',
    query: '까스텔 뭐였지 프랑스 저렴한 거',
    description: 'Partial name recall: 까스텔 = Castel',
    expectation: {
      tools: [{ tool: 'search_wines', inputContains: ['Castel'] }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(castel|까스텔)'],
      rubric:
        'Must resolve 까스텔 to Castel wines (major French value brand). '
        + 'Should present affordable French options from this producer.',
    },
  },
  {
    id: 207,
    tier: 'wine_name_lookup',
    query: '쌩떼밀리옹 와인 추천',
    description: 'Korean transliteration of appellation: 쌩떼밀리옹 = Saint-Émilion',
    expectation: {
      tools: [{ tool: 'search_wines', inputContains: ['Saint-Émilion'] }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(saint[\\s-]?[eé]milion|쌩떼밀리옹|생테밀리옹)'],
      rubric:
        'Must resolve 쌩떼밀리옹 to Saint-Émilion (Bordeaux right bank). '
        + 'Should recommend wines from this appellation.',
    },
  },
  {
    id: 208,
    tier: 'wine_name_lookup',
    query: 'Chateau Margaux 가격',
    description: 'English name + Korean price request (mixed)',
    expectation: {
      tools: [{ tool: 'search_wines', inputContains: ['Margaux'] }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(chateau\\s*margaux|샤또\\s*마고|margaux)'],
      rubric:
        'Must provide price info or range for Château Margaux. '
        + 'Should note it is a First Growth Bordeaux.',
    },
  },
  {
    id: 209,
    tier: 'wine_name_lookup',
    query: '모엣샹동 로제 임페리얼',
    description: 'Full Korean transliteration of specific SKU',
    expectation: {
      tools: [{ tool: 'search_wines', inputContains: ['Moët'] }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(mo[eë]t|모엣|chandon|샹동)'],
      rubric:
        'Must resolve to Moët & Chandon Rosé Impérial. '
        + 'Should provide Champagne context and tasting profile.',
    },
  },
  {
    id: 210,
    tier: 'wine_name_lookup',
    query: '옐로우테일 쉬라즈 편의점에서 봤는데 괜찮아?',
    description: 'Budget brand evaluation: Yellow Tail',
    expectation: {
      tools: [{ tool: 'search_wines', inputContains: ['Yellow Tail'] }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(yellow\\s*tail|옐로우\\s*테일)'],
      rubric:
        'Must identify Yellow Tail Shiraz and give an honest assessment. '
        + 'Should contextualize as an entry-level wine without being dismissive.',
    },
  },
  {
    id: 211,
    tier: 'wine_name_lookup',
    query: '오메독이랑 오메독 크뤼 부르주아 차이가 뭐야?',
    description: 'Appellation hierarchy knowledge + name resolution',
    expectation: {
      maxSteps: 3,
      maxDurationMs: 12_000,
      maxTotalTokens: 5_000,
      answerMustMatch: ['(haut[\\s-]?m[eé]doc|오메독)'],
      rubric:
        'Must explain the difference between Haut-Médoc AOC and Cru Bourgeois classification. '
        + 'Should clarify that Cru Bourgeois is a quality tier within the appellation.',
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // taste_descriptor — 캐주얼 유저 핵심 (sensory/aroma/flavor search)
  // ═══════════════════════════════════════════════════════════════════════

  {
    id: 220,
    tier: 'taste_descriptor',
    query: '블랙베리 초콜릿 향 나는 레드 와인',
    description: 'Fruit + confection aroma descriptor',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(레드|red)'],
      rubric:
        'Must recommend red wines with blackberry and chocolate notes. '
        + 'Typical matches: Malbec, Cabernet, Shiraz. Should describe the sensory profile.',
    },
  },
  {
    id: 221,
    tier: 'taste_descriptor',
    query: '바닐라 스모키한 느낌 나는 와인',
    description: 'Oak-derived descriptors: vanilla + smoky',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      rubric:
        'Must recommend wines with vanilla and smoky character (oak-aged). '
        + 'Should explain oak aging as the source. Oaked Chardonnay, Rioja Reserva, etc.',
    },
  },
  {
    id: 222,
    tier: 'taste_descriptor',
    query: '상큼하고 시트러스 향 강한 화이트 와인',
    description: 'Fresh + citrus white wine descriptor',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(화이트|white)'],
      rubric:
        'Must recommend crisp white wines with citrus character. '
        + 'Sauvignon Blanc, Albariño, Vermentino, unoaked Chardonnay expected.',
    },
  },
  {
    id: 223,
    tier: 'taste_descriptor',
    query: '흙내 나는 와인 있어?',
    description: 'Earthy descriptor: 흙내 = earthy',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      rubric:
        'Must recommend wines with earthy/terroir-driven character. '
        + 'Burgundy Pinot Noir, Nebbiolo, old-world Tempranillo, Châteauneuf-du-Pape.',
    },
  },
  {
    id: 224,
    tier: 'taste_descriptor',
    query: '가죽 향 나는 풀바디 레드',
    description: 'Tertiary aroma: leather + full body',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(레드|red|풀바디|full[\\s-]?body)'],
      rubric:
        'Must recommend full-bodied reds with leather notes (aged wines). '
        + 'Barolo, Rioja Gran Reserva, mature Bordeaux, Brunello expected.',
    },
  },
  {
    id: 225,
    tier: 'taste_descriptor',
    query: '꽃향기 나는 가벼운 와인',
    description: 'Floral + light body',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      rubric:
        'Must recommend light-bodied wines with floral aromatics. '
        + 'Moscato, Gewürztraminer, Torrontés, Beaujolais, Pinot Noir expected.',
    },
  },
  {
    id: 226,
    tier: 'taste_descriptor',
    query: '미네랄 느낌 강한 드라이 와인, 바다 짭짤한 느낌',
    description: 'Mineral + saline descriptor',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      rubric:
        'Must recommend wines with pronounced minerality and saline character. '
        + 'Chablis, Muscadet, Santorini Assyrtiko, coastal whites expected.',
    },
  },
  {
    id: 227,
    tier: 'taste_descriptor',
    query: '열대과일 향 터지는 와인 추천',
    description: 'Tropical fruit bomb descriptor',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      rubric:
        'Must recommend wines with explosive tropical fruit character (mango, passion fruit, pineapple). '
        + 'New Zealand Sauvignon Blanc, Viognier, oaked New World Chardonnay expected.',
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // rating_score — 마니아 핵심 필터
  // ═══════════════════════════════════════════════════════════════════════

  {
    id: 240,
    tier: 'rating_score',
    query: '파커 95점 이상 와인 추천',
    description: 'Robert Parker 95+ filter',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      rubric:
        'Must recommend wines with Robert Parker (Wine Advocate) 95+ rating. '
        + 'Should cite scores or explain quality tier. Must not fabricate scores.',
    },
  },
  {
    id: 241,
    tier: 'rating_score',
    query: '비비노 4.5 이상 와인 중에 5만원 이하',
    description: 'Vivino rating + price filter',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      priceBandKrw: { max: 50_000 },
      rubric:
        'Must recommend wines rated 4.5+ on Vivino under 50,000 KRW. '
        + 'If Vivino data unavailable, should explain and offer alternatives.',
    },
  },
  {
    id: 242,
    tier: 'rating_score',
    query: 'WS 90점대 3만원 이하 데일리 와인',
    description: 'Wine Spectator 90-99 + budget',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      priceBandKrw: { max: 30_000 },
      rubric:
        'Must recommend daily wines with Wine Spectator 90+ score under 30,000 KRW. '
        + 'Should explain WS scoring or offer quality-equivalent alternatives.',
    },
  },
  {
    id: 243,
    tier: 'rating_score',
    query: '제임스 서클링 100점 받은 와인 뭐가 있어?',
    description: 'James Suckling perfect score query',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      rubric:
        'Must address James Suckling 100-point wines. Should name actual examples if known. '
        + 'Must not fabricate scores — if data unavailable, acknowledge the gap.',
    },
  },
  {
    id: 244,
    tier: 'rating_score',
    query: '평점 높은데 가격 낮은 가성비 와인, 점수 기준으로',
    description: 'Score-to-price ratio optimization',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 3,
      maxDurationMs: 12_000,
      maxTotalTokens: 5_000,
      rubric:
        'Must recommend wines with best score-to-price ratio. '
        + 'Should explain the value proposition with concrete scores and prices.',
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // wine_type_basic — rosé/sparkling/dessert/orange/fortified 커버
  // ═══════════════════════════════════════════════════════════════════════

  {
    id: 260,
    tier: 'wine_type_basic',
    query: '로제 와인 추천해줘',
    description: 'Basic rosé search',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(로제|rosé|ros[eé])'],
      rubric:
        'Must recommend rosé wines specifically. '
        + 'Should mention style (Provence, Spanish, etc.) and serving context.',
    },
  },
  {
    id: 261,
    tier: 'wine_type_basic',
    query: '스파클링 와인 추천, 샴페인 말고 저렴한 거',
    description: 'Sparkling excluding Champagne',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(스파클링|sparkling|프로세코|prosecco|카바|cava|크레망|crémant)'],
      rubric:
        'Must recommend sparkling wines that are NOT Champagne (Prosecco, Cava, Crémant, etc.). '
        + 'Should note they are more affordable alternatives.',
    },
  },
  {
    id: 262,
    tier: 'wine_type_basic',
    query: '디저트 와인 뭐가 있어? 달달한 거',
    description: 'Dessert/sweet wine exploration',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      rubric:
        'Must recommend dessert wines (Sauternes, Tokaji, late harvest, ice wine, Moscato d\'Asti, etc.). '
        + 'Should explain different styles of sweet wine.',
    },
  },
  {
    id: 263,
    tier: 'wine_type_basic',
    query: '오렌지 와인이 뭐야? 마셔볼 만한 거 추천',
    description: 'Orange wine education + recommendation',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      rubric:
        'Must explain orange wine (skin-contact white wine) and recommend examples. '
        + 'Should mention Georgian origin and modern producers (Gravner, Radikon, etc.).',
    },
  },
  {
    id: 264,
    tier: 'wine_type_basic',
    query: '포트 와인 추천, 식후주로 마실 거',
    description: 'Fortified wine: Port',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(포트|port|porto)'],
      rubric:
        'Must recommend Port wine for after-dinner drinking. '
        + 'Should distinguish styles (Ruby, Tawny, Vintage, LBV, Vintage).',
    },
  },
  {
    id: 265,
    tier: 'wine_type_basic',
    query: '셰리 와인 맛있어? 어떤 종류가 있어?',
    description: 'Fortified wine: Sherry education',
    expectation: {
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(셰리|sherry|jerez)'],
      rubric:
        'Must explain Sherry types (Fino, Manzanilla, Amontillado, Oloroso, Pedro Ximénez). '
        + 'Should recommend specific styles based on general appeal.',
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // negation_complex — 이중/삼중 부정, 복합 제외
  // ═══════════════════════════════════════════════════════════════════════

  {
    id: 280,
    tier: 'negation_complex',
    query: '레드인데 타닌 없고 오크 안 쓴 거',
    description: 'Double negation: no tannin + unoaked red',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(레드|red)'],
      rubric:
        'Must recommend red wines with very low tannin and no oak aging. '
        + 'Beaujolais (Gamay), carbonic maceration reds, light Pinot Noir expected.',
    },
  },
  {
    id: 281,
    tier: 'negation_complex',
    query: '프랑스 아닌 유럽, 카베르네 아닌 풀바디 레드',
    description: 'Double exclusion: not France + not Cabernet',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(레드|red|풀바디|full[\\s-]?body)'],
      answerMustNotMatch: ['(cabernet\\s+sauvignon|카베르네\\s*소비뇽)'],
      rubric:
        'Must recommend full-bodied European reds excluding France and Cabernet Sauvignon. '
        + 'Italian (Barolo, Amarone), Spanish (Tempranillo), Portuguese expected.',
    },
  },
  {
    id: 282,
    tier: 'negation_complex',
    query: '화이트인데 샤도네이 말고, 소비뇽 블랑도 말고, 리슬링도 아닌 거',
    description: 'Triple grape exclusion',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(화이트|white)'],
      rubric:
        'Must recommend white wines that are NOT Chardonnay, NOT Sauvignon Blanc, NOT Riesling. '
        + 'Pinot Grigio, Albariño, Viognier, Grüner Veltliner, Vermentino expected.',
    },
  },
  {
    id: 283,
    tier: 'negation_complex',
    query: '스파클링인데 달지 않고, 샴페인도 아니고, 이탈리아산도 아닌 거',
    description: 'Type + sweetness negation + double region exclusion',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(스파클링|sparkling)'],
      rubric:
        'Must recommend dry sparkling wines that are NOT Champagne and NOT Italian (no Prosecco). '
        + 'Spanish Cava, Crémant d\'Alsace, English sparkling, South African MCC expected.',
    },
  },
  {
    id: 284,
    tier: 'negation_complex',
    query: '신세계 와인 싫어, 구세계만, 근데 보르도는 질렸어',
    description: 'Old World only + exclude Bordeaux',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      rubric:
        'Must recommend Old World wines excluding Bordeaux. '
        + 'Burgundy, Rhône, Italy, Spain, Germany, Portugal expected. '
        + 'No New World (US, Australia, Chile, Argentina, NZ, South Africa).',
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // arithmetic_query — 수량/예산 계산이 필요한 쿼리
  // ═══════════════════════════════════════════════════════════════════════

  {
    id: 300,
    tier: 'arithmetic_query',
    query: '4명이서 1인당 2만원, 와인 2병 살 거야',
    description: 'Per-person budget × headcount → total budget',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 3,
      maxDurationMs: 15_000,
      maxTotalTokens: 6_000,
      priceBandKrw: { max: 40_000 },
      rubric:
        'Must calculate total budget: 4 people × 20,000 KRW = 80,000 KRW for 2 bottles → ~40,000 KRW/bottle. '
        + 'Must recommend 2 different wines each ≤40,000 KRW.',
    },
  },
  {
    id: 301,
    tier: 'arithmetic_query',
    query: '20명 파티에 와인 몇 병 필요해? 추천도 해줘',
    description: 'Quantity calculation: guests → bottles',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 3,
      maxDurationMs: 15_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must estimate bottle count for 20 people (~half bottle per person = ~10 bottles, '
        + 'or ~2-3 glasses per person). Should recommend wines for the party.',
    },
  },
  {
    id: 302,
    tier: 'arithmetic_query',
    query: '2병에 10만원 맞출 수 있는 조합 추천',
    description: 'Budget split across 2 bottles',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 3,
      maxDurationMs: 15_000,
      maxTotalTokens: 6_000,
      priceBandKrw: { max: 100_000 },
      rubric:
        'Must recommend 2 wines whose combined price is ≤100,000 KRW. '
        + 'Should show price of each and the total.',
    },
  },
  {
    id: 303,
    tier: 'arithmetic_query',
    query: '6병 세트로 다양하게, 총 30만원',
    description: '6-bottle variety set within total budget',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 4,
      maxDurationMs: 20_000,
      maxTotalTokens: 8_000,
      priceBandKrw: { max: 300_000 },
      rubric:
        'Must recommend 6 different wines totaling ≤300,000 KRW (~50,000 avg/bottle). '
        + 'Should ensure variety (different grapes, regions, styles).',
    },
  },
  {
    id: 304,
    tier: 'arithmetic_query',
    query: '달러로 50불 이하 와인, 한국 돈으로 얼마쯤이야?',
    description: 'Currency conversion context',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      rubric:
        'Must estimate KRW equivalent of $50 (~65,000-70,000 KRW) and recommend wines in that range. '
        + 'Should note that exchange rates fluctuate.',
    },
  },
  {
    id: 305,
    tier: 'arithmetic_query',
    query: '매주 1병씩 한 달간 마실 건데, 총 20만원으로 4병 다 다르게',
    description: 'Weekly variety plan within monthly budget',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 3,
      maxDurationMs: 15_000,
      maxTotalTokens: 6_000,
      priceBandKrw: { max: 200_000 },
      rubric:
        'Must recommend 4 different wines (one per week) totaling ≤200,000 KRW (~50,000 avg). '
        + 'Should consider a progression (light to bold, or seasonal variety).',
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // bilingual_mixed — 영한 혼용 검색
  // ═══════════════════════════════════════════════════════════════════════

  {
    id: 320,
    tier: 'bilingual_mixed',
    query: 'best Bordeaux under 100 dollars',
    description: 'Pure English query',
    expectation: {
      tools: [{ tool: 'search_wines', inputContains: ['Bordeaux'] }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(bordeaux|보르도)'],
      rubric:
        'Must handle pure English query and recommend Bordeaux under $100. '
        + 'Response language should match user (English) or default to Korean.',
    },
  },
  {
    id: 321,
    tier: 'bilingual_mixed',
    query: 'Pinot Noir vs Nebbiolo 어떤 게 더 좋아?',
    description: 'English grape names + Korean question',
    expectation: {
      tools: [{ tool: 'compare_wines' }],
      maxSteps: 3,
      maxDurationMs: 12_000,
      maxTotalTokens: 6_000,
      answerMustMatch: ['(pinot\\s*noir|피노\\s*누아르)', '(nebbiolo|네비올로)'],
      rubric:
        'Must compare Pinot Noir and Nebbiolo with stylistic differences. '
        + 'Should handle the bilingual query naturally.',
    },
  },
  {
    id: 322,
    tier: 'bilingual_mixed',
    query: 'Napa Valley Cab Sauv 나파밸리 카베르네 추천 좀',
    description: 'Redundant bilingual (same info in both languages)',
    expectation: {
      tools: [{ tool: 'search_wines', inputContains: ['Napa'] }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(napa|나파)', '(cabernet|카베르네)'],
      rubric:
        'Must handle redundant bilingual input (same query in English + Korean). '
        + 'Should not search twice. Recommend Napa Cabernet Sauvignon wines.',
    },
  },
  {
    id: 323,
    tier: 'bilingual_mixed',
    query: 'good value Italian red wine 이탈리아 레드 가성비',
    description: 'Mixed language with partial overlap',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 12_000,
      maxTotalTokens: 4_000,
      answerMustMatch: ['(이탈리아|italy|italian)', '(레드|red)'],
      rubric:
        'Must recommend value Italian red wines. Should merge the bilingual intent correctly.',
    },
  },
  {
    id: 324,
    tier: 'bilingual_mixed',
    query: 'Champagne이랑 Crémant 차이가 뭐야?',
    description: 'English terms + Korean structure',
    expectation: {
      maxSteps: 3,
      maxDurationMs: 12_000,
      maxTotalTokens: 6_000,
      answerMustMatch: ['(champagne|샴페인)', '(cr[eé]mant|크레망)'],
      rubric:
        'Must explain the difference between Champagne and Crémant (region, method, price). '
        + 'Both are méthode traditionnelle but only Champagne is from the Champagne region.',
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // cellar_aging — 숙성/보관/음주 시점 전문 쿼리
  // ═══════════════════════════════════════════════════════════════════════

  {
    id: 340,
    tier: 'cellar_aging',
    query: '10년 숙성할 수 있는 와인 추천, 20만원 이하',
    description: 'Long aging potential + price filter',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 3,
      maxDurationMs: 15_000,
      maxTotalTokens: 6_000,
      priceBandKrw: { max: 200_000 },
      rubric:
        'Must recommend wines with 10+ year aging potential under 200,000 KRW. '
        + 'Structured reds (Barolo, Bordeaux, Brunello) or sweet wines expected.',
    },
  },
  {
    id: 341,
    tier: 'cellar_aging',
    query: '셀러에 넣어둘 만한 거, 지금 마시면 아까운 와인',
    description: 'Cellar-worthy, not ready yet',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 3,
      maxDurationMs: 15_000,
      maxTotalTokens: 6_000,
      drinkingWindowStatus: 'hold',
      rubric:
        'Must recommend wines that are worth cellaring and NOT at peak now. '
        + 'Young tannic wines that need time. Should explain why they need aging.',
    },
  },
  {
    id: 342,
    tier: 'cellar_aging',
    query: '2015년산 중에 지금 바로 마셔야 하는 거 있어?',
    description: 'Drinking window urgency for specific vintage',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 3,
      maxDurationMs: 15_000,
      maxTotalTokens: 6_000,
      vintageRange: { min: 2015, max: 2015 },
      drinkingWindowStatus: 'now',
      rubric:
        'Must recommend 2015 vintage wines that are at or near peak drinking window. '
        + 'Should indicate urgency if any are past peak.',
    },
  },
  {
    id: 343,
    tier: 'cellar_aging',
    query: '아이 태어난 해 와인 사서 성인 될 때 같이 마시려고, 2024년산',
    description: 'Birth-year wine for 20-year cellaring',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 3,
      maxDurationMs: 15_000,
      maxTotalTokens: 6_000,
      vintageRange: { min: 2024, max: 2024 },
      rubric:
        'Must recommend wines from 2024 vintage with 20+ year aging potential. '
        + 'Top Bordeaux, vintage Port, Barolo, or Brunello expected. '
        + 'Should address the sentimental/celebratory context.',
    },
  },
];

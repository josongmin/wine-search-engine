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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 8_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 8_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      answerMustMatch: ['(레드|red|풀바디|full[\\s-]?body)'],
      // answerMustNotMatch removed: refusal text "Cabernet 빼고 추천" legitimately contains the term.
      rubric:
        'Must recommend full-bodied European reds whose PRIMARY grape is NOT Cabernet Sauvignon and whose origin is NOT France. '
        + 'Mentioning Cabernet/France for contrast is OK. '
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 50_000,
      maxTotalTokens: 8_000,
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
      maxDurationMs: 50_000,
      maxTotalTokens: 8_000,
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
      maxDurationMs: 50_000,
      maxTotalTokens: 8_000,
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
      maxDurationMs: 60_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 50_000,
      maxTotalTokens: 8_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 8_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
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
      maxDurationMs: 40_000,
      maxTotalTokens: 8_000,
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
      maxDurationMs: 50_000,
      maxTotalTokens: 8_000,
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
      maxDurationMs: 50_000,
      maxTotalTokens: 8_000,
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
      maxDurationMs: 50_000,
      maxTotalTokens: 8_000,
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
      maxDurationMs: 50_000,
      maxTotalTokens: 8_000,
      vintageRange: { min: 2024, max: 2024 },
      rubric:
        'Must recommend wines from 2024 vintage with 20+ year aging potential. '
        + 'Top Bordeaux, vintage Port, Barolo, or Brunello expected. '
        + 'Should address the sentimental/celebratory context.',
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // negation — 26 additional scenarios (IDs 400-425) → tier total ≥ 30
  // ═══════════════════════════════════════════════════════════════════════

  {
    id: 400,
    tier: 'negation',
    query: '스페인 와인 말고 추천해줘',
    description: 'Region exclusion: not Spain',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend wines that are NOT from Spain. '
        + 'Any other region (France, Italy, Chile, etc.) is acceptable. '
        + 'The recommended wines must clearly come from a non-Spanish origin.',
    },
  },
  {
    id: 401,
    tier: 'negation',
    query: '이탈리아 아닌 레드 와인 추천',
    description: 'Region exclusion: not Italian red',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      answerMustMatch: ['(레드|red)'],
      rubric:
        'Must recommend red wines that are NOT from Italy. '
        + 'Recommended wines must be explicitly from a non-Italian origin.',
    },
  },
  {
    id: 402,
    tier: 'negation',
    query: 'New World 아닌 피노 누아르 추천',
    description: 'Exclude New World: Old World Pinot Noir only',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      answerMustMatch: ['(피노\\s*누아르|pinot\\s*noir)'],
      rubric:
        'Must recommend Old World Pinot Noir only — Burgundy, Alsace, Germany, etc. '
        + 'Must NOT recommend New World sources (California, Oregon, New Zealand, Chile, etc.). '
        + 'Should explain the Old World vs New World stylistic difference.',
    },
  },
  {
    id: 403,
    tier: 'negation',
    query: '메를로 빼고 보르도 스타일 와인',
    description: 'Grape exclusion within style: Bordeaux-style without Merlot',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      // answerExcludes removed: refusal text "메를로 빼고" legitimately contains the term.
      rubric:
        'Must recommend Bordeaux-style wines or blends whose PRIMARY grape is NOT Merlot. '
        + 'Mentioning Merlot for context (e.g., "instead of Merlot") is OK. '
        + 'Cabernet Sauvignon-dominant Bordeaux, Pauillac, Médoc Crus expected.',
    },
  },
  {
    id: 404,
    tier: 'negation',
    query: '소비뇽 블랑 제외한 화이트 와인 추천',
    description: 'Grape exclusion: no Sauvignon Blanc white',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      answerMustMatch: ['(화이트|white)'],
      // answerExcludes removed: refusal text contains the excluded term legitimately.
      rubric:
        'Must recommend white wines whose PRIMARY grape is NOT Sauvignon Blanc. '
        + 'Mentioning Sauvignon Blanc for contrast/context is OK. '
        + 'Chardonnay, Riesling, Pinot Grigio, Albariño etc. are all acceptable.',
    },
  },
  {
    id: 405,
    tier: 'negation',
    query: '시라 없는 론 스타일 와인 추천해줘',
    description: 'Grape exclusion within style: Rhône-style without Syrah',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      // answerExcludes removed: refusal text contains the excluded term legitimately.
      rubric:
        'Must recommend Rhône-style wines whose DOMINANT grape is NOT Syrah/Shiraz. '
        + 'Mentioning Syrah for contrast is OK. '
        + 'Grenache-based blends (Châteauneuf-du-Pape without Syrah emphasis), Mourvèdre, Viognier expected.',
    },
  },
  {
    id: 406,
    tier: 'negation',
    query: '오크향 없는 샤르도네 추천',
    description: 'Style exclusion: unoaked Chardonnay',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      answerMustMatch: ['(샤르도네|샤도네이|chardonnay)'],
      rubric:
        'Must recommend unoaked or lightly oaked Chardonnay with no pronounced oak character. '
        + 'Chablis, Mâcon, stainless-steel fermented examples expected. '
        + 'Should mention the unoaked/crisp style explicitly.',
    },
  },
  {
    id: 407,
    tier: 'negation',
    query: '타닌 강한 거 말고 마시기 편한 레드',
    description: 'Style exclusion: low-tannin red',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      answerMustMatch: ['(레드|red)'],
      rubric:
        'Must recommend soft, approachable red wines with low tannin. '
        + 'Pinot Noir, Gamay, Grenache, Dolcetto, lighter Merlot expected. '
        + 'Should explicitly contrast with high-tannin wines.',
    },
  },
  {
    id: 408,
    tier: 'negation',
    query: '스위트 아닌 화이트 와인 추천',
    description: 'Style exclusion: dry white only',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      answerMustMatch: ['(화이트|white)'],
      rubric:
        'Must recommend dry white wines with no residual sweetness. '
        + 'Should explicitly mention "dry" character. '
        + 'Sauvignon Blanc, dry Riesling, Chablis, Pinot Grigio expected.',
    },
  },
  {
    id: 409,
    tier: 'negation',
    query: '프랑스도 이탈리아도 아닌 레드 와인',
    description: 'Double region negation: not France, not Italy',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      answerMustMatch: ['(레드|red)'],
      rubric:
        'Must recommend red wines from regions OTHER than France and Italy. '
        + 'Spain, Portugal, Argentina, Chile, USA, Australia etc. are all acceptable. '
        + 'Recommended wines must not originate from France or Italy.',
    },
  },
  {
    id: 410,
    tier: 'negation',
    query: '카베르네도 메를로도 아닌 풀바디 레드',
    description: 'Double grape negation: full-bodied red without Cabernet or Merlot',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      answerMustMatch: ['(레드|red|풀바디|full[\\s-]?body)'],
      // answerExcludes removed: refusal text contains the excluded terms legitimately.
      rubric:
        'Must recommend full-bodied red wines whose PRIMARY grapes are NEITHER Cabernet Sauvignon NOR Merlot. '
        + 'Mentioning Cabernet/Merlot for contrast ("instead of Cabernet/Merlot, try ...") is OK. '
        + 'Syrah/Shiraz, Nebbiolo (Barolo), Tempranillo, Malbec, Amarone expected.',
    },
  },
  {
    id: 411,
    tier: 'negation',
    query: '채식주의자용 동물 성분 없이 만든 와인 추천',
    description: 'Implicit negation: vegan wine (no animal fining agents)',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend vegan wines that use no animal-derived fining agents '
        + '(no egg white, casein, gelatin, isinglass). '
        + 'Should explain vegan winemaking briefly and name specific producers or wines.',
    },
  },
  {
    id: 412,
    tier: 'negation',
    query: '유기농만 추천해줘 와인',
    description: 'Implicit negation: organic only (no conventional viticulture)',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend certified organic wines. '
        + 'Should mention organic certification (EU Organic, USDA Organic, etc.) '
        + 'and distinguish between organic grapes vs organic wine labeling.',
    },
  },
  {
    id: 413,
    tier: 'negation',
    query: '비건 와인만 추천해줘',
    description: 'Implicit negation: vegan-certified only',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend wines certified or confirmed vegan (no animal products in production). '
        + 'Should explain why standard wines may not be vegan. '
        + 'Specific vegan producers or Vivino/Barnivore references are a plus.',
    },
  },
  {
    id: 414,
    tier: 'negation',
    query: '10만원 이상 말고 좋은 와인 추천해줘',
    description: 'Price negation: exclude expensive tier',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { max: 100_000 },
      rubric:
        'Must recommend wines priced UNDER 100,000 KRW. '
        + 'Should frame these as genuinely good quality, not just budget picks. '
        + 'Must not suggest anything over the 100,000 KRW ceiling.',
    },
  },
  {
    id: 415,
    tier: 'negation',
    query: '저가 말고 프리미엄 와인 추천',
    description: 'Price negation: exclude cheap tier',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      priceBandKrw: { min: 50_000 },
      rubric:
        'Must recommend premium wines clearly positioned above the entry-level tier (≥50,000 KRW or equivalent). '
        + 'Should explain what makes these wines premium (craftsmanship, terroir, aging, scores).',
    },
  },
  {
    id: 416,
    tier: 'negation',
    query: '황산화물 적게 들어간 와인 있어?',
    description: 'Implicit negation: low-sulfite wine',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend low-sulfite or no-added-sulfite wines. '
        + 'Natural wine producers or specific low-SO2 labels expected. '
        + 'Should mention that all wines contain some natural sulfites.',
    },
  },
  {
    id: 417,
    tier: 'negation',
    query: '알코올 도수 낮은 거 말고 뭔가 묵직한 거',
    description: 'Implicit negation: exclude low-alcohol, want high-alcohol bold wine',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend bold, high-alcohol wines (typically 14%+ ABV). '
        + 'Amarone, Zinfandel, Shiraz, Châteauneuf-du-Pape expected. '
        + 'Should explicitly mention the higher alcohol or richness.',
    },
  },
  {
    id: 418,
    tier: 'negation',
    query: '칠레 아르헨티나 말고 남미 와인',
    description: 'Double country exclusion within region: South America without Chile/Argentina',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend South American wines that are NOT from Chile and NOT from Argentina. '
        + 'Uruguay (Tannat), Brazil, Bolivia expected. '
        + 'Should acknowledge these are lesser-known but legitimate producers.',
    },
  },
  {
    id: 419,
    tier: 'negation',
    query: '무거운 거 말고 가벼운 레드 추천',
    description: 'Body exclusion: exclude full-bodied red',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      answerMustMatch: ['(레드|red)'],
      rubric:
        'Must recommend light-to-medium bodied red wines. '
        + 'Beaujolais (Gamay), Pinot Noir, Barbera, Zweigelt, light Sangiovese expected. '
        + 'Should explicitly contrast with heavy/full-bodied reds.',
    },
  },
  {
    id: 420,
    tier: 'negation',
    query: '샴페인 말고 기포 있는 거, 이탈리아도 말고',
    description: 'Double exclusion: no Champagne, no Italian sparkling',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      answerMustMatch: ['(스파클링|sparkling|기포|fizz|effervescent)'],
      rubric:
        'Must recommend sparkling wines that are NOT Champagne and NOT Italian (no Prosecco, no Franciacorta). '
        + 'Cava, Crémant, Sekt, English sparkling, South African MCC expected.',
    },
  },
  {
    id: 421,
    tier: 'negation',
    query: '가격 비싼 건 패스, 데일리로 매일 마실 수 있는 거',
    description: 'Implicit price negation: daily drinker under budget',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      priceBandKrw: { max: 30_000 },
      rubric:
        'Must recommend affordable, everyday-drinking wines (≤30,000 KRW range). '
        + 'Should position these as genuinely enjoyable daily options, not just cheap fallbacks.',
    },
  },
  {
    id: 422,
    tier: 'negation',
    query: '레드 말고 추천해줘, 화이트도 말고',
    description: 'Color double exclusion: not red, not white',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend wines that are neither red nor white. '
        + 'Rosé, orange wine, sparkling, or dessert wines expected. '
        + 'Should clarify which category is being recommended.',
    },
  },
  {
    id: 423,
    tier: 'negation',
    query: '리저브 급 말고 일반급으로만',
    description: 'Classification exclusion: no reserva/gran reserva tier',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend entry-level or standard-tier wines, NOT Reserva, Gran Reserva, or Riserva. '
        + 'Should explain that these are accessible, everyday-quality wines without sacrificing character.',
    },
  },
  {
    id: 424,
    tier: 'negation',
    query: '포도품종 단일 아닌 블렌딩 와인만',
    description: 'Implicit negation: blended wines only, no single-varietal',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend blended wines featuring two or more grape varieties. '
        + 'Bordeaux blends, GSM (Grenache-Syrah-Mourvèdre), Super Tuscans, Meritage expected. '
        + 'Should briefly explain the blending rationale.',
    },
  },
  {
    id: 425,
    tier: 'negation',
    query: '너무 신 건 싫어, 산도 낮은 와인 추천',
    description: 'Style exclusion: low-acid preference',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend wines with naturally lower acidity for a smoother, rounder palate. '
        + 'Viognier, Grenache, Merlot, oaked Chardonnay, Malbec expected. '
        + 'Should contrast with high-acid varieties and explain the difference.',
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // nested_condition — 25 additional scenarios (IDs 430-454) → tier total ≥ 30
  // ═══════════════════════════════════════════════════════════════════════

  {
    id: 430,
    tier: 'nested_condition',
    query: '이탈리아 피에몬테 지역 2016-2019년산 네비올로 10만원 이하',
    description: 'Region + sub-region + vintage range + grape + price: 5 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { max: 100_000 },
      vintageRange: { min: 2016, max: 2019 },
      answerMustMatch: ['(네비올로|nebbiolo)', '(피에몬테|piedmont|piemonte)'],
      rubric:
        'Must recommend Nebbiolo wines from Piedmont (Langhe DOC, Nebbiolo d\'Alba, etc.) '
        + 'from 2016-2019 vintage under 100,000 KRW. All 5 constraints must be addressed.',
    },
  },
  {
    id: 431,
    tier: 'nested_condition',
    query: '프랑스 부르고뉴 피노 누아 중에 산도 높고 5만원대',
    description: 'Region + sub-region + grape + acidity + price band: 5 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { min: 40_000, max: 69_000 },
      answerMustMatch: ['(부르고뉴|burgundy|bourgogne)', '(피노\\s*누아|pinot\\s*noir)'],
      rubric:
        'Must recommend Burgundy Pinot Noir with high acidity in the 40,000–69,000 KRW range. '
        + 'Village-level or premier cru options expected. '
        + 'All constraints (region, grape, acidity, price band) must be respected.',
    },
  },
  {
    id: 432,
    tier: 'nested_condition',
    query: '스페인 리오하 템프라니요 2015년 이후 20만원 이하',
    description: 'Region + sub-region + grape + vintage floor + price: 5 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { max: 200_000 },
      vintageRange: { min: 2015 },
      answerMustMatch: ['(리오하|rioja)', '(템프라니요|tempranillo)'],
      rubric:
        'Must recommend Rioja Tempranillo from vintage 2015 or later, under 200,000 KRW. '
        + 'Reserva or Gran Reserva from this period expected. '
        + 'All constraints must be satisfied.',
    },
  },
  {
    id: 433,
    tier: 'nested_condition',
    query: '호주 바로사 쉬라즈 풀바디 과일향 15만원 이하',
    description: 'Country + sub-region + grape + body + aroma + price: 6 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { max: 150_000 },
      answerMustMatch: ['(바로사|barossa)', '(쉬라즈|shiraz)'],
      rubric:
        'Must recommend Barossa Valley Shiraz with full body and fruit-forward character under 150,000 KRW. '
        + 'Penfolds Bin, Torbreck, or similar producers expected. '
        + 'All 6 constraints must be addressed.',
    },
  },
  {
    id: 434,
    tier: 'nested_condition',
    query: '뉴질랜드 말보로 소비뇽 블랑 2020-2022년산 신선한 것',
    description: 'Country + region + grape + vintage range + freshness: 5 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      vintageRange: { min: 2020, max: 2022 },
      answerMustMatch: ['(말보로|marlborough)', '(소비뇽\\s*블랑|sauvignon\\s*blanc)'],
      rubric:
        'Must recommend Marlborough Sauvignon Blanc from 2020-2022, emphasizing freshness and tropical character. '
        + 'Cloudy Bay, Kim Crawford, Brancott Estate etc. expected. '
        + 'All constraints must be satisfied.',
    },
  },
  {
    id: 435,
    tier: 'nested_condition',
    query: '독일 리슬링 드라이 스타일 5만원 이하',
    description: 'Country + grape + style + price: 4 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      priceBandKrw: { max: 50_000 },
      answerMustMatch: ['(리슬링|riesling)', '(독일|germany|german)'],
      rubric:
        'Must recommend dry-style German Riesling (Trocken) under 50,000 KRW. '
        + 'Mosel, Rheingau, or Pfalz examples expected. '
        + 'Should clarify the "dry" Riesling style vs off-dry/sweet versions.',
    },
  },
  {
    id: 436,
    tier: 'nested_condition',
    query: '3만원 이하 2019년산 칠레 카베르네 소비뇽',
    description: 'Price + vintage + country + grape: 4 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      priceBandKrw: { max: 30_000 },
      vintageRange: { min: 2019, max: 2019 },
      answerMustMatch: ['(칠레|chile|chilean)', '(카베르네\\s*소비뇽|cabernet\\s*sauvignon)'],
      rubric:
        'Must recommend Chilean Cabernet Sauvignon from 2019 vintage under 30,000 KRW. '
        + 'Maipo, Colchagua valley examples or major producers expected.',
    },
  },
  {
    id: 437,
    tier: 'nested_condition',
    query: '산도 높고 타닌 중간인 레드 7만원 이하',
    description: 'Acidity + tannin level + color + price: 4 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      priceBandKrw: { max: 70_000 },
      answerMustMatch: ['(레드|red)'],
      rubric:
        'Must recommend red wines with high acidity and medium tannin under 70,000 KRW. '
        + 'Sangiovese (Chianti Classico), Barbera, Pinot Noir, Grenache expected. '
        + 'All constraints (acidity, tannin, color, price) must be respected.',
    },
  },
  {
    id: 438,
    tier: 'nested_condition',
    query: '포르투갈 알렌테주 레드 2017-2020년산 10만원대',
    description: 'Country + region + color + vintage range + price band: 5 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { min: 100_000, max: 199_000 },
      vintageRange: { min: 2017, max: 2020 },
      answerMustMatch: ['(알렌테주|alentejo)', '(포르투갈|portugal)'],
      rubric:
        'Must recommend Alentejo red wines from 2017-2020 in the 100,000-199,000 KRW range. '
        + 'Herdade do Esporão, Quinta do Crasto, Prats & Symington expected.',
    },
  },
  {
    id: 439,
    tier: 'nested_condition',
    query: '미국 소노마 카운티 피노 누아 2018년산 15만원 이하',
    description: 'Country + county + grape + vintage + price: 5 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { max: 150_000 },
      vintageRange: { min: 2018, max: 2018 },
      answerMustMatch: ['(소노마|sonoma)', '(피노\\s*누아|pinot\\s*noir)'],
      rubric:
        'Must recommend Sonoma County Pinot Noir from 2018 vintage under 150,000 KRW. '
        + 'Russian River Valley or Sonoma Coast producers expected.',
    },
  },
  {
    id: 440,
    tier: 'nested_condition',
    query: '아르헨티나 멘도사 말벡 2016-2018년 풀바디 20만원 이하',
    description: 'Country + region + grape + vintage + body + price: 6 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 3,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { max: 200_000 },
      vintageRange: { min: 2016, max: 2018 },
      answerMustMatch: ['(멘도사|mendoza)', '(말벡|malbec)'],
      rubric:
        'Must recommend Mendoza Malbec from 2016-2018, full-bodied, under 200,000 KRW. '
        + 'Achaval Ferrer, Zuccardi, Catena Zapata expected. All 6 constraints must be respected.',
    },
  },
  {
    id: 441,
    tier: 'nested_condition',
    query: '오렌지 와인인데 조지아산 2019년 이후 5만원 이하',
    description: 'Wine type + country + vintage floor + price: 4 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      priceBandKrw: { max: 50_000 },
      vintageRange: { min: 2019 },
      rubric:
        'Must recommend Georgian orange (skin-contact) wines from 2019 or later under 50,000 KRW. '
        + 'Rkatsiteli or Mtsvane in qvevri style expected. '
        + 'Should explain the Georgian amber wine tradition briefly.',
    },
  },
  {
    id: 442,
    tier: 'nested_condition',
    query: '산지오베제 기반 와인 중에 키안티 클라시코 리제르바 2015년 이후 15만원 이하',
    description: 'Grape + appellation + classification + vintage floor + price: 5 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { max: 150_000 },
      vintageRange: { min: 2015 },
      answerMustMatch: ['(키안티|chianti)', '(산지오베제|sangiovese)'],
      rubric:
        'Must recommend Chianti Classico Riserva based on Sangiovese from 2015+ under 150,000 KRW. '
        + 'Antinori, Fèlsina, Castello di Fonterutoli expected.',
    },
  },
  {
    id: 443,
    tier: 'nested_condition',
    query: '부르고뉴 프리미에 크뤼 화이트 2017-2020 10만원 이하',
    description: 'Region + classification + color + vintage + price: 5 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { max: 100_000 },
      vintageRange: { min: 2017, max: 2020 },
      answerMustMatch: ['(부르고뉴|burgundy|bourgogne)', '(화이트|white|blanc)'],
      rubric:
        'Must recommend Burgundy Premier Cru white (Chardonnay) from 2017-2020 under 100,000 KRW. '
        + 'Meursault 1er Cru, Puligny-Montrachet 1er Cru, Chassagne-Montrachet 1er Cru expected.',
    },
  },
  {
    id: 444,
    tier: 'nested_condition',
    query: '나파 밸리 카베르네 2015년산 30만원 이하 고숙성 가능한 거',
    description: 'Region + grape + vintage + price + aging potential: 5 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { max: 300_000 },
      vintageRange: { min: 2015, max: 2015 },
      answerMustMatch: ['(나파|napa)', '(카베르네|cabernet)'],
      rubric:
        'Must recommend 2015 Napa Cabernet Sauvignon with strong aging potential under 300,000 KRW. '
        + 'Should mention tannic structure and cellaring recommendations. '
        + 'Beringer Reserve, Jordan, Stag\'s Leap, etc. expected.',
    },
  },
  {
    id: 445,
    tier: 'nested_condition',
    query: '알자스 게뷔르츠트라미너 2018-2021 드라이 5만원대',
    description: 'Region + grape + vintage + style + price band: 5 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { min: 40_000, max: 69_000 },
      vintageRange: { min: 2018, max: 2021 },
      answerMustMatch: ['(알자스|alsace)', '(게뷔르츠트라미너|gewurztraminer|gewürztraminer)'],
      rubric:
        'Must recommend dry Alsace Gewürztraminer from 2018-2021 in the 40,000-69,000 KRW range. '
        + 'Trimbach, Hugel, Zind-Humbrecht expected. '
        + 'Should note the floral, spice character and low sugar level.',
    },
  },
  {
    id: 446,
    tier: 'nested_condition',
    query: '칠레 콜차과 밸리 카르메네르 2016년 이후 5만원 이하',
    description: 'Country + valley + grape + vintage floor + price: 5 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      priceBandKrw: { max: 50_000 },
      vintageRange: { min: 2016 },
      answerMustMatch: ['(카르메네르|carmenere|carménère)', '(칠레|chile)'],
      rubric:
        'Must recommend Colchagua Valley (or nearby Chilean region) Carménère from 2016+ under 50,000 KRW. '
        + 'Montes, Viu Manent, Santa Rita expected.',
    },
  },
  {
    id: 447,
    tier: 'nested_condition',
    query: '그르나슈 기반 풀바디 레드 남프랑스 2017년산 8만원 이하',
    description: 'Grape + body + region + vintage + price: 5 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { max: 80_000 },
      vintageRange: { min: 2017, max: 2017 },
      answerMustMatch: ['(그르나슈|grenache)', '(남프랑스|languedoc|roussillon|provence|rhône)'],
      rubric:
        'Must recommend Grenache-dominant full-bodied red from Southern France, 2017 vintage, under 80,000 KRW. '
        + 'Châteauneuf-du-Pape, Gigondas, Vacqueyras or Languedoc examples expected.',
    },
  },
  {
    id: 448,
    tier: 'nested_condition',
    query: '스파클링 중에 빈티지 있는 거 브뤼 스타일 프랑스산 10만원 이하',
    description: 'Type + vintage label + style + country + price: 5 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { max: 100_000 },
      answerMustMatch: ['(스파클링|sparkling|champagne|크레망|crémant)', '(브뤼|brut)'],
      rubric:
        'Must recommend vintage-dated French sparkling wine in Brut style under 100,000 KRW. '
        + 'Vintage Champagne (entry-level) or vintage Crémant expected. '
        + 'Should clarify that vintage sparkling is different from NV.',
    },
  },
  {
    id: 449,
    tier: 'nested_condition',
    query: '로제 스파클링 프로방스 or 샴페인 2020년 이후 7만원 이하',
    description: 'Color + type + region OR + vintage floor + price: 5 constraints with OR',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { max: 70_000 },
      answerMustMatch: ['(로제|rosé|rose)', '(스파클링|sparkling|champagne|프로방스|provence)'],
      rubric:
        'Must recommend rosé sparkling wine from either Provence or Champagne from 2020 or later under 70,000 KRW. '
        + 'Champagne Rosé NV with 2020+ base wine or Crémant de Provence expected.',
    },
  },
  {
    id: 450,
    tier: 'nested_condition',
    query: '모스카토 다스티 스타일 저알코올 달달 스파클링 2021년 이후',
    description: 'Style + alcohol + sweetness + type + vintage floor: 5 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      vintageRange: { min: 2021 },
      answerMustMatch: ['(모스카토|moscato|muscat)'],
      rubric:
        'Must recommend low-alcohol, sweet sparkling wines similar to Moscato d\'Asti from 2021 or later. '
        + 'Moscato d\'Asti DOCG, other light-fizz Muscat styles expected. '
        + 'Should note the ~5-7% ABV characteristic.',
    },
  },
  {
    id: 451,
    tier: 'nested_condition',
    query: '남아프리카공화국 스텔렌보스 카베르네 2018년 이후 풀바디 12만원 이하',
    description: 'Country + region + grape + vintage + body + price: 6 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 3,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { max: 120_000 },
      vintageRange: { min: 2018 },
      answerMustMatch: ['(스텔렌보스|stellenbosch)', '(카베르네|cabernet)'],
      rubric:
        'Must recommend Stellenbosch Cabernet Sauvignon from 2018 or later, full-bodied, under 120,000 KRW. '
        + 'Kanonkop, Jordan, Rust en Vrede expected.',
    },
  },
  {
    id: 452,
    tier: 'nested_condition',
    query: '산도 높고 미네랄 느낌 드라이 화이트 부르고뉴 or 알자스 5만원 이하',
    description: 'Acidity + mineral + style + region OR + price: 5 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { max: 50_000 },
      answerMustMatch: ['(화이트|white|blanc)', '(부르고뉴|burgundy|bourgogne|알자스|alsace)'],
      rubric:
        'Must recommend dry white wines with high acidity and minerality from Burgundy or Alsace under 50,000 KRW. '
        + 'Chablis, Mâcon, Alsace Riesling Trocken expected. '
        + 'All constraints (acidity, mineral, dry, region, price) addressed.',
    },
  },
  {
    id: 453,
    tier: 'nested_condition',
    query: '식전주로 마실 가벼운 스파클링 이탈리아 5만원 이하 2020년대',
    description: 'Occasion + body + type + country + price + decade: 6 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { max: 50_000 },
      vintageRange: { min: 2020 },
      answerMustMatch: ['(이탈리아|italy|italian)', '(스파클링|sparkling|프로세코|prosecco|franciacorta)'],
      rubric:
        'Must recommend light Italian sparkling wine suitable as an aperitif, from 2020s, under 50,000 KRW. '
        + 'Prosecco DOC, Franciacorta Brut, Asti Spumante expected.',
    },
  },
  {
    id: 454,
    tier: 'nested_condition',
    query: '타닌 강하고 오크향 있는 풀바디 레드 5년 이상 숙성 가능 10만원대',
    description: 'Tannin + oak + body + aging + price band: 5 constraints',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 3,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { min: 100_000, max: 199_000 },
      rubric:
        'Must recommend full-bodied, tannic, oaked red wines with 5+ year aging potential in the 100,000-199,000 KRW range. '
        + 'Barolo, Brunello, Napa Cabernet, Rioja Gran Reserva expected. '
        + 'All 5 constraints must be satisfied.',
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // situation_based — 25 additional scenarios (IDs 460-484) → tier total ≥ 30
  // ═══════════════════════════════════════════════════════════════════════

  {
    id: 460,
    tier: 'situation_based',
    query: '와인바 첫 방문인데 초보인 친구랑 같이 갈 거야, 뭘 시켜야 해?',
    description: 'Situation: first wine bar visit with a beginner friend',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      rubric:
        'Must recommend approachable, crowd-pleasing wines suitable for a beginner at a wine bar. '
        + 'Should address the social context (first visit, friend who is new to wine). '
        + 'Avoid intimidating or highly tannic choices. Glass pours or by-the-bottle guidance expected.',
    },
  },
  {
    id: 461,
    tier: 'situation_based',
    query: '시댁에 드릴 추석 선물로 와인 추천해줘',
    description: 'Situation: Chuseok holiday gift for in-laws',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      requiredRegister: 'formal',
      rubric:
        'Must recommend wines appropriate for gifting to in-laws during the Chuseok holiday. '
        + 'Should suggest well-packaged, respectable options (not trendy or niche). '
        + 'Formal presentation and gift-worthiness are key. '
        + 'Mid-to-premium price range expected.',
    },
  },
  {
    id: 462,
    tier: 'situation_based',
    query: '남자친구 생일 깜짝 파티 준비하는데 와인 추천',
    description: 'Situation: surprise birthday party for boyfriend',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend festive, celebratory wines suitable for a birthday surprise party. '
        + 'Sparkling wine or impressive red expected. '
        + 'Should consider the romantic/celebratory context.',
    },
  },
  {
    id: 463,
    tier: 'situation_based',
    query: '비 오는 날 혼자 마시기 좋은 와인',
    description: 'Situation: rainy day solo drinking',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend wines suited for a cozy, introspective solo evening on a rainy day. '
        + 'Warming reds, aromatic whites, or dessert wines expected. '
        + 'Should evoke comfort and match the mood.',
    },
  },
  {
    id: 464,
    tier: 'situation_based',
    query: '독서할 때 곁들일 와인 추천해줘',
    description: 'Situation: wine for quiet reading',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend wines conducive to quiet, focused enjoyment (not overpowering). '
        + 'Light to medium-bodied wines, good acidity, easy-drinking character expected. '
        + 'Should avoid loud, palate-fatiguing wines.',
    },
  },
  {
    id: 465,
    tier: 'situation_based',
    query: '요가 끝나고 가볍게 마실 와인',
    description: 'Situation: post-yoga light drinking',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend light, refreshing wines suitable after exercise. '
        + 'Low alcohol, high acidity, crisp profile preferred. '
        + 'Sparkling, light whites, rosé, or low-ABV wines expected. '
        + 'Should avoid heavy, tannic, or high-alcohol options.',
    },
  },
  {
    id: 466,
    tier: 'situation_based',
    query: '협상 성사 축하 자리에 낼 와인, 인상적인 거로',
    description: 'Situation: deal-closing celebration wine',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { min: 100_000 },
      rubric:
        'Must recommend prestigious, impressive wines appropriate for celebrating a major business deal. '
        + 'Premium Champagne, top Bordeaux, or equivalent expected. '
        + 'Should convey achievement and quality. Price should reflect the importance of the occasion.',
    },
  },
  {
    id: 467,
    tier: 'situation_based',
    query: '이직 성공 기념 혼자 자축하는 와인 추천',
    description: 'Situation: solo career celebration',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend wines suitable for a personal achievement celebration. '
        + 'Should feel special and self-rewarding without being excessively expensive. '
        + 'Sparkling or a meaningful bottle the user might not normally buy expected.',
    },
  },
  {
    id: 468,
    tier: 'situation_based',
    query: '해외여행 갈 때 선물로 가져갈 와인 추천',
    description: 'Situation: wine as travel gift to bring abroad',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend wines suitable as gifts to bring when traveling abroad. '
        + 'Should consider portability (no fragile labels, good closure), recognizable Korean terroir or interesting story. '
        + 'Korean wine or iconic imports that could impress a foreign recipient expected.',
    },
  },
  {
    id: 469,
    tier: 'situation_based',
    query: '여름 바비큐 파티용 와인 뭐가 좋아?',
    description: 'Situation: summer outdoor BBQ party',
    expectation: {
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend wines suitable for a summer outdoor BBQ party. '
        + 'Should consider food (grilled meats), heat, and casual atmosphere. '
        + 'Rosé, bold reds (Malbec, Zinfandel, Shiraz), or crisp whites expected. '
        + 'Practical considerations (screw cap, chillable) are a plus.',
    },
  },
  {
    id: 470,
    tier: 'situation_based',
    query: '겨울 크리스마스 만찬에 낼 와인',
    description: 'Situation: Christmas dinner wine',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      rubric:
        'Must recommend wines suitable for a Christmas dinner celebration. '
        + 'Should suggest both a sparkling aperitif option and a main course wine. '
        + 'Festive character, warming reds or elegant whites for roast/game expected.',
    },
  },
  {
    id: 471,
    tier: 'situation_based',
    query: '와인 처음 마시는 부모님께 추천할 와인',
    description: 'Situation: recommending wine to parents who have never tried it',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend beginner-friendly wines for parents who have never drunk wine before. '
        + 'Sweet, fruity, low-tannin or low-acid options expected. '
        + 'Should consider Korean taste preferences (not too dry, not too tannic). '
        + 'Moscato, light rosé, or Beaujolais type expected.',
    },
  },
  {
    id: 472,
    tier: 'situation_based',
    query: '소믈리에 친구 집들이 선물로 줄 와인',
    description: 'Situation: housewarming gift for a sommelier friend',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      rubric:
        'Must recommend wines impressive enough to gift to a professional sommelier. '
        + 'Should avoid obvious/common picks. Unusual terroir, rare grape varieties, or exceptional vintage expected. '
        + 'The recommendation should demonstrate wine knowledge and thoughtfulness.',
    },
  },
  {
    id: 473,
    tier: 'situation_based',
    query: '데이트 전 와인 선물, 상대방이 뭘 좋아하는지 몰라',
    description: 'Situation: date gift with unknown preference',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend crowd-pleasing, universally appealing wines suitable as a romantic gift when the recipient\'s preferences are unknown. '
        + 'Should suggest safe but thoughtful options (a rosé, a light red, or a food-friendly white). '
        + 'Pretty packaging or notable label is a plus.',
    },
  },
  {
    id: 474,
    tier: 'situation_based',
    query: '집에서 혼자 영화 볼 때 마실 와인',
    description: 'Situation: solo movie night at home',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      priceBandKrw: { max: 30_000 },
      rubric:
        'Must recommend easy-drinking, affordable wines for a casual solo movie night. '
        + 'Budget-friendly (under 30,000 KRW), low-fuss, approachable character expected. '
        + 'Screw cap or practical packaging is a plus.',
    },
  },
  {
    id: 475,
    tier: 'situation_based',
    query: '직장 상사 승진 선물, 품격 있고 무난한 거',
    description: 'Situation: promotion gift for senior colleague',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { min: 50_000, max: 150_000 },
      requiredRegister: 'formal',
      rubric:
        'Must recommend dignified, universally respectable wines appropriate for gifting to a senior colleague on a promotion. '
        + 'Price range 50,000-150,000 KRW. Should feel prestigious without being ostentatious. '
        + 'Well-known producers or classic regions expected.',
    },
  },
  {
    id: 476,
    tier: 'situation_based',
    query: '친구들이랑 치맥 대신 와인, 4명이서 치킨이랑',
    description: 'Situation: wine with Korean fried chicken for 4 friends',
    expectation: {
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend wines that pair well with fried chicken for a casual group of 4. '
        + 'Should suggest fun, casual options (sparkling, light reds, crisp whites). '
        + 'Gamay, Riesling, sparkling rosé, or similar expected. '
        + 'Should acknowledge the 치맥 (chimaek) culture context.',
    },
  },
  {
    id: 477,
    tier: 'situation_based',
    query: '골프 라운딩 끝나고 클럽하우스에서 마실 와인',
    description: 'Situation: post-golf clubhouse wine',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend wines suitable for post-golf socializing at a clubhouse. '
        + 'Should be elegant, easy-drinking, and socially appropriate. '
        + 'Rosé, light Pinot Noir, or crisp white expected. '
        + 'Should fit an upscale but relaxed social context.',
    },
  },
  {
    id: 478,
    tier: 'situation_based',
    query: '명절 가족 모임에 들고 갈 와인, 어른들도 드실 거야',
    description: 'Situation: holiday family gathering with elderly relatives',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      requiredRegister: 'formal',
      rubric:
        'Must recommend approachable, traditionally styled wines appropriate for a multi-generational Korean family gathering. '
        + 'Should avoid overly trendy or niche wines. '
        + 'Well-known brands in recognizable styles (Bordeaux, Burgundy, or equivalent) expected. '
        + 'Gift presentation/packaging mentioned as a plus.',
    },
  },
  {
    id: 479,
    tier: 'situation_based',
    query: '친구 위로해주려고 집에 초대했는데 위로주 같은 와인',
    description: 'Situation: comforting wine for a friend going through a hard time',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend warm, comforting wines suitable for consoling a friend. '
        + 'Soft, approachable reds (Pinot Noir, Grenache), smooth whites, or dessert wines expected. '
        + 'The recommendation should convey emotional warmth, not just technical quality.',
    },
  },
  {
    id: 480,
    tier: 'situation_based',
    query: '온라인 와인 시음회 준비, 참가자 모두가 살 수 있는 거 5만원 이하',
    description: 'Situation: online tasting event with accessible wine for all participants',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      priceBandKrw: { max: 50_000 },
      rubric:
        'Must recommend wines under 50,000 KRW that are widely available for online tasting participants. '
        + 'Should consider that participants may be at different locations but can access the same bottle. '
        + 'Major supermarket or widely distributed brands expected.',
    },
  },
  {
    id: 481,
    tier: 'situation_based',
    query: '와인 공부 시작하는데 처음 마셔볼 교과서 같은 와인',
    description: 'Situation: introductory educational wine for a beginner student',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      rubric:
        'Must recommend "textbook" wines that exemplify their variety or region clearly — ideal for learning. '
        + 'Should suggest a progression (beginner set). '
        + 'Bordeaux Cabernet, Burgundy Pinot Noir, Chablis, Barolo, Rioja expected as canonical examples.',
    },
  },
  {
    id: 482,
    tier: 'situation_based',
    query: '프러포즈 할 건데 와인 뭐 들고 가야 해?',
    description: 'Situation: wine for a marriage proposal',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 5_000,
      rubric:
        'Must recommend highly romantic and memorable wines appropriate for a marriage proposal. '
        + 'Champagne or premium sparkling wine is the expected primary recommendation. '
        + 'Should convey celebration, romance, and the magnitude of the occasion. '
        + 'Specific prestigious labels (Taittinger, Billecart-Salmon, etc.) expected.',
    },
  },
  {
    id: 483,
    tier: 'situation_based',
    query: '개인 와인 셀러 처음 꾸리는데 시작 구성 추천',
    description: 'Situation: building a first personal wine cellar',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 3,
      maxDurationMs: 50_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend a starter cellar composition (varied styles, regions, aging potential). '
        + 'Should suggest wines to drink soon, wines to hold 3-5 years, and wines to hold 10+ years. '
        + 'Should address how many bottles of each type and the rationale.',
    },
  },
  {
    id: 484,
    tier: 'situation_based',
    query: '졸업식 날 가족이랑 식당에서 마실 와인',
    description: 'Situation: graduation celebration at a restaurant with family',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      rubric:
        'Must recommend wines suitable for a family graduation celebration at a restaurant. '
        + 'Should be crowd-pleasing for mixed ages and tastes. '
        + 'Start with sparkling for the toast, then suggest a food-friendly red or white. '
        + 'Should feel festive but not excessively extravagant.',
    },
  },
];

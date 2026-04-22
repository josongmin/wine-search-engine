/**
 * Epic 12, Step 12.3: Food Pairing Extractor
 *
 * Extracts food pairing constraints from natural language queries at query time.
 * Maps user queries like "wines for salmon" to standardized pairing tags
 * that match against Vespa's `pairing_tags` index.
 *
 * Taxonomy based on common food-wine pairings across protein, vegetarian,
 * context, and occasion categories.
 */

export const PAIRING_TAXONOMY = [
  // Proteins
  'beef',
  'lamb',
  'pork',
  'chicken',
  'duck',
  'game',
  'salmon',
  'tuna',
  'shellfish',
  'white_fish',
  'spicy_food',

  // Vegetarian
  'mushroom',
  'truffle',
  'hard_cheese',
  'soft_cheese',
  'pasta',
  'risotto',
  'grilled_vegetables',

  // Context
  'aperitif',
  'dessert',
  'solo_drinking',
] as const;

export type PairingTag = (typeof PAIRING_TAXONOMY)[number];

/**
 * Pattern matching rules for each pairing tag.
 * Multiple pattern variants support different languages and phrasing.
 */
export const PAIRING_PATTERNS: Record<PairingTag, RegExp[]> = {
  // Beef
  beef: [
    /(?<!\p{L})(?<!\p{N})(?:beef|steak|ribeye|filet|sirloin|t[\s-]?bone)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:소고기|스테이크|비프|쇠고기)(?:용|에|와|과|랑|이랑|하고)?(?=$|[^\p{L}\p{N}])/u,
    /(?:^|[^\p{L}\p{N}])소(?=$|[^\p{L}\p{N}])/u,
  ],

  // Lamb
  lamb: [/(?<!\p{L})(?<!\p{N})(?:lamb|mutton|agneau)(?!\p{L})(?!\p{N})/iu, /(?:^|[^\p{L}\p{N}])(?:양고기|램)(?=$|[^\p{L}\p{N}])/u],

  // Pork
  pork: [
    /(?<!\p{L})(?<!\p{N})(?:pork|ham|bacon|chop|loin)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:돼지고기|돼지|햄|베이컨|삼겹살)(?:이랑|하고|과|와)?(?=$|[^\p{L}\p{N}])/u,
  ],

  // Chicken
  chicken: [/(?<!\p{L})(?<!\p{N})(?:chicken|poultry|fowl)(?!\p{L})(?!\p{N})/iu, /(?:^|[^\p{L}\p{N}])(?:닭|닭고기|치킨|가금류)(?:이랑|하고|과|와)?(?=$|[^\p{L}\p{N}])/u],

  // Duck
  duck: [/(?<!\p{L})(?<!\p{N})(?:duck|confit|magret)(?!\p{L})(?!\p{N})/iu, /(?:^|[^\p{L}\p{N}])(?:오리|오리고기|덕)(?=$|[^\p{L}\p{N}])/u],

  // Game
  game: [
    /(?<!\p{L})(?<!\p{N})(?:venison|pheasant|boar|quail|game)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:사냥감|사슴고기|꿩|멧돼지)(?=$|[^\p{L}\p{N}])/u,
  ],

  // Salmon
  salmon: [/(?<!\p{L})(?<!\p{N})(?:salmon|lox|smoked)(?!\p{L})(?!\p{N})/iu, /(?:^|[^\p{L}\p{N}])(?:연어|샐몬|훈제)(?=$|[^\p{L}\p{N}])/u],

  // Tuna
  tuna: [/(?<!\p{L})(?<!\p{N})(?:tuna|sashimi|maguro)(?!\p{L})(?!\p{N})/iu, /(?:^|[^\p{L}\p{N}])(?:참치|다랭이|사시미)(?=$|[^\p{L}\p{N}])/u],

  // Shellfish
  shellfish: [
    /(?<!\p{L})(?<!\p{N})(?:shrimp|prawn|lobster|crab|oyster|mussel|clam|scallop)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:새우|랍스터|게|굴|홍합|조개|가리비)(?=$|[^\p{L}\p{N}])/u,
  ],

  // White fish
  white_fish: [
    /(?<!\p{L})(?<!\p{N})(?:cod|halibut|flounder|sole|sea bass|branzino|white fish|sashimi|raw fish)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:흰살고기|대구|넙치|광어|농어|회|사시미)(?:랑|하고|과|와|를)?(?=$|[^\p{L}\p{N}])/u,
  ],

  // Spicy food
  spicy_food: [
    /(?<!\p{L})(?<!\p{N})(?:spicy food|spicy|tteokbokki|topokki)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:매운\s*음식|매콤한\s*음식|떡볶이|매운\s*떡볶이)(?:랑|하고|과|와)?(?=$|[^\p{L}\p{N}])/u,
  ],

  // Mushroom
  mushroom: [
    /(?<!\p{L})(?<!\p{N})(?:mushroom|truffle|porcini|cepe|fungi)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:버섯|송로|포르치니|균)(?=$|[^\p{L}\p{N}])/u,
  ],

  // Truffle
  truffle: [/(?<!\p{L})(?<!\p{N})(?:truffle|truffe)(?!\p{L})(?!\p{N})/iu, /(?:^|[^\p{L}\p{N}])(?:송로|트러플|트뤼프)(?=$|[^\p{L}\p{N}])/u],

  // Hard cheese
  hard_cheese: [
    /(?<!\p{L})(?<!\p{N})(?:parmesan|aged cheese|cheddar|gruyere|manchego)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:파르메산|숙성치즈|체다|그뤼에르|만체고)(?=$|[^\p{L}\p{N}])/u,
  ],

  // Soft cheese
  soft_cheese: [
    /(?<!\p{L})(?<!\p{N})(?:brie|camembert|goat cheese|chevre|mozzarella)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:브리|깡베르|염소치즈|샤브르|모차렐라)(?=$|[^\p{L}\p{N}])/u,
  ],

  // Pasta
  pasta: [
    /(?<!\p{L})(?<!\p{N})(?:pasta|noodle|spaghetti|penne|ravioli|lasagna)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:파스타|국수|스파게티|펜네|라비올리|라자냐)(?=$|[^\p{L}\p{N}])/u,
  ],

  // Risotto
  risotto: [
    /(?<!\p{L})(?<!\p{N})(?:risotto|arborio|risoto)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:리소토|아르보리오|리조또)(?=$|[^\p{L}\p{N}])/u,
  ],

  // Grilled vegetables
  grilled_vegetables: [
    /(?<!\p{L})(?<!\p{N})(?:grilled|vegetable|veggie|asparagus|zucchini|eggplant)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:그릴|야채|채소|아스파라거스|주키니|가지)(?=$|[^\p{L}\p{N}])/u,
  ],

  // Aperitif
  aperitif: [
    /(?<!\p{L})(?<!\p{N})(?:aperitif|appetizer|starter|pre[\s-]?dinner)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:아페리티프(?:용)?|에피타이저(?:용)?|전식(?:용)?|식전주)(?=$|[^\p{L}\p{N}])/u,
  ],

  // Dessert
  dessert: [
    /(?<!\p{L})(?<!\p{N})(?:dessert|sweet|chocolate|cake|pudding|fruit)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:디저트(?:용)?|후식(?:용)?|초콜릿|케이크|푸딩|과일)(?=$|[^\p{L}\p{N}])/u,
  ],

  // Solo drinking
  solo_drinking: [
    /(?<!\p{L})(?<!\p{N})(?:solo|alone|by itself|aperitif|meditation|contemplation)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:혼자|혼자마시|싱글|단독|명상)(?=$|[^\p{L}\p{N}])/u,
  ],
};

/**
 * Extracts all matching pairing tags from a query.
 * Useful for queries like "wines for beef and mushrooms".
 *
 * @param query - Normalized query string
 * @returns Array of all matching PairingTags
 */
export function extractAllPairingConstraints(query: string): PairingTag[] {
  const matches: PairingTag[] = [];
  const seen = new Set<PairingTag>();

  for (const tag of PAIRING_TAXONOMY) {
    const patterns = PAIRING_PATTERNS[tag];
    if (!seen.has(tag) && patterns.some((p) => p.test(query))) {
      matches.push(tag);
      seen.add(tag);
    }
  }

  return matches;
}

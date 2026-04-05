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
    /\b(?:beef|steak|ribeye|filet|sirloin|t[\s-]?bone)\b/i,
    /\b(?:소고기|스테이크|비프|소|쇠고기)\b/,
  ],

  // Lamb
  lamb: [/\b(?:lamb|mutton|agneau)\b/i, /\b(?:양고기|램)\b/],

  // Pork
  pork: [
    /\b(?:pork|ham|bacon|chop|loin)\b/i,
    /\b(?:돼지고기|돼지|햄|베이컨)\b/,
  ],

  // Chicken
  chicken: [/\b(?:chicken|poultry|fowl)\b/i, /\b(?:닭|닭고기|가금류)\b/],

  // Duck
  duck: [/\b(?:duck|confit|magret)\b/i, /\b(?:오리|오리고기|덕)\b/],

  // Game
  game: [
    /\b(?:venison|pheasant|boar|quail|game)\b/i,
    /\b(?:사냥감|사슴고기|꿩|멧돼지)\b/,
  ],

  // Salmon
  salmon: [/\b(?:salmon|lox|smoked)\b/i, /\b(?:연어|샐몬|훈제)\b/],

  // Tuna
  tuna: [/\b(?:tuna|sashimi|maguro)\b/i, /\b(?:참치|다랭이|사시미)\b/],

  // Shellfish
  shellfish: [
    /\b(?:shrimp|prawn|lobster|crab|oyster|mussel|clam|scallop)\b/i,
    /\b(?:새우|랍스터|게|굴|홍합|조개|가리비)\b/,
  ],

  // White fish
  white_fish: [
    /\b(?:cod|halibut|flounder|sole|sea bass|branzino|white fish)\b/i,
    /\b(?:흰살고기|대구|넙치|광어|농어)\b/,
  ],

  // Mushroom
  mushroom: [
    /\b(?:mushroom|truffle|porcini|cepe|fungi)\b/i,
    /\b(?:버섯|송로|포르치니|균)\b/,
  ],

  // Truffle
  truffle: [/\b(?:truffle|truffe)\b/i, /\b(?:송로|트러플|트뤼프)\b/],

  // Hard cheese
  hard_cheese: [
    /\b(?:parmesan|aged cheese|cheddar|gruyere|manchego)\b/i,
    /\b(?:파르메산|숙성치즈|체다|그뤼에르|만체고)\b/,
  ],

  // Soft cheese
  soft_cheese: [
    /\b(?:brie|camembert|goat cheese|chevre|mozzarella)\b/i,
    /\b(?:브리|깡베르|염소치즈|샤브르|모차렐라)\b/,
  ],

  // Pasta
  pasta: [
    /\b(?:pasta|noodle|spaghetti|penne|ravioli|lasagna)\b/i,
    /\b(?:파스타|국수|스파게티|펜네|라비올리|라자냐)\b/,
  ],

  // Risotto
  risotto: [
    /\b(?:risotto|arborio|risoto)\b/i,
    /\b(?:리소토|아르보리오|리조또)\b/,
  ],

  // Grilled vegetables
  grilled_vegetables: [
    /\b(?:grilled|vegetable|veggie|asparagus|zucchini|eggplant)\b/i,
    /\b(?:그릴|야채|채소|아스파라거스|주키니|가지)\b/,
  ],

  // Aperitif
  aperitif: [
    /\b(?:aperitif|appetizer|starter|pre[\s-]?dinner)\b/i,
    /\b(?:아페리티프|에피타이저|전식|식전주)\b/,
  ],

  // Dessert
  dessert: [
    /\b(?:dessert|sweet|chocolate|cake|pudding|fruit)\b/i,
    /\b(?:디저트|후식|초콜릿|케이크|푸딩|과일)\b/,
  ],

  // Solo drinking
  solo_drinking: [
    /\b(?:solo|alone|by itself|aperitif|meditation|contemplation)\b/i,
    /\b(?:혼자|혼자마시|싱글|단독|명상)\b/,
  ],
};

/**
 * Extracts a pairing tag from a query string.
 * Returns the first matching tag or null if no match found.
 *
 * @param query - Normalized query string
 * @returns A single PairingTag or null
 */
export function extractPairingConstraint(query: string): PairingTag | null {
  for (const tag of PAIRING_TAXONOMY) {
    const patterns = PAIRING_PATTERNS[tag];
    if (patterns.some((p) => p.test(query))) {
      return tag;
    }
  }
  return null;
}

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

/**
 * Epic 12, Step 12.3: Food Pairing Extractor
 *
 * Extracts food pairing constraints from natural language queries at query time.
 * Maps user queries like "wines for salmon" to standardized pairing tags
 * that match against Vespa's `pairing_tags` index.
 *
 * Taxonomy based on common food-wine pairings across protein, vegetarian,
 * context, and occasion categories.
 *
 * Maturity 3 (2026-05): supports phrase-level negation/exclusion. Foods
 * appearing inside a negation scope ("without seafood", "해산물 빼고",
 * "스테이크는 좋은데 새우는 안 좋아하는") are removed from the positive
 * pairing list and surfaced via `extractPairingConstraintsWithExclusions`'s
 * `excluded` channel.
 */

import { normalizeKoreanNegation } from './korean-negation-normalizer.js';

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
  'cheese',
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
 * Korean postpositions / suffixes commonly attached directly to an English
 * food token in mixed-script queries:
 *   - `Cheese에 어울리는 와인`
 *   - `Pasta랑 마실 화이트`
 *
 * Keep this list narrow and pairing-specific so English food matches can
 * survive mixed-script input without promoting arbitrary English words.
 */
const MIXED_SCRIPT_PAIRING_SUFFIX =
  '(?:용|에|에는|와|과|랑|이랑|하고|은|는|이|가|을|를)?';

function buildEnglishPairingPattern(terms: readonly string[]): RegExp {
  return new RegExp(
    `(?<!\\p{L})(?<!\\p{N})(?:${terms.join('|')})${MIXED_SCRIPT_PAIRING_SUFFIX}(?!\\p{L})(?!\\p{N})`,
    'iu',
  );
}

/**
 * Pattern matching rules for each pairing tag.
 * Multiple pattern variants support different languages and phrasing.
 */
export const PAIRING_PATTERNS: Record<PairingTag, RegExp[]> = {
  // Beef — Korean expansion 2026-05: add 갈비/갈비탕/등심/안심/안창살/채끝/목살/
  // 양념갈비/떡갈비/비빔밥(소고기 베이스 일반 표현)/잡채(소고기). 한식 - 소고기 요리.
  beef: [
    /(?<!\p{L})(?<!\p{N})(?:beef|steak|ribeye|filet|sirloin|t[\s-]?bone)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:등심구이|안심구이|양념갈비|떡갈비|갈비탕|비빔밥|잡채|소고기|스테이크|비프|쇠고기|등심|안심|안창살|채끝|목살|갈비)(?:용|에|에는|와|과|랑|이랑|하고|은|는|이|가|을|를)?(?=$|[^\p{L}\p{N}])/u,
    /(?:^|[^\p{L}\p{N}])소(?=$|[^\p{L}\p{N}])/u,
  ],

  // Lamb
  lamb: [/(?<!\p{L})(?<!\p{N})(?:lamb|mutton|agneau)(?!\p{L})(?!\p{N})/iu, /(?:^|[^\p{L}\p{N}])(?:양고기|램)(?=$|[^\p{L}\p{N}])/u],

  // Pork — Korean expansion 2026-05: 한식 - 돼지고기 요리 (삼겹살/목살/보쌈/족발/
  // 수육/부대찌개/돈카츠 등 일식 포함) + 중식 탕수육.
  pork: [
    buildEnglishPairingPattern([
      'pork',
      'ham',
      'bacon',
      'chop',
      'loin',
      'tonkatsu',
      'charcuterie',
      'prosciutto',
      'salami',
      'cured meat',
      'cured meats',
    ]),
    /(?:^|[^\p{L}\p{N}])(?:돼지고기|부대찌개|돼지|햄|베이컨|삼겹살|보쌈|족발|수육|돈카츠|돈까스|탕수육)(?:용|에|에는|와|과|랑|이랑|하고|은|는|이|가|을|를)?(?=$|[^\p{L}\p{N}])/u,
  ],

  // Chicken — Korean expansion 2026-05: 한식 - 닭요리 (닭갈비/닭볶음탕/닭한마리).
  chicken: [
    /(?<!\p{L})(?<!\p{N})(?:chicken|poultry|fowl)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:닭볶음탕|닭한마리|닭갈비|깐풍기|닭고기|치킨|가금류|닭)(?:용|에|에는|와|과|랑|이랑|하고|은|는|이|가|을|를)?(?=$|[^\p{L}\p{N}])/u,
  ],

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

  // Shellfish — Korean expansion 2026-05: 해물 한식/일식 (해물파전/회덮밥의 갑각류
  // 변형 등은 white_fish 와 겹칠 수 있으므로 화이트피쉬는 별도 유지).
  shellfish: [
    /(?<!\p{L})(?<!\p{N})(?:shrimp|prawn|lobster|crab|oyster|mussel|clam|scallop|seafood|shellfish)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:새우|랍스터|게|굴|홍합|조개|가리비|해산물|해물파전)(?:용|에|에는|는|은|이|가|을|를|랑|이랑|하고|과|와)?(?=$|[^\p{L}\p{N}])/u,
  ],

  // White fish — Korean expansion 2026-05: 한식/일식 회·생선요리 (회/초밥/사시미/
  // 생선구이/회덮밥).
  white_fish: [
    /(?<!\p{L})(?<!\p{N})(?:cod|halibut|flounder|sole|sea bass|branzino|white fish|sashimi|raw fish|sushi)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:흰살고기|대구|넙치|광어|농어|회덮밥|초밥|사시미|생선구이|회)(?:용|에|에는|와|과|랑|이랑|하고|은|는|이|가|을|를)?(?=$|[^\p{L}\p{N}])/u,
  ],

  // Spicy food — Korean expansion 2026-05: 한식 - 매운 국물/요리.
  //   감자탕/김치찌개/된장찌개/청국장/부대찌개(매콤+짭짤)/마라탕/마파두부/
  //   순대(매콤한 양념에 곁들이는 경우)/낙지볶음/쭈꾸미/순두부찌개 등 매운
  //   음식 전반 + 일반 카테고리 "매운 음식 / 매콤한 음식 / 짠 음식 / 단 음식".
  //   "짠/단/신/기름진" 카테고리는 anchor 신호로만 사용; spicy 와 동일 큰
  //   카테고리로 묶어 라우팅 가능하도록 spicy_food 태그에 매핑.
  spicy_food: [
    /(?<!\p{L})(?<!\p{N})(?:spicy food|spicy|tteokbokki|topokki|mala|mapo)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:매운\s*음식|매콤한\s*음식|짠\s*음식|단\s*음식|신\s*음식|기름진\s*음식|매운\s*떡볶이|떡볶이|감자탕|김치찌개|된장찌개|청국장|마라탕|마파두부|낙지볶음|쭈꾸미|순두부찌개|김치전|김치)(?:용|에|에는|와|과|랑|이랑|하고|은|는|이|가|을|를)?(?=$|[^\p{L}\p{N}])/u,
  ],

  // Mushroom
  mushroom: [
    /(?<!\p{L})(?<!\p{N})(?:mushroom|truffle|porcini|cepe|fungi)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:버섯|송로|포르치니|균)(?=$|[^\p{L}\p{N}])/u,
  ],

  // Truffle
  truffle: [/(?<!\p{L})(?<!\p{N})(?:truffle|truffe)(?!\p{L})(?!\p{N})/iu, /(?:^|[^\p{L}\p{N}])(?:송로|트러플|트뤼프)(?=$|[^\p{L}\p{N}])/u],

  // Cheese — generic cheese intent. Specific cheese tags remain separate.
  cheese: [
    buildEnglishPairingPattern(['cheese', 'fromage']),
    /(?:^|[^\p{L}\p{N}])(?:치즈)(?:용|에|에는|와|과|랑|이랑|하고|은|는|이|가|을|를)?(?=$|[^\p{L}\p{N}])/u,
  ],

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

  // Pasta — Korean expansion 2026-05: 한식/일식/중식 면류 (라면/칼국수/우동/짜장면/
  // 라멘) + 김밥(밥/면류 카테고리 인접) 포함.
  pasta: [
    buildEnglishPairingPattern(['pasta', 'noodle', 'spaghetti', 'penne', 'ravioli', 'lasagna', 'ramen', 'udon']),
    /(?:^|[^\p{L}\p{N}])(?:파스타|국수|스파게티|펜네|라비올리|라자냐|라면|칼국수|우동|짜장면|라멘|김밥)(?:용|에|에는|와|과|랑|이랑|하고|은|는|이|가|을|를)?(?=$|[^\p{L}\p{N}])/u,
  ],

  // Risotto — Korean expansion 2026-05: 양식 일반 (피자/햄버거/샌드위치) +
  // 일식 전골 (스키야키/샤브샤브). 명확히 별도 태그가 없으므로 "탄수화물+탄/지방"
  // 무게감 있는 양식 카테고리로 risotto 태그 아래에 통합 — 매핑이 거칠더라도
  // unsupported-intent 라우팅보다 낫다 (S2 보완).
  risotto: [
    /(?<!\p{L})(?<!\p{N})(?:risotto|arborio|risoto|pizza|burger|hamburger|sandwich|sukiyaki|shabu[\s-]?shabu)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:리소토|아르보리오|리조또|피자|햄버거|샌드위치|스키야키|샤브샤브)(?:용|에|에는|와|과|랑|이랑|하고|은|는|이|가|을|를)?(?=$|[^\p{L}\p{N}])/u,
  ],

  // Grilled vegetables — Korean expansion 2026-05: 한식 전/부침개 류 (파전/부침개/
  //   해물파전 등). "김치전" 은 spicy_food 에 이미 매핑됨 (매운 양념 우세).
  //   주의 (rule 23): 단독 "전" 은 한국어에서 시간 부사 ("전에/전 와인 …") 등으로
  //   광범위하게 쓰이므로 false-positive 가 매우 크다 → 단독 "전" 은 매칭하지 않고
  //   반드시 "파전/부침개/X전" 의 합성 형태로만 매핑한다.
  grilled_vegetables: [
    /(?<!\p{L})(?<!\p{N})(?:grilled|vegetable|veggie|asparagus|zucchini|eggplant)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:그릴|야채|채소|아스파라거스|주키니|가지|파전|부침개)(?:용|에|에는|와|과|랑|이랑|하고|은|는|이|가|을|를)?(?=$|[^\p{L}\p{N}])/u,
  ],

  // Aperitif
  aperitif: [
    /(?<!\p{L})(?<!\p{N})(?:aperitif|appetizer|starter|pre[\s-]?dinner)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:아페리티프(?:용)?|에피타이저(?:용)?|전식(?:용)?|식전주)(?=$|[^\p{L}\p{N}])/u,
  ],

  // Dessert — Korean expansion 2026-05: 한국에서 흔한 디저트 (치즈케이크/마카롱).
  dessert: [
    /(?<!\p{L})(?<!\p{N})(?:dessert|sweet|chocolate|cake|pudding|fruit|cheesecake|macaron|macaroon)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:디저트(?:용)?|후식(?:용)?|초콜릿|케이크|푸딩|과일|치즈케이크|마카롱)(?:에|에는|와|과|랑|이랑|하고|은|는|이|가|을|를)?(?=$|[^\p{L}\p{N}])/u,
  ],

  // Solo drinking
  solo_drinking: [
    /(?<!\p{L})(?<!\p{N})(?:solo|alone|by itself|aperitif|meditation|contemplation)(?!\p{L})(?!\p{N})/iu,
    /(?:^|[^\p{L}\p{N}])(?:혼자|혼자마시|싱글|단독|명상)(?=$|[^\p{L}\p{N}])/u,
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Negation / exclusion scope detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum character window scanned around a food match to decide whether the
 * match is inside a negation scope. Picked so multi-token phrases like
 * "but not lobster" (left-side English) or "새우는 안 좋아하는" (right-side
 * Korean) fit, while distant unrelated text does not.
 */
const NEGATION_WINDOW_CHARS = 40;

/**
 * English negation triggers that scope the food noun that follows them.
 * Order matters: longer multi-word forms first so "but not" wins over "no".
 *
 * Uses an explicit Unicode-aware left boundary `(?:^|[^\p{L}\p{N}])` instead of
 * `\b` (CLAUDE.md rule 8) so the regex remains correct if upstream callers
 * ever pass mixed-script text into the negation scanner. Triggers themselves
 * are ASCII; the trailing `\s+$` anchors the scan to the character window
 * immediately preceding a food match.
 */
const ENGLISH_NEGATION_LEFT_RE =
  /(?:^|[^\p{L}\p{N}])(?:but\s+not|but\s+no|without|except(?:ing)?|excluding|minus|hold\s+the|no)\s+$/iu;

/**
 * Korean negation/exclusion markers that scope the food noun preceding them.
 * Covers postpositional negation ("없이", "빼고", "말고"), copula-prefixed
 * negation ("X은/는 안 좋아…", "X 싫어…") and dislike verbs.
 *
 * Unicode-safe: only Hangul code points, no `\b` (rule 8).
 */
const KOREAN_NEGATION_RIGHT_RE =
  /^\s*(?:없이|빼고|말고|제외|안\s*\S+|싫어\S*|싫은|싫고|안돼|안\s*돼)/u;

/**
 * True if `food` match at [start, end) is inside a negation scope.
 * Bidirectional: scans up to NEGATION_WINDOW_CHARS to the left (English-style
 * pre-marker) and to the right (Korean-style post-marker).
 */
function isInsideNegationScope(query: string, start: number, end: number): boolean {
  const leftStart = Math.max(0, start - NEGATION_WINDOW_CHARS);
  const leftContext = query.slice(leftStart, start);
  if (ENGLISH_NEGATION_LEFT_RE.test(leftContext)) {
    return true;
  }
  const rightEnd = Math.min(query.length, end + NEGATION_WINDOW_CHARS);
  const rightContext = query.slice(end, rightEnd);
  if (KOREAN_NEGATION_RIGHT_RE.test(rightContext)) {
    return true;
  }
  return false;
}

/**
 * Wraps each per-tag pattern into a global, sticky-capable form so we can
 * enumerate every match position rather than just `.test()`-ing existence.
 */
function withGlobalFlag(re: RegExp): RegExp {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  return new RegExp(re.source, flags);
}

interface PairingMatch {
  tag: PairingTag;
  start: number;
  end: number;
}

function findAllMatchesForTag(query: string, tag: PairingTag): PairingMatch[] {
  const patterns = PAIRING_PATTERNS[tag];
  const out: PairingMatch[] = [];
  for (const base of patterns) {
    const re = withGlobalFlag(base);
    let m: RegExpExecArray | null;
    while ((m = re.exec(query)) !== null) {
      out.push({ tag, start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) {
        re.lastIndex += 1;
      }
    }
  }
  return out;
}

interface PairingExtraction {
  /** Foods the query positively asks for. Order matches PAIRING_TAXONOMY. */
  included: PairingTag[];
  /** Foods explicitly negated/excluded. Order matches PAIRING_TAXONOMY. */
  excluded: PairingTag[];
}

/**
 * Negation-aware extraction. Each pairing tag is classified as `included`,
 * `excluded`, or absent based on whether its surface form sits inside a
 * negation scope. A tag with at least one positive match is always included
 * (even if other occurrences are negated) so "steak and steak but not lobster"
 * still returns beef as positive.
 */
export function extractPairingConstraintsWithExclusions(query: string): PairingExtraction {
  if (typeof query !== 'string' || query.length === 0) {
    return { included: [], excluded: [] };
  }
  // NFC normalize first: macOS HFS+ / pasted text can emit NFD Hangul whose
  // bytes don't equal NFC catalog terms ('소' = U+C18C ≠ U+1109 U+1169).
  const nfc = query.normalize('NFC');
  // Then normalize Korean predicative negation ("안 좋아하는" stays — it is a
  // dislike verb, not the predicative copula — but "아닌"/"않고" become 말고).
  const normalized = normalizeKoreanNegation(nfc);

  const included: PairingTag[] = [];
  const excluded: PairingTag[] = [];
  for (const tag of PAIRING_TAXONOMY) {
    const matches = findAllMatchesForTag(normalized, tag);
    if (matches.length === 0) continue;
    let hasPositive = false;
    let hasNegative = false;
    for (const m of matches) {
      if (isInsideNegationScope(normalized, m.start, m.end)) {
        hasNegative = true;
      } else {
        hasPositive = true;
      }
    }
    if (hasPositive) {
      included.push(tag);
    } else if (hasNegative) {
      excluded.push(tag);
    }
  }
  return { included, excluded };
}

/**
 * Extracts all matching pairing tags from a query.
 * Useful for queries like "wines for beef and mushrooms".
 *
 * Negation-aware: foods inside a negation scope ("without seafood",
 * "해산물 빼고") are NOT returned. To also see the excluded set, use
 * {@link extractPairingConstraintsWithExclusions}.
 *
 * @param query - Normalized query string
 * @returns Array of PairingTags the query positively asks for
 */
export function extractAllPairingConstraints(query: string): PairingTag[] {
  return extractPairingConstraintsWithExclusions(query).included;
}

import type { ConstraintBundle } from '../../shared/types/index.js';

/** Version tag applied to all rule-based constraints (RFC-004, RFC-005). */
export const RULE_BASED_CONSTRAINT_MAPPING_VERSION = 'rule-based-v1.0';

/**
 * Rule-based constraint extractor: pattern-matches the normalized query
 * directly without a mapping table.
 *
 * Fallback when NLMapper returns nothing; see Planner.parseConstraints.
 */
export function extractRuleBasedConstraints(normalizedQuery: string): ConstraintBundle {
  const hard: ConstraintBundle['hard'][number][] = [];
  const soft: ConstraintBundle['soft'][number][] = [];
  const q = normalizedQuery;
  const mv = RULE_BASED_CONSTRAINT_MAPPING_VERSION;

  const wineTypeRules: [RegExp, string][] = [
    [/(?:^|[^\p{L}\p{N}])(?:red|rouge|레드|적포도주)(?=$|[^\p{L}\p{N}])/iu, 'red'],
    [/(?:^|[^\p{L}\p{N}])(?:white|blanc|화이트|백포도주)(?=$|[^\p{L}\p{N}])/iu, 'white'],
    // Use lookarounds (not \b) because \b is ASCII-aware and 'é' is not a word char,
    // which would break the trailing word boundary on "rosé".
    [/(?:^|[^\p{L}\p{N}])(?:ros[eé]|로제)(?=$|[^\p{L}\p{N}])/iu, 'rosé'],
    [/(?:^|[^\p{L}\p{N}])(?:sparkling|스파클링|champagne|샴페인|prosecco|cava|크레망)(?=$|[^\p{L}\p{N}])/iu, 'sparkling'],
    [/(?:^|[^\p{L}\p{N}])(?:natural wine|내추럴 와인|내추럴)(?=$|[^\p{L}\p{N}])/iu, 'natural'],
    [/(?:^|[^\p{L}\p{N}])(?:dessert wine|디저트 와인|sauternes|icewine)(?=$|[^\p{L}\p{N}])/iu, 'dessert'],
    [/(?:^|[^\p{L}\p{N}])(?:fortified|주정강화|port|sherry|madeira|marsala)(?=$|[^\p{L}\p{N}])/iu, 'fortified'],
    [/(?:^|[^\p{L}\p{N}])(?:orange wine|오렌지 와인|amber wine)(?=$|[^\p{L}\p{N}])/iu, 'orange'],
  ];
  for (const [pattern, value] of wineTypeRules) {
    if (pattern.test(q)) {
      hard.push({
        attribute: 'wine_type',
        operator: '=',
        value,
        source_phrase: value,
        confidence: 0.9,
        mapping_version: mv,
      });
      break;
    }
  }

  const countryRules: [RegExp, string][] = [
    [/(?:^|[^\p{L}\p{N}])(?:french|france|프랑스)(?=$|[^\p{L}\p{N}])/iu, 'France'],
    [/(?:^|[^\p{L}\p{N}])(?:italian|italy|이탈리아)(?=$|[^\p{L}\p{N}])/iu, 'Italy'],
    [/(?:^|[^\p{L}\p{N}])(?:spanish|spain|스페인)(?=$|[^\p{L}\p{N}])/iu, 'Spain'],
    [/(?:^|[^\p{L}\p{N}])(?:american|usa|us wine|california|napa|sonoma|oregon|미국)(?=$|[^\p{L}\p{N}])/iu, 'USA'],
    [/(?:^|[^\p{L}\p{N}])(?:australian|australia|호주)(?=$|[^\p{L}\p{N}])/iu, 'Australia'],
    [/(?:^|[^\p{L}\p{N}])(?:argentinian|argentina|아르헨티나)(?=$|[^\p{L}\p{N}])/iu, 'Argentina'],
    [/(?:^|[^\p{L}\p{N}])(?:chilean|chile|칠레)(?=$|[^\p{L}\p{N}])/iu, 'Chile'],
    [/(?:^|[^\p{L}\p{N}])(?:german|germany|독일)(?=$|[^\p{L}\p{N}])/iu, 'Germany'],
    [/(?:^|[^\p{L}\p{N}])(?:portuguese|portugal|포르투갈)(?=$|[^\p{L}\p{N}])/iu, 'Portugal'],
    [/(?:^|[^\p{L}\p{N}])(?:new zealand|뉴질랜드)(?=$|[^\p{L}\p{N}])/iu, 'New Zealand'],
    [/(?:^|[^\p{L}\p{N}])(?:south african?|south africa|남아공)(?=$|[^\p{L}\p{N}])/iu, 'South Africa'],
    [/(?:^|[^\p{L}\p{N}])(?:austrian|austria|오스트리아)(?=$|[^\p{L}\p{N}])/iu, 'Austria'],
  ];
  for (const [pattern, value] of countryRules) {
    if (pattern.test(q)) {
      hard.push({
        attribute: 'country',
        operator: '=',
        value,
        source_phrase: value,
        confidence: 0.85,
        mapping_version: mv,
      });
      break;
    }
  }

  const priceUnder =
    /\bunder\s+\$?(\d+)\b/i.exec(q) ??
    /(\d+)\s*(?:달러|dollar)\s*이하/i.exec(q) ??
    /(\d+)\s*만원\s*(?:이하|미만|대)/i.exec(q);
  if (priceUnder?.[1] !== undefined) {
    const priceValue = parseInt(priceUnder[1], 10);
    const usd = /만원/.test(q) ? priceValue * 7 : priceValue;
    const band =
      usd <= 20 ? 'budget' : usd <= 50 ? 'mid' : usd <= 100 ? 'premium' : 'luxury';
    soft.push({
      attribute: 'price_band',
      operator: '=',
      value: band,
      source_phrase: priceUnder[0],
      confidence: 0.8,
      mapping_version: mv,
    });
  }

  // Standalone price-level keywords (no numeric amount)
  if (!priceUnder && /(?:비싼|비싸|고급|럭셔리|프리미엄)/.test(q)) {
    soft.push({
      attribute: 'price_band',
      operator: '=',
      value: /(?:비싼|비싸|럭셔리)/.test(q) ? 'luxury' : 'premium',
      source_phrase: '비싼/고급',
      confidence: 0.7,
      mapping_version: mv,
    });
  } else if (!priceUnder && /(?:저렴|싼|가성비|입문)/.test(q)) {
    soft.push({
      attribute: 'price_band',
      operator: '=',
      value: /가성비/.test(q) ? 'mid' : 'budget',
      source_phrase: '저렴/가성비',
      confidence: 0.7,
      mapping_version: mv,
    });
  }

  // Critic score / rating keywords
  if (/(?:평점|점수|별점|리뷰)\s*(?:좋은|높은|훌륭|최고)/.test(q)) {
    soft.push({
      attribute: 'critic_score',
      operator: '>=',
      value: 0.7,
      source_phrase: '평점 좋은',
      confidence: 0.75,
      mapping_version: mv,
    });
  }

  if (/(?:^|[^\p{L}\p{N}])(?:full[\s-]?body|풀바디|bold|heavy|묵직)(?=$|[^\p{L}\p{N}])/iu.test(q)) {
    soft.push({
      attribute: 'body',
      operator: '=',
      value: 'full',
      source_phrase: 'full-body',
      confidence: 0.75,
      mapping_version: mv,
    });
  } else if (/(?:^|[^\p{L}\p{N}])(?:light[\s-]?body|라이트바디|light wine|가벼운|가볍)(?=$|[^\p{L}\p{N}])/iu.test(q)) {
    soft.push({
      attribute: 'body',
      operator: '=',
      value: 'light',
      source_phrase: 'light-body',
      confidence: 0.75,
      mapping_version: mv,
    });
  }

  if (/(?:^|[^\p{L}\p{N}])(?:dry wine|드라이|brut|extra[\s-]?brut)(?=$|[^\p{L}\p{N}])/iu.test(q)) {
    soft.push({
      attribute: 'sweetness',
      operator: '=',
      value: 'dry',
      source_phrase: 'dry',
      confidence: 0.8,
      mapping_version: mv,
    });
  } else if (/(?:^|[^\p{L}\p{N}])(?:sweet wine|달콤한|스위트|demi[\s-]?sec|semi[\s-]?sweet)(?=$|[^\p{L}\p{N}])/iu.test(q)) {
    soft.push({
      attribute: 'sweetness',
      operator: '=',
      value: 'sweet',
      source_phrase: 'sweet',
      confidence: 0.8,
      mapping_version: mv,
    });
  }

  return { hard, soft, inferred: [] };
}

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
    [/\b(?:red|rouge|레드|적포도주)\b/i, 'red'],
    [/\b(?:white|blanc|화이트|백포도주)\b/i, 'white'],
    [/\b(?:ros[eé]|로제)\b/i, 'rosé'],
    [/\b(?:sparkling|스파클링|champagne|샴페인|prosecco|cava|크레망)\b/i, 'sparkling'],
    [/\b(?:natural wine|내추럴 와인|내추럴)\b/i, 'natural'],
    [/\b(?:dessert wine|디저트 와인|sauternes|icewine)\b/i, 'dessert'],
    [/\b(?:fortified|주정강화|port|sherry|madeira|marsala)\b/i, 'fortified'],
    [/\b(?:orange wine|오렌지 와인|amber wine)\b/i, 'orange'],
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
    [/\b(?:french|france|프랑스)\b/i, 'France'],
    [/\b(?:italian|italy|이탈리아)\b/i, 'Italy'],
    [/\b(?:spanish|spain|스페인)\b/i, 'Spain'],
    [/\b(?:american|usa|us wine|california|napa|sonoma|oregon|미국)\b/i, 'USA'],
    [/\b(?:australian|australia|호주)\b/i, 'Australia'],
    [/\b(?:argentinian|argentina|아르헨티나)\b/i, 'Argentina'],
    [/\b(?:chilean|chile|칠레)\b/i, 'Chile'],
    [/\b(?:german|germany|독일)\b/i, 'Germany'],
    [/\b(?:portuguese|portugal|포르투갈)\b/i, 'Portugal'],
    [/\b(?:new zealand|뉴질랜드)\b/i, 'New Zealand'],
    [/\b(?:south african?|south africa|남아공)\b/i, 'South Africa'],
    [/\b(?:austrian|austria|오스트리아)\b/i, 'Austria'],
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

  if (/\b(?:full[\s-]?body|풀바디|bold|heavy|묵직)\b/i.test(q)) {
    soft.push({
      attribute: 'body',
      operator: '=',
      value: 'full',
      source_phrase: 'full-body',
      confidence: 0.75,
      mapping_version: mv,
    });
  } else if (/\b(?:light[\s-]?body|라이트바디|light wine|가벼운|가볍)\b/i.test(q)) {
    soft.push({
      attribute: 'body',
      operator: '=',
      value: 'light',
      source_phrase: 'light-body',
      confidence: 0.75,
      mapping_version: mv,
    });
  }

  if (/\b(?:dry wine|드라이|brut|extra[\s-]?brut)\b/i.test(q)) {
    soft.push({
      attribute: 'sweetness',
      operator: '=',
      value: 'dry',
      source_phrase: 'dry',
      confidence: 0.8,
      mapping_version: mv,
    });
  } else if (/\b(?:sweet wine|달콤한|스위트|demi[\s-]?sec|semi[\s-]?sweet)\b/i.test(q)) {
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

import { describe, it, expect } from 'vitest';
import { OntologyNormalizer } from '../ontology-normalizer.js';

const normalizer = new OntologyNormalizer();

describe('OntologyNormalizer', () => {
  // ── 1. English grape – exact match ────────────────────────────────────────
  it('"cabernet sauvignon" → grape/cabernet_sauvignon, source: exact', () => {
    const result = normalizer.normalize('cabernet sauvignon');
    expect(result).not.toBeNull();
    expect(result!.axis).toBe('grape');
    expect(result!.canonicalValue).toBe('cabernet_sauvignon');
    expect(result!.source).toBe('exact');
  });

  // ── 2. Korean grape ───────────────────────────────────────────────────────
  it('"카베르네 소비뇽" → grape/cabernet_sauvignon (Korean input)', () => {
    const result = normalizer.normalize('카베르네 소비뇽');
    expect(result).not.toBeNull();
    expect(result!.axis).toBe('grape');
    expect(result!.canonicalValue).toBe('cabernet_sauvignon');
  });

  // ── 3. Korean region ──────────────────────────────────────────────────────
  it('"보르도" → region/bordeaux (Korean region)', () => {
    const result = normalizer.normalize('보르도');
    expect(result).not.toBeNull();
    expect(result!.axis).toBe('region');
    expect(result!.canonicalValue).toBe('bordeaux');
  });

  // ── 4. Full body (Korean) ─────────────────────────────────────────────────
  it('"묵직한" → body/full_body', () => {
    const result = normalizer.normalize('묵직한');
    expect(result).not.toBeNull();
    expect(result!.axis).toBe('body');
    expect(result!.canonicalValue).toBe('full_body');
  });

  // ── 5. Light body (Korean) ───────────────────────────────────────────────
  it('"가벼운" → body/light_body', () => {
    const result = normalizer.normalize('가벼운');
    expect(result).not.toBeNull();
    expect(result!.axis).toBe('body');
    expect(result!.canonicalValue).toBe('light_body');
  });

  // ── 6. Dry style ──────────────────────────────────────────────────────────
  it('"드라이" → style/dry', () => {
    const result = normalizer.normalize('드라이');
    expect(result).not.toBeNull();
    expect(result!.axis).toBe('style');
    expect(result!.canonicalValue).toBe('dry');
  });

  // ── 7. Price band (Korean) ────────────────────────────────────────────────
  it('"저렴한" → price_band/budget', () => {
    const result = normalizer.normalize('저렴한');
    expect(result).not.toBeNull();
    expect(result!.axis).toBe('price_band');
    expect(result!.canonicalValue).toBe('budget');
  });

  // ── 8. Unknown phrase ─────────────────────────────────────────────────────
  it('Unknown phrase → null', () => {
    const result = normalizer.normalize('완전히 모르는 표현xyz123');
    expect(result).toBeNull();
  });

  // ── 9. normalizeMany on empty array ──────────────────────────────────────
  it('normalizeMany on empty array → []', () => {
    const results = normalizer.normalizeMany([]);
    expect(results).toHaveLength(0);
  });

  // ── 10. normalizeMany on mixed array → only non-null results ─────────────
  it('normalizeMany on mixed array → only non-null results returned', () => {
    const results = normalizer.normalizeMany([
      'cabernet sauvignon',
      'completely unknown phrase zzzz',
      '보르도',
    ]);
    expect(results).toHaveLength(2);
    expect(results.some((r) => r.canonicalValue === 'cabernet_sauvignon')).toBe(true);
    expect(results.some((r) => r.canonicalValue === 'bordeaux')).toBe(true);
  });

  // ── 11. shiraz and syrah → same canonical grape ───────────────────────────
  it('"shiraz" and "syrah" both normalize to same canonical grape value', () => {
    const shiraz = normalizer.normalize('shiraz');
    const syrah = normalizer.normalize('syrah');
    expect(shiraz).not.toBeNull();
    expect(syrah).not.toBeNull();
    expect(shiraz!.axis).toBe('grape');
    expect(syrah!.axis).toBe('grape');
    expect(shiraz!.canonicalValue).toBe(syrah!.canonicalValue);
  });

  // ── 12. Confidence: exact matches = 1.0 ──────────────────────────────────
  it('confidence is 1.0 for exact matches', () => {
    const result = normalizer.normalize('merlot');
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(1.0);
    expect(result!.source).toBe('exact');
  });

  // ── Additional: case insensitivity ────────────────────────────────────────
  it('lookup is case-insensitive', () => {
    const lower = normalizer.normalize('cabernet sauvignon');
    const upper = normalizer.normalize('Cabernet Sauvignon');
    const mixed = normalizer.normalize('CABERNET SAUVIGNON');
    expect(lower).not.toBeNull();
    expect(upper).not.toBeNull();
    expect(mixed).not.toBeNull();
    expect(lower!.canonicalValue).toBe(upper!.canonicalValue);
    expect(lower!.canonicalValue).toBe(mixed!.canonicalValue);
  });

  // ── Additional: trimming ──────────────────────────────────────────────────
  it('leading/trailing whitespace is trimmed', () => {
    const result = normalizer.normalize('  merlot  ');
    expect(result).not.toBeNull();
    expect(result!.canonicalValue).toBe('merlot');
  });

  // ── Additional: region canonical values ───────────────────────────────────
  it('"napa valley" → region/napa_valley', () => {
    const result = normalizer.normalize('napa valley');
    expect(result).not.toBeNull();
    expect(result!.axis).toBe('region');
    expect(result!.canonicalValue).toBe('napa_valley');
  });

  it('"나파 밸리" (Korean) → region/napa_valley', () => {
    const result = normalizer.normalize('나파 밸리');
    expect(result).not.toBeNull();
    expect(result!.axis).toBe('region');
    expect(result!.canonicalValue).toBe('napa_valley');
  });

  // ── Additional: price band English aliases ────────────────────────────────
  it('"luxury" → price_band/luxury', () => {
    const result = normalizer.normalize('luxury');
    expect(result).not.toBeNull();
    expect(result!.axis).toBe('price_band');
    expect(result!.canonicalValue).toBe('luxury');
  });

  it('"고급" (Korean) → price_band/luxury', () => {
    const result = normalizer.normalize('고급');
    expect(result).not.toBeNull();
    expect(result!.axis).toBe('price_band');
    expect(result!.canonicalValue).toBe('luxury');
  });

  it('"gifting" → occasion/gift', () => {
    const result = normalizer.normalize('gifting');
    expect(result).not.toBeNull();
    expect(result!.axis).toBe('occasion');
    expect(result!.canonicalValue).toBe('gift');
  });

  it('"special dinner" → occasion/date_night', () => {
    const result = normalizer.normalize('special dinner');
    expect(result).not.toBeNull();
    expect(result!.axis).toBe('occasion');
    expect(result!.canonicalValue).toBe('date_night');
  });

  it('"힐링" → occasion/healing', () => {
    const result = normalizer.normalize('힐링');
    expect(result).not.toBeNull();
    expect(result!.axis).toBe('occasion');
    expect(result!.canonicalValue).toBe('healing');
  });

  // ── Additional: style variants ────────────────────────────────────────────
  it('"sparkling" → style/sparkling', () => {
    const result = normalizer.normalize('sparkling');
    expect(result).not.toBeNull();
    expect(result!.axis).toBe('style');
    expect(result!.canonicalValue).toBe('sparkling');
  });

  it('"풀바디" → body/full_body', () => {
    const result = normalizer.normalize('풀바디');
    expect(result).not.toBeNull();
    expect(result!.axis).toBe('body');
    expect(result!.canonicalValue).toBe('full_body');
  });

  // ── Additional: Korean grape aliases ─────────────────────────────────────
  it('"피노 누아르" → grape/pinot_noir', () => {
    const result = normalizer.normalize('피노 누아르');
    expect(result).not.toBeNull();
    expect(result!.axis).toBe('grape');
    expect(result!.canonicalValue).toBe('pinot_noir');
  });

  it('"샤르도네" → grape/chardonnay', () => {
    const result = normalizer.normalize('샤르도네');
    expect(result).not.toBeNull();
    expect(result!.axis).toBe('grape');
    expect(result!.canonicalValue).toBe('chardonnay');
  });

  it('"메를로" → grape/merlot', () => {
    const result = normalizer.normalize('메를로');
    expect(result).not.toBeNull();
    expect(result!.axis).toBe('grape');
    expect(result!.canonicalValue).toBe('merlot');
  });

  // ── Additional: displayValue is populated ─────────────────────────────────
  it('displayValue is a non-empty string', () => {
    const result = normalizer.normalize('pinot noir');
    expect(result).not.toBeNull();
    expect(typeof result!.displayValue).toBe('string');
    expect(result!.displayValue.length).toBeGreaterThan(0);
  });

  // ── Additional: normalizeMany preserves order ─────────────────────────────
  it('normalizeMany preserves the order of matched results', () => {
    const results = normalizer.normalizeMany(['merlot', 'bordeaux', 'full body']);
    expect(results).toHaveLength(3);
    expect(results[0]!.canonicalValue).toBe('merlot');
    expect(results[1]!.canonicalValue).toBe('bordeaux');
    expect(results[2]!.canonicalValue).toBe('full_body');
  });
});

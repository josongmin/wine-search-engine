import { describe, it, expect } from 'vitest';
import { buildSparseFilters } from '../../../src/infrastructure/vespa/mapping.js';

// Re-export for registry contract tests — these are internal but exported for testing
// via the module's public surface. If the registry is ever made exportable, update here.
// For now we test via buildSparseFilters which covers all registry paths.

// ---------------------------------------------------------------------------
// Registry contract: every token in FILTER_TOKEN_REGISTRY must produce the
// correct YQL operator for its field. Unknown tokens must be blocked entirely.
// ---------------------------------------------------------------------------

describe('buildSparseFilters — empty / unknown token blocking', () => {
  it('returns empty string for empty filter array', () => {
    expect(buildSparseFilters([])).toBe('');
  });

  it('blocks completely unknown token keys — never reaches Vespa', () => {
    // Injection attempt: a field name not in the registry must produce no output
    expect(buildSparseFilters(['unknown_field:value'])).toBe('');
    expect(buildSparseFilters(['DROP TABLE:wines'])).toBe('');
    expect(buildSparseFilters(['__proto__:polluted'])).toBe('');
  });

  it('skips tokens with empty values', () => {
    expect(buildSparseFilters(['wine_type:'])).toBe('');
    expect(buildSparseFilters(['country:'])).toBe('');
  });

  it('skips malformed tokens with no colon', () => {
    expect(buildSparseFilters(['winetypered'])).toBe('');
  });

  it('blocks _in tokens whose base key is not in ALLOWED_SPARSE_IN_FIELDS', () => {
    // "injected_in:a|b" — base "injected" is not allowed
    expect(buildSparseFilters(['injected_in:a|b'])).toBe('');
  });
});

describe('buildSparseFilters — style (contains) vs style_matches (matches)', () => {
  // REGRESSION: style field uses attribute-only indexing (no `index` directive).
  // Multi-token values like "light red" cannot be matched with `contains`.
  // `style_matches:` token emits `style matches "..."` (regex substring).

  it('style_matches:light → style matches "light" (not contains)', () => {
    expect(buildSparseFilters(['style_matches:light'])).toBe(' AND style matches "light"');
  });

  it('style_matches:medium → style matches "medium"', () => {
    expect(buildSparseFilters(['style_matches:medium'])).toBe(' AND style matches "medium"');
  });

  it('style_matches:full → style matches "full"', () => {
    expect(buildSparseFilters(['style_matches:full'])).toBe(' AND style matches "full"');
  });

  it('style_matches:bold → style matches "bold"', () => {
    expect(buildSparseFilters(['style_matches:bold'])).toBe(' AND style matches "bold"');
  });

  it('legacy style: → style contains "..." (kept for NOT-exclusion path)', () => {
    // style: token is kept ONLY for NOT-exclusion (style_not:) path.
    // Positive style filtering must use style_matches: instead.
    expect(buildSparseFilters(['style:bold'])).toBe(' AND style contains "bold"');
  });

  it('style_not: → !(style matches "...") for exclusion — BUG FIX: was contains, now matches', () => {
    // CRITICAL BUG FIX: style is attribute-only; `contains` on "full red" with query "full"
    // was a no-op (exact equality, not substring). `matches` correctly does regex substring.
    expect(buildSparseFilters(['style_not:bold'])).toBe(' AND !(style matches "bold")');
  });

  it('escapes regex metacharacters in style_matches — prevents YQL injection', () => {
    // escapeRegex("light.+red") → "light\.\+red"
    // yqlEscapeString double-escapes backslashes for YQL string literal
    const result = buildSparseFilters(['style_matches:light.+red']);
    expect(result).toBe(' AND style matches "light\\\\.\\\\+red"');
  });

  it('style_matches_in:light|bold → OR clause using matches (not contains)', () => {
    // REGRESSION BUG FIX: before fix, style_matches_in used `contains` instead of `matches`
    // causing 0 hits on attribute-only multi-token style values.
    const result = buildSparseFilters(['style_matches_in:light|bold']);
    expect(result).toContain('style matches "light"');
    expect(result).toContain('style matches "bold"');
    expect(result).not.toContain('style_matches contains');
    expect(result).not.toContain('style contains');
  });

  it('style_matches_in with single value → single matches clause (no OR wrapper)', () => {
    const result = buildSparseFilters(['style_matches_in:medium']);
    expect(result).toBe(' AND style matches "medium"');
  });

  it('style_matches_in escapes regex metacharacters in each value', () => {
    const result = buildSparseFilters(['style_matches_in:light.red|bold+']);
    // Each value is regex-escaped and yql-escaped
    expect(result).toContain('style matches');
    expect(result).not.toContain('light.red'); // unescaped dot would be injection
    expect(result).not.toContain('bold+');     // unescaped + would be injection
  });
});

describe('buildSparseFilters — string contains tokens', () => {
  it('wine_type:red → wine_type contains "red"', () => {
    expect(buildSparseFilters(['wine_type:red'])).toBe(' AND wine_type contains "red"');
  });

  it('country:France → country contains "France"', () => {
    expect(buildSparseFilters(['country:France'])).toBe(' AND country contains "France"');
  });

  it('region:Napa → multi-field OR over (region | appellation | region_hierarchy)', () => {
    // Region positive lookup expands across the three index fields so a planner
    // emitting `region:Napa` matches docs whose Napa data lives on appellation
    // (e.g. "Napa Valley AVA") or region_hierarchy. Without the expansion, the
    // raw `region` field alone misses ~20% of Napa wines (data placement varies
    // across the ingest sources).
    expect(buildSparseFilters(['region:Napa'])).toBe(
      ' AND (region contains "Napa" OR appellation contains "Napa" OR region_hierarchy contains "Napa")',
    );
  });

  it('appellation:Pomerol → appellation contains "Pomerol"', () => {
    expect(buildSparseFilters(['appellation:Pomerol'])).toBe(' AND appellation contains "Pomerol"');
  });

  it('grape_primary:Merlot → grape_primary contains "Merlot"', () => {
    expect(buildSparseFilters(['grape_primary:Merlot'])).toBe(' AND grape_primary contains "Merlot"');
  });

  it('price_band canonical values emit contains clause', () => {
    expect(buildSparseFilters(['price_band:value'])).toBe(' AND price_band contains "value"');
    expect(buildSparseFilters(['price_band:mid'])).toBe(' AND price_band contains "mid"');
    expect(buildSparseFilters(['price_band:premium'])).toBe(' AND price_band contains "premium"');
    expect(buildSparseFilters(['price_band:luxury'])).toBe(' AND price_band contains "luxury"');
  });

  it('flavor_profile → flavor_profiles (field name remapping)', () => {
    // flavor_profile token maps to flavor_profiles Vespa field (plural)
    expect(buildSparseFilters(['flavor_profile:fruity'])).toBe(' AND flavor_profiles contains "fruity"');
  });

  it('certification → certifications (field name remapping)', () => {
    expect(buildSparseFilters(['certification:organic'])).toBe(' AND certifications contains "organic"');
  });

  it('soil_type:clay → soil_type contains "clay"', () => {
    expect(buildSparseFilters(['soil_type:clay'])).toBe(' AND soil_type contains "clay"');
  });

  it('producer_type:estate → producer_type contains "estate"', () => {
    expect(buildSparseFilters(['producer_type:estate'])).toBe(' AND producer_type contains "estate"');
  });

  it('classification:premier_cru → classification contains "premier_cru"', () => {
    expect(buildSparseFilters(['classification:premier_cru'])).toBe(' AND classification contains "premier_cru"');
  });
});

describe('buildSparseFilters — grape_or (OR across grape fields)', () => {
  it('grape_or:Merlot → (grape_primary contains "Merlot" OR grapes contains "Merlot")', () => {
    expect(buildSparseFilters(['grape_or:Merlot'])).toBe(
      ' AND (grape_primary contains "Merlot" OR grapes contains "Merlot")',
    );
  });

  it('grape_or_in:Merlot|Cabernet → multi-value OR across both grape fields', () => {
    const result = buildSparseFilters(['grape_or_in:Merlot|Cabernet']);
    expect(result).toContain('grape_primary contains "Merlot"');
    expect(result).toContain('grapes contains "Merlot"');
    expect(result).toContain('grape_primary contains "Cabernet"');
    expect(result).toContain('grapes contains "Cabernet"');
  });
});

describe('buildSparseFilters — NOT exclusion tokens', () => {
  it('wine_type_not:white → !(wine_type contains "white")', () => {
    expect(buildSparseFilters(['wine_type_not:white'])).toBe(' AND !(wine_type contains "white")');
  });

  it('country_not:France → !(country contains "France")', () => {
    expect(buildSparseFilters(['country_not:France'])).toBe(' AND !(country contains "France")');
  });

  it('grape_primary_not:Merlot → !(grape_primary contains "Merlot")', () => {
    expect(buildSparseFilters(['grape_primary_not:Merlot'])).toBe(' AND !(grape_primary contains "Merlot")');
  });

  it('grapes_not:Merlot → !(grapes contains "Merlot")', () => {
    expect(buildSparseFilters(['grapes_not:Merlot'])).toBe(' AND !(grapes contains "Merlot")');
  });

  it('flavor_profile_not → uses flavor_profiles Vespa field (remapping via registry)', () => {
    // REGRESSION: _not_in path now looks up field name from registry instead of
    // stripping suffix from token key. flavor_profile_not → flavor_profiles field.
    const result = buildSparseFilters(['flavor_profile_not:oaky']);
    expect(result).toBe(' AND !(flavor_profiles contains "oaky")');
    expect(result).not.toContain('flavor_profile contains'); // wrong field name
  });

  it('certification_not → uses certifications Vespa field', () => {
    expect(buildSparseFilters(['certification_not:biodynamic'])).toBe(' AND !(certifications contains "biodynamic")');
  });

  it('wine_type_not_in:white|rosé → multiple NOT clauses', () => {
    const result = buildSparseFilters(['wine_type_not_in:white|rosé']);
    expect(result).toContain('!(wine_type contains "white")');
    expect(result).toContain('!(wine_type contains "rosé")');
  });

  it('grape_primary_not_in:Merlot|Syrah → multiple NOT clauses for both values', () => {
    const result = buildSparseFilters(['grape_primary_not_in:Merlot|Syrah']);
    expect(result).toContain('!(grape_primary contains "Merlot")');
    expect(result).toContain('!(grape_primary contains "Syrah")');
  });
});

describe('buildSparseFilters — multi-value _in tokens', () => {
  it('country_in:France|Italy → (country contains "France" OR country contains "Italy")', () => {
    const result = buildSparseFilters(['country_in:France|Italy']);
    expect(result).toBe(' AND (country contains "France" OR country contains "Italy")');
  });

  it('country_in with single value → plain contains (no OR wrapper)', () => {
    expect(buildSparseFilters(['country_in:France'])).toBe(' AND country contains "France"');
  });

  it('skips empty vals in pipe-delimited list', () => {
    expect(buildSparseFilters(['country_in:|'])).toBe('');
  });
});

describe('buildSparseFilters — numeric range tokens', () => {
  it('price_usd_min/max → price_usd >= / <=', () => {
    expect(buildSparseFilters(['price_usd_min:20'])).toBe(' AND price_usd >= 20.00');
    expect(buildSparseFilters(['price_usd_max:150'])).toBe(' AND price_usd <= 150.00');
  });

  it('vintage_year_min/max → vintage_year >= / <=', () => {
    expect(buildSparseFilters(['vintage_year_min:2010'])).toBe(' AND vintage_year >= 2010');
    expect(buildSparseFilters(['vintage_year_max:2020'])).toBe(' AND vintage_year <= 2020');
  });

  it('alcohol_min/max → alcohol_pct >= / <=', () => {
    expect(buildSparseFilters(['alcohol_min:13'])).toBe(' AND alcohol_pct >= 13.00');
    expect(buildSparseFilters(['alcohol_max:15'])).toBe(' AND alcohol_pct <= 15.00');
  });

  it('non-finite numeric values → silently skipped (no clause)', () => {
    expect(buildSparseFilters(['price_usd_min:NaN'])).toBe('');
    expect(buildSparseFilters(['price_usd_max:Infinity'])).toBe('');
    expect(buildSparseFilters(['vintage_year_min:abc'])).toBe('');
  });

  it('clamping: price_usd_min below 0 → clamped to 0', () => {
    expect(buildSparseFilters(['price_usd_min:-999'])).toBe(' AND price_usd >= 0.00');
  });

  it('clamping: price_usd_max above ceiling → clamped to MAX_PRICE_USD_YQL_CLAMP', () => {
    // MAX_PRICE_USD_YQL_CLAMP = 1_000_000
    expect(buildSparseFilters(['price_usd_max:9999999'])).toBe(' AND price_usd <= 1000000.00');
  });

  it('drinking_window_now:2024 → two separate clauses for start/end', () => {
    const result = buildSparseFilters(['drinking_window_now:2024']);
    expect(result).toContain('drinking_window_start <= 2024');
    expect(result).toContain('drinking_window_end >= 2024');
    // Must be two separate AND clauses, not one with internal AND
    const parts = result.split(' AND ').filter((p) => p.length > 0);
    expect(parts).toHaveLength(2);
  });
});

describe('buildSparseFilters — availability bool token', () => {
  it('availability:true → availability = true', () => {
    expect(buildSparseFilters(['availability:true'])).toBe(' AND availability = true');
  });

  it('availability:false → availability = false', () => {
    expect(buildSparseFilters(['availability:false'])).toBe(' AND availability = false');
  });

  it('availability with any non-"true" value → availability = false', () => {
    expect(buildSparseFilters(['availability:yes'])).toBe(' AND availability = false');
  });
});

describe('buildSparseFilters — YQL injection prevention', () => {
  it('rejects unknown field names regardless of value', () => {
    expect(buildSparseFilters(['evil_field:value'])).toBe('');
    expect(buildSparseFilters(['; DROP TABLE wines; --:x'])).toBe('');
  });

  it('escapes double quotes in string values to prevent YQL injection', () => {
    const result = buildSparseFilters(['country:Fr"ance']);
    // yqlEscapeString escapes " → \"
    expect(result).toBe(' AND country contains "Fr\\"ance"');
    expect(result).not.toContain('Fr"ance'); // raw unescaped quote never in output
  });

  it('escapes backslashes in string values', () => {
    const result = buildSparseFilters(['country:Fr\\ance']);
    expect(result).toBe(' AND country contains "Fr\\\\ance"');
  });

  it('style_matches escapes regex metacharacters before YQL-escaping', () => {
    // Prevents regex injection: "." should not match any character in Vespa regex
    const result = buildSparseFilters(['style_matches:me.ium']);
    expect(result).toContain('style matches');
    expect(result).not.toContain('me.ium'); // unescaped dot = wildcard injection
  });
});

describe('buildSparseFilters — combined multi-token queries', () => {
  it('multiple tokens produce AND-joined clauses in order', () => {
    const result = buildSparseFilters([
      'wine_type:red',
      'country:France',
      'style_matches:light',
      'price_usd_max:80',
    ]);
    expect(result).toBe(
      ' AND wine_type contains "red" AND country contains "France" AND style matches "light" AND price_usd <= 80.00',
    );
  });

  it('mix of valid and unknown tokens — unknown skipped, valid emitted', () => {
    const result = buildSparseFilters(['wine_type:red', 'bad_field:x', 'country:Italy']);
    expect(result).toContain('wine_type contains "red"');
    expect(result).toContain('country contains "Italy"');
    expect(result).not.toContain('bad_field');
  });
});

// ---------------------------------------------------------------------------
// REGISTRY COMPLETENESS — every token key in FILTER_TOKEN_REGISTRY must
// produce the exact expected YQL field name and operator.
// These tests catch: field name typos, wrong operator type, wrong clamp.
// ---------------------------------------------------------------------------

describe('buildSparseFilters — FILTER_TOKEN_REGISTRY completeness (every token key)', () => {
  // ---- contains tokens ----
  it('wine_type → wine_type contains', () => {
    expect(buildSparseFilters(['wine_type:red'])).toBe(' AND wine_type contains "red"');
  });
  it('country → country contains', () => {
    expect(buildSparseFilters(['country:France'])).toBe(' AND country contains "France"');
  });
  it('region → multi-field OR over (region | appellation | region_hierarchy)', () => {
    expect(buildSparseFilters(['region:Napa'])).toBe(
      ' AND (region contains "Napa" OR appellation contains "Napa" OR region_hierarchy contains "Napa")',
    );
  });
  it('appellation → appellation contains', () => {
    expect(buildSparseFilters(['appellation:Pomerol'])).toBe(' AND appellation contains "Pomerol"');
  });
  it('grape_primary → grape_primary contains', () => {
    expect(buildSparseFilters(['grape_primary:Merlot'])).toBe(' AND grape_primary contains "Merlot"');
  });
  it('price_band → price_band contains', () => {
    expect(buildSparseFilters(['price_band:mid'])).toBe(' AND price_band contains "mid"');
  });
  it('flavor_profile → flavor_profiles contains (field remapped: singular→plural)', () => {
    expect(buildSparseFilters(['flavor_profile:fruity'])).toBe(' AND flavor_profiles contains "fruity"');
  });
  it('classification → classification contains', () => {
    expect(buildSparseFilters(['classification:premier_cru'])).toBe(' AND classification contains "premier_cru"');
  });
  it('certification → certifications contains (field remapped: singular→plural)', () => {
    expect(buildSparseFilters(['certification:organic'])).toBe(' AND certifications contains "organic"');
  });
  it('soil_type → soil_type contains', () => {
    expect(buildSparseFilters(['soil_type:clay'])).toBe(' AND soil_type contains "clay"');
  });
  it('producer_type → producer_type contains', () => {
    expect(buildSparseFilters(['producer_type:estate'])).toBe(' AND producer_type contains "estate"');
  });
  it('style (legacy) → style contains', () => {
    expect(buildSparseFilters(['style:bold'])).toBe(' AND style contains "bold"');
  });

  // ---- matches token ----
  it('style_matches → style matches (NOT contains)', () => {
    const result = buildSparseFilters(['style_matches:light']);
    expect(result).toBe(' AND style matches "light"');
    expect(result).not.toContain('contains');
  });

  // ---- grape_or compound ----
  it('grape_or → (grape_primary contains OR grapes contains)', () => {
    expect(buildSparseFilters(['grape_or:Merlot'])).toBe(
      ' AND (grape_primary contains "Merlot" OR grapes contains "Merlot")',
    );
  });

  // ---- bool ----
  it('availability:true → availability = true', () => {
    expect(buildSparseFilters(['availability:true'])).toBe(' AND availability = true');
  });

  // ---- drinking_window special ----
  it('drinking_window_now → two clauses: start <= and end >=', () => {
    const result = buildSparseFilters(['drinking_window_now:2024']);
    const parts = result.split(' AND ').filter((p) => p.trim().length > 0);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe('drinking_window_start <= 2024');
    expect(parts[1]).toBe('drinking_window_end >= 2024');
  });

  // ---- num_gte / num_lte tokens — verify field names and decimal precision ----
  it('body_min → body >= (3 decimal places)', () => {
    expect(buildSparseFilters(['body_min:0.5'])).toBe(' AND body >= 0.500');
  });
  it('body_max → body <= (3 decimal places)', () => {
    expect(buildSparseFilters(['body_max:0.8'])).toBe(' AND body <= 0.800');
  });
  it('acidity_min → acidity >= (3 decimal places, NOT body or tannin)', () => {
    expect(buildSparseFilters(['acidity_min:3'])).toBe(' AND acidity >= 3.000');
  });
  it('acidity_max → acidity <=', () => {
    expect(buildSparseFilters(['acidity_max:7'])).toBe(' AND acidity <= 7.000');
  });
  it('tannin_min → tannin >= (3 decimal places)', () => {
    expect(buildSparseFilters(['tannin_min:4'])).toBe(' AND tannin >= 4.000');
  });
  it('tannin_max → tannin <=', () => {
    expect(buildSparseFilters(['tannin_max:6'])).toBe(' AND tannin <= 6.000');
  });
  it('finish_length_min → finish_length >= (NOT acidity or tannin)', () => {
    expect(buildSparseFilters(['finish_length_min:5'])).toBe(' AND finish_length >= 5.000');
  });
  it('finish_length_max → finish_length <=', () => {
    expect(buildSparseFilters(['finish_length_max:8'])).toBe(' AND finish_length <= 8.000');
  });
  it('price_usd_min → price_usd >= (2 decimal places)', () => {
    expect(buildSparseFilters(['price_usd_min:20'])).toBe(' AND price_usd >= 20.00');
  });
  it('price_usd_max → price_usd <= (2 decimal places)', () => {
    expect(buildSparseFilters(['price_usd_max:150'])).toBe(' AND price_usd <= 150.00');
  });
  it('critic_score_min → critic_score_normalized >= (4 decimal places, NOT critic_score)', () => {
    expect(buildSparseFilters(['critic_score_min:0.5'])).toBe(' AND critic_score_normalized >= 0.5000');
  });
  it('producer_prestige_min → producer_prestige >= (4 decimal places)', () => {
    expect(buildSparseFilters(['producer_prestige_min:0.7'])).toBe(' AND producer_prestige >= 0.7000');
  });
  it('alcohol_min → alcohol_pct >= (2 decimal places, NOT alcohol)', () => {
    expect(buildSparseFilters(['alcohol_min:13'])).toBe(' AND alcohol_pct >= 13.00');
  });
  it('alcohol_max → alcohol_pct <=', () => {
    expect(buildSparseFilters(['alcohol_max:15'])).toBe(' AND alcohol_pct <= 15.00');
  });

  // ---- int_gte / int_lte — no decimal places ----
  it('vintage_year_min → vintage_year >= (integer, no decimals)', () => {
    expect(buildSparseFilters(['vintage_year_min:2010'])).toBe(' AND vintage_year >= 2010');
  });
  it('vintage_year_max → vintage_year <= (integer, no decimals)', () => {
    expect(buildSparseFilters(['vintage_year_max:2020'])).toBe(' AND vintage_year <= 2020');
  });

  // ---- not_contains tokens — verify field name remapping ----
  it('grape_primary_not → !(grape_primary contains)', () => {
    expect(buildSparseFilters(['grape_primary_not:Merlot'])).toBe(' AND !(grape_primary contains "Merlot")');
  });
  it('grapes_not → !(grapes contains) — separate from grape_primary_not', () => {
    expect(buildSparseFilters(['grapes_not:Merlot'])).toBe(' AND !(grapes contains "Merlot")');
  });
  it('wine_type_not → !(wine_type contains)', () => {
    expect(buildSparseFilters(['wine_type_not:white'])).toBe(' AND !(wine_type contains "white")');
  });
  it('country_not → !(country contains)', () => {
    expect(buildSparseFilters(['country_not:France'])).toBe(' AND !(country contains "France")');
  });
  it('region_not → !(multi-field OR) — same expansion as positive, negated', () => {
    expect(buildSparseFilters(['region_not:Mosel'])).toBe(
      ' AND !(region contains "Mosel" OR appellation contains "Mosel" OR region_hierarchy contains "Mosel")',
    );
  });
  it('appellation_not → !(appellation contains)', () => {
    expect(buildSparseFilters(['appellation_not:Pomerol'])).toBe(' AND !(appellation contains "Pomerol")');
  });
  it('style_not → !(style matches) — uses regex substring not exact-token contains', () => {
    // BUG FIX: style is attribute-only; `contains` was a no-op on multi-token values.
    expect(buildSparseFilters(['style_not:bold'])).toBe(' AND !(style matches "bold")');
  });
  it('price_band_not → !(price_band contains)', () => {
    expect(buildSparseFilters(['price_band_not:luxury'])).toBe(' AND !(price_band contains "luxury")');
  });
  it('flavor_profile_not → !(flavor_profiles contains) — field remapped', () => {
    expect(buildSparseFilters(['flavor_profile_not:oaky'])).toBe(' AND !(flavor_profiles contains "oaky")');
  });
  it('classification_not → !(classification contains)', () => {
    expect(buildSparseFilters(['classification_not:grand_cru'])).toBe(' AND !(classification contains "grand_cru")');
  });
  it('certification_not → !(certifications contains) — field remapped', () => {
    expect(buildSparseFilters(['certification_not:biodynamic'])).toBe(' AND !(certifications contains "biodynamic")');
  });
  it('soil_type_not → !(soil_type contains)', () => {
    expect(buildSparseFilters(['soil_type_not:clay'])).toBe(' AND !(soil_type contains "clay")');
  });
  it('producer_type_not → !(producer_type contains)', () => {
    expect(buildSparseFilters(['producer_type_not:cooperative'])).toBe(' AND !(producer_type contains "cooperative")');
  });
});

// ---------------------------------------------------------------------------
// _not_in multi-value field remapping — the _not_in path must use registry
// field name (flavor_profiles, certifications) not raw token key
// ---------------------------------------------------------------------------
describe('buildSparseFilters — _not_in field remapping (multi-value)', () => {
  it('flavor_profile_not_in:fruity|oaky → !(flavor_profiles ...) twice', () => {
    const result = buildSparseFilters(['flavor_profile_not_in:fruity|oaky']);
    expect(result).toContain('!(flavor_profiles contains "fruity")');
    expect(result).toContain('!(flavor_profiles contains "oaky")');
    expect(result).not.toContain('flavor_profile contains'); // wrong field name
    expect(result).not.toContain('!(flavor_profile contains'); // wrong field name
  });

  it('certification_not_in:organic|vegan → !(certifications ...) twice', () => {
    const result = buildSparseFilters(['certification_not_in:organic|vegan']);
    expect(result).toContain('!(certifications contains "organic")');
    expect(result).toContain('!(certifications contains "vegan")');
    expect(result).not.toContain('!(certification contains'); // wrong field name
  });

  it('soil_type_not_in:clay|loam → !(soil_type ...) twice (no remapping needed)', () => {
    const result = buildSparseFilters(['soil_type_not_in:clay|loam']);
    expect(result).toContain('!(soil_type contains "clay")');
    expect(result).toContain('!(soil_type contains "loam")');
  });

  it('producer_type_not_in:estate|cooperative → !(producer_type ...) twice', () => {
    const result = buildSparseFilters(['producer_type_not_in:estate|cooperative']);
    expect(result).toContain('!(producer_type contains "estate")');
    expect(result).toContain('!(producer_type contains "cooperative")');
  });

  it('region_not_in:Napa|Sonoma → two !(multi-field OR) clauses', () => {
    // Each excluded region produces an independent NOT-clause that fans out
    // across (region | appellation | region_hierarchy) — same expansion shape
    // as the single-value region_not path.
    const result = buildSparseFilters(['region_not_in:Napa|Sonoma']);
    expect(result).toContain(
      '!(region contains "Napa" OR appellation contains "Napa" OR region_hierarchy contains "Napa")',
    );
    expect(result).toContain(
      '!(region contains "Sonoma" OR appellation contains "Sonoma" OR region_hierarchy contains "Sonoma")',
    );
  });
});

// ---------------------------------------------------------------------------
// _in field remapping — positive multi-value must also use registry field names
// ---------------------------------------------------------------------------
describe('buildSparseFilters — _in field remapping (positive multi-value)', () => {
  it('flavor_profile_in:fruity|floral → flavor_profiles field (remapped)', () => {
    const result = buildSparseFilters(['flavor_profile_in:fruity|floral']);
    expect(result).toContain('flavor_profiles contains "fruity"');
    expect(result).toContain('flavor_profiles contains "floral"');
    expect(result).not.toContain('flavor_profile contains'); // wrong field name
  });

  it('certification_in:organic|vegan → certifications field (remapped)', () => {
    const result = buildSparseFilters(['certification_in:organic|vegan']);
    expect(result).toContain('certifications contains "organic"');
    expect(result).toContain('certifications contains "vegan"');
    expect(result).not.toContain('certification contains'); // wrong field name
  });

  it('country_in:France|Italy → country field (no remapping, passthrough)', () => {
    expect(buildSparseFilters(['country_in:France|Italy'])).toBe(
      ' AND (country contains "France" OR country contains "Italy")',
    );
  });

  it('region_in:Napa|Sonoma → region field', () => {
    const result = buildSparseFilters(['region_in:Napa|Sonoma']);
    expect(result).toContain('region contains "Napa"');
    expect(result).toContain('region contains "Sonoma"');
  });
});

// ---------------------------------------------------------------------------
// price_band_in — new multi-value path (matches style_matches_in pattern)
// ---------------------------------------------------------------------------
describe('buildSparseFilters — price_band_in multi-value', () => {
  it('price_band_in:value|premium → OR clause', () => {
    const result = buildSparseFilters(['price_band_in:value|premium']);
    expect(result).toBe(' AND (price_band contains "value" OR price_band contains "premium")');
  });

  it('price_band_in single value → plain contains', () => {
    expect(buildSparseFilters(['price_band_in:mid'])).toBe(' AND price_band contains "mid"');
  });
});

// ---------------------------------------------------------------------------
// Numeric clamping — out-of-range values must be clamped, not passed raw
// ---------------------------------------------------------------------------
describe('buildSparseFilters — numeric clamping', () => {
  it('body_min below 0 → clamped to 0.000', () => {
    expect(buildSparseFilters(['body_min:-5'])).toBe(' AND body >= 0.000');
  });
  it('body_max above 1 → clamped to 1.000', () => {
    expect(buildSparseFilters(['body_max:99'])).toBe(' AND body <= 1.000');
  });
  it('critic_score_min above 1 → clamped to 1.0000', () => {
    expect(buildSparseFilters(['critic_score_min:2'])).toBe(' AND critic_score_normalized >= 1.0000');
  });
  it('price_usd_max above ceiling → clamped to 1000000.00', () => {
    expect(buildSparseFilters(['price_usd_max:9999999'])).toBe(' AND price_usd <= 1000000.00');
  });
  it('alcohol_max above 25 → clamped to 25.00', () => {
    expect(buildSparseFilters(['alcohol_max:100'])).toBe(' AND alcohol_pct <= 25.00');
  });
  it('vintage_year_min below MIN_PRODUCED_VINTAGE_YEAR (1700) → clamped to 1700', () => {
    expect(buildSparseFilters(['vintage_year_min:1'])).toBe(' AND vintage_year >= 1700');
  });
  it('non-finite numeric values → silently skipped', () => {
    expect(buildSparseFilters(['body_min:NaN'])).toBe('');
    expect(buildSparseFilters(['acidity_max:Infinity'])).toBe('');
    expect(buildSparseFilters(['vintage_year_min:abc'])).toBe('');
    expect(buildSparseFilters(['price_usd_min:'])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// style_matches_in — multi-value must use matches (not contains) with escaping
// ---------------------------------------------------------------------------
describe('buildSparseFilters — style_matches_in complete coverage', () => {
  it('two values → OR clause with matches on both', () => {
    const result = buildSparseFilters(['style_matches_in:light|bold']);
    expect(result).toContain('style matches "light"');
    expect(result).toContain('style matches "bold"');
    expect(result).not.toContain('contains'); // must not fall back to contains
  });

  it('three values → OR clause with all three', () => {
    const result = buildSparseFilters(['style_matches_in:light|medium|bold']);
    const matchCount = (result.match(/style matches/g) ?? []).length;
    expect(matchCount).toBe(3);
  });

  it('single value → no OR wrapper, plain matches', () => {
    expect(buildSparseFilters(['style_matches_in:medium'])).toBe(' AND style matches "medium"');
  });

  it('regex metacharacters in each value are escaped', () => {
    const result = buildSparseFilters(['style_matches_in:me.ium|bo+ld']);
    // Both values must be escaped — no raw unescaped metacharacters in output
    expect(result).not.toContain('me.ium');
    expect(result).not.toContain('bo+ld');
    expect(result).toContain('style matches');
  });
});

// ---------------------------------------------------------------------------
// style_not / style_not_in — CRITICAL BUG FIX regression tests
// style is attribute-only; contains does NOT substring-match multi-token
// values like "full red". Must use `matches` (regex) for correct exclusion.
// Previously: style_not:full → !(style contains "full") — no-op for "full red"
// Fixed:      style_not:full → !(style matches "full")  — correctly excludes "full red"
// ---------------------------------------------------------------------------
describe('buildSparseFilters — style_not / style_not_in uses matches (not contains)', () => {
  it('style_not:full → !(style matches "full") not contains', () => {
    // THE critical bug: !(style contains "full") is always true for attribute-only
    // field because "full red" !== "full". matches "full" correctly does substring.
    expect(buildSparseFilters(['style_not:full'])).toBe(' AND !(style matches "full")');
    expect(buildSparseFilters(['style_not:full'])).not.toContain('contains');
  });

  it('style_not:bold → !(style matches "bold")', () => {
    expect(buildSparseFilters(['style_not:bold'])).toBe(' AND !(style matches "bold")');
  });

  it('style_not:light → !(style matches "light")', () => {
    expect(buildSparseFilters(['style_not:light'])).toBe(' AND !(style matches "light")');
  });

  it('style_not:medium → !(style matches "medium")', () => {
    expect(buildSparseFilters(['style_not:medium'])).toBe(' AND !(style matches "medium")');
  });

  it('style_not_in:full|bold → two !(style matches ...) AND clauses', () => {
    const result = buildSparseFilters(['style_not_in:full|bold']);
    expect(result).toContain('!(style matches "full")');
    expect(result).toContain('!(style matches "bold")');
    // Must NOT fall back to contains — that was the bug
    expect(result).not.toContain('contains');
  });

  it('style_not_in:light|medium|bold → three NOT matches clauses', () => {
    const result = buildSparseFilters(['style_not_in:light|medium|bold']);
    const matchCount = (result.match(/!\(style matches/g) ?? []).length;
    expect(matchCount).toBe(3);
    expect(result).not.toContain('contains');
  });

  it('style_not_in single value → single !(style matches ...) clause', () => {
    expect(buildSparseFilters(['style_not_in:full'])).toBe(' AND !(style matches "full")');
  });

  it('style_not escapes regex metacharacters — prevents YQL injection', () => {
    // Value "full.red" must be escaped to "full\\.red" (literal dot, not wildcard)
    const result = buildSparseFilters(['style_not:full.red']);
    expect(result).not.toContain('full.red'); // unescaped dot — regex injection
    expect(result).toContain('style matches');
    expect(result).toContain('!');
  });

  it('style_not_in escapes regex metacharacters in each value', () => {
    const result = buildSparseFilters(['style_not_in:full.red|bold+']);
    expect(result).not.toContain('full.red');
    expect(result).not.toContain('bold+');
    expect(result).toContain('style matches');
  });

  // Adjacent regression: other _not fields must still use contains (not affected by fix)
  it('wine_type_not still uses contains (not matches)', () => {
    expect(buildSparseFilters(['wine_type_not:red'])).toBe(' AND !(wine_type contains "red")');
  });

  it('country_not still uses contains (not matches)', () => {
    expect(buildSparseFilters(['country_not:France'])).toBe(' AND !(country contains "France")');
  });

  it('price_band_not still uses contains (not matches)', () => {
    expect(buildSparseFilters(['price_band_not:luxury'])).toBe(' AND !(price_band contains "luxury")');
  });
});

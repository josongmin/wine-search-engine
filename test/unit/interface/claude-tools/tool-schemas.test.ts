/**
 * Unit tests for Claude tool schemas.
 *
 * Validates:
 * - WINE_SEARCH_TOOLS constant contains exactly 5 tools
 * - Each tool has required fields: name, description, input_schema
 * - Input schema format is valid for Claude API
 * - All 5 tools are present: search_wines, lookup_wine, get_food_pairings, check_drinking_window, compare_wines
 * - Tool properties have correct types and constraints
 */

import { describe, it, expect } from 'vitest';
import {
  ClaudeToolDefinitionSchema,
  CompareWinesInputSchema,
  CompareWinesAttemptInputSchema,
  DrinkingWindowInputSchema,
  DrinkingWindowAttemptInputSchema,
  FoodPairingInputSchema,
  FoodPairingAttemptInputSchema,
  SearchToolInputSchema,
  SearchToolAttemptInputSchema,
  WINE_SEARCH_TOOLS,
} from '../../../../src/interface/claude-tools/tool-schemas.js';
import { KNOWN_AGENT_TOOL_NAMES } from '../../../../src/domain/agent/model/agent-tool-attempt-schema.js';
import {
  buildSearchToolStructuredPreferences,
  buildCompareToolFieldShape,
  buildFoodPairingFieldShape,
  buildSearchToolFieldShape,
  FOOD_PAIRING_COLORS,
  SEARCH_TOOL_MAX_EXCLUDE_FILTERS,
  SEARCH_TOOL_MAX_STYLES,
  SEARCH_TOOL_RETRIEVAL_MODES,
  SEARCH_TOOL_VINTAGE_MAX,
  SEARCH_TOOL_VINTAGE_MIN,
  SEARCH_TOOL_WINE_TYPES,
} from '../../../../src/application/search/search-tool-contract.js';

describe('WINE_SEARCH_TOOLS', () => {
  it('should be schema-valid manifest entries', () => {
    const parsed = ClaudeToolDefinitionSchema.array().safeParse(WINE_SEARCH_TOOLS);
    expect(parsed.success).toBe(true);
  });

  it('should contain exactly 5 tools', () => {
    expect(WINE_SEARCH_TOOLS).toHaveLength(5);
  });

  it('should have all 5 required tools', () => {
    const names = WINE_SEARCH_TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'search_wines',
        'lookup_wine',
        'get_food_pairings',
        'check_drinking_window',
        'compare_wines',
      ]),
    );
  });

  describe('lookup_wine tool', () => {
    const tool = WINE_SEARCH_TOOLS.find((t) => t.name === 'lookup_wine')!;

    it('should exist with query required and no constraint filters', () => {
      expect(tool).toBeDefined();
      expect(tool.input_schema.required).toEqual(['query']);
      // lookup is identity-only: must NOT expose search constraint filters.
      const props = Object.keys(tool.input_schema.properties);
      expect(props).toEqual(expect.arrayContaining(['query', 'limit']));
      expect(props).not.toContain('min_price_krw');
      expect(props).not.toContain('region');
      expect(props).not.toContain('retrieval_mode');
    });
  });

  describe('search_wines tool', () => {
    const tool = WINE_SEARCH_TOOLS.find((t) => t.name === 'search_wines')!;

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have name and description', () => {
      expect(tool.name).toBe('search_wines');
      expect(tool.description).toBeTruthy();
    });

    it('should have valid input_schema', () => {
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.properties).toBeDefined();
      expect(tool.input_schema.required).toContain('query');
    });

    it('should have query as required property', () => {
      expect(tool.input_schema.required).toEqual(['query']);
    });

    it('should require query anchors to preserve the user language instead of translating Korean intent', () => {
      const queryProp = tool.input_schema.properties.query as any;
      expect(queryProp.description).toContain('Preserve the user\'s original language');
      expect(queryProp.description).toContain('do not translate Korean queries');
      expect(queryProp.description).toContain('structured fields');
    });

    it('should have limit property with 1-50 range', () => {
      const limitProp = tool.input_schema.properties.limit as any;
      expect(limitProp).toBeDefined();
      expect(limitProp.minimum).toBe(1);
      expect(limitProp.maximum).toBe(50);
    });

    it('should have retrieval_mode with 4 enum values', () => {
      const modeProp = tool.input_schema.properties.retrieval_mode as any;
      expect(modeProp).toBeDefined();
      expect(modeProp.enum).toEqual(['auto', 'entity', 'hybrid', 'mixed']);
    });

    it('should expose structured search constraints that match the agent search contract', () => {
      const props = tool.input_schema.properties as Record<string, any>;
      expect(props.exclude_grapes?.type).toBe('array');
      expect(props.exclude_regions?.type).toBe('array');
      expect(props.min_price_krw?.type).toBe('number');
      expect(props.max_price_krw?.type).toBe('number');
      expect(props.max_alcohol_pct?.type).toBe('number');
      expect(props.grape_primary?.type).toBe('string');
      expect(props.wine_type?.enum).toEqual([
        'red',
        'white',
        'rosé',
        'sparkling',
        'fortified',
        'dessert',
        'orange',
        'natural',
      ]);
      expect(props.grape_primary?.type).toBe('string');
      expect(props.country?.type).toBe('string');
      expect(props.vintage_min?.minimum).toBe(1600);
      expect(props.vintage_max?.maximum).toBe(2100);
      expect(props.appellation?.type).toBe('string');
      expect(props.style?.type).toBe('string');
      expect(props.styles?.type).toBe('array');
      expect(props.styles?.maxItems).toBe(5);
      expect(props.certification?.type).toBe('string');
      expect(props.occasion?.type).toBe('array');
      expect(props.gift_suitability_min?.type).toBe('number');
      expect(props.beginner_suitability_min?.type).toBe('number');
      expect(props.producer_prestige_min?.type).toBe('number');
      expect(props.popularity_min?.type).toBe('number');
      expect(props.producer_prestige_min?.minimum).toBe(0);
      expect(props.producer_prestige_min?.maximum).toBe(1);
      expect(props.popularity_min?.minimum).toBe(0);
      expect(props.popularity_min?.maximum).toBe(1);
      expect(props.sweetness_min?.minimum).toBe(0);
      expect(props.sweetness_min?.maximum).toBe(1);
      expect(props.sweetness_max?.minimum).toBe(0);
      expect(props.sweetness_max?.maximum).toBe(1);
      expect(props.recipient_profile?.enum).toEqual([
        'parents_first_time',
        'senior_colleague_gift',
        'unknown_preference_recipient',
      ]);
      expect(props.acidity_min?.minimum).toBe(0);
      expect(props.acidity_min?.maximum).toBe(1);
      expect(props.acidity_max?.minimum).toBe(0);
      expect(props.acidity_max?.maximum).toBe(1);
      expect(props.tannin_max?.minimum).toBe(0);
      expect(props.tannin_max?.maximum).toBe(1);
      expect(props.want_diversity?.type).toBe('boolean');
    });

    it('should document the extended semantic style vocabulary', () => {
      const props = tool.input_schema.properties as Record<string, any>;
      expect(props.style?.description).toContain('losslessly');
      expect(props.style?.description).toContain('sweet');
      expect(props.style?.description).toContain('chillable');
      expect(props.style?.description).toContain('screw_cap');
      expect(props.style?.description).toContain('approachable');
      expect(props.style?.description).toContain('crowd_pleasing');
      expect(props.styles?.description).toContain('approachable');
      expect(props.styles?.description).toContain('crowd_pleasing');
      expect(props.occasion?.description).toContain('gift');
      expect(props.occasion?.description).toContain('date_night');
      expect(props.gift_suitability_min?.description).toContain('gift-suitability');
      expect(props.beginner_suitability_min?.description).toContain('beginner-suitability');
      expect(props.producer_prestige_min?.description).toContain('producer-prestige');
      expect(props.popularity_min?.description).toContain('recognizability');
      expect(props.recipient_profile?.description).toContain('parents_first_time');
      expect(props.sweetness_min?.description).toContain('off-dry');
      expect(props.tannin_max?.description).toContain('low-tannin');
      expect(props.acidity_min?.description).toContain('bright');
      expect(props.acidity_max?.description).toContain('gentle');
      expect(props.style?.description).not.toContain('presentation_forward');
    });

    it('should expose max_alcohol_pct as a structured low-alcohol preference', () => {
      const props = tool.input_schema.properties as Record<string, any>;
      expect(props.max_alcohol_pct?.description).toContain('low-alcohol');
      expect(props.max_alcohol_pct?.minimum).toBe(0.1);
      expect(props.max_alcohol_pct?.maximum).toBe(100);
    });

    it('should describe drinking_window as verification-only rather than retrieval filtering', () => {
      const props = tool.input_schema.properties as Record<string, any>;
      expect(props.drinking_window?.description).toContain('post-search verification only');
      expect(props.drinking_window?.description).toContain('NOT a canonical retrieval filter');
      expect(props.drinking_window_target_year?.description).toContain('not retrieval filtering');
    });

    it('does not lower drinking_window into canonical retrieval preferences', () => {
      const preferences = buildSearchToolStructuredPreferences({
        drinking_window: 'now',
        drinking_window_target_year: 2026,
      }, 'test-mv');

      expect(preferences).toEqual([]);
    });
  });

  describe('get_food_pairings tool', () => {
    const tool = WINE_SEARCH_TOOLS.find((t) => t.name === 'get_food_pairings')!;

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have name and description', () => {
      expect(tool.name).toBe('get_food_pairings');
      expect(tool.description).toBeTruthy();
    });

    it('should have food as required property', () => {
      expect(tool.input_schema.required).toEqual(['food']);
    });

    it('should have optional max_price property', () => {
      const priceProp = tool.input_schema.properties.max_price as any;
      expect(priceProp).toBeDefined();
      expect(priceProp.type).toBe('number');
    });

    it('should expose max_price_krw as the preferred structured budget field', () => {
      const priceProp = tool.input_schema.properties.max_price_krw as any;
      expect(priceProp).toBeDefined();
      expect(priceProp.type).toBe('number');
      expect(priceProp.minimum).toBe(1);
    });

    it('should have optional color property with wine colors', () => {
      const colorProp = tool.input_schema.properties.color as any;
      expect(colorProp).toBeDefined();
      expect(colorProp.enum).toEqual(['red', 'white', 'rosé', 'sparkling', 'both']);
      expect(colorProp.description).toContain('legacy compatibility');
    });

    it('should expose typed pairing objective fields', () => {
      const props = tool.input_schema.properties as Record<string, any>;
      expect(props.sweetness_target).toMatchObject({ type: 'number', minimum: 0, maximum: 1 });
      expect(props.acidity_min).toMatchObject({ type: 'number', minimum: 0, maximum: 10 });
      expect(props.tannin_max).toMatchObject({ type: 'number', minimum: 0, maximum: 10 });
      expect(props.styles).toMatchObject({ type: 'array', maxItems: SEARCH_TOOL_MAX_STYLES });
      expect(props.pairing_tags).toMatchObject({ type: 'array', maxItems: 5 });
      expect(props.sweetness_target.description).toContain('typed sweetness target');
      expect(props.pairing_tags.description).toContain('canonical pairing tags');
    });
  });

  describe('check_drinking_window tool', () => {
    const tool = WINE_SEARCH_TOOLS.find((t) => t.name === 'check_drinking_window')!;

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have name and description', () => {
      expect(tool.name).toBe('check_drinking_window');
      expect(tool.description).toBeTruthy();
    });

    it('should have entity_id as required property', () => {
      expect(tool.input_schema.required).toEqual(['entity_id']);
    });

    it('should have optional target_year property', () => {
      const yearProp = tool.input_schema.properties.target_year as any;
      expect(yearProp).toBeDefined();
      expect(yearProp.type).toBe('number');
    });
  });

  describe('compare_wines tool', () => {
    const tool = WINE_SEARCH_TOOLS.find((t) => t.name === 'compare_wines')!;

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have name and description', () => {
      expect(tool.name).toBe('compare_wines');
      expect(tool.description).toBeTruthy();
    });

    it('should have both query_a and query_b as required properties', () => {
      expect(tool.input_schema.required).toEqual(expect.arrayContaining(['query_a', 'query_b']));
      expect(tool.input_schema.required).toHaveLength(2);
    });

    it('should have query_a and query_b properties', () => {
      expect(tool.input_schema.properties.query_a).toBeDefined();
      expect(tool.input_schema.properties.query_b).toBeDefined();
    });

    it('should expose shared structured comparison constraints', () => {
      const props = tool.input_schema.properties as Record<string, any>;
      expect(props.max_price_krw?.type).toBe('number');
      expect(props.wine_type?.enum).toEqual([
        'red',
        'white',
        'rosé',
        'sparkling',
        'fortified',
        'dessert',
        'orange',
        'natural',
      ]);
      expect(props.country?.type).toBe('string');
      expect(props.region?.type).toBe('string');
      expect(props.vintage_min?.minimum).toBe(1600);
      expect(props.styles?.type).toBe('array');
      expect(props.certification?.type).toBe('string');
      expect(props.occasion?.type).toBe('array');
      expect(props.gift_suitability_min?.type).toBe('number');
      expect(props.beginner_suitability_min?.type).toBe('number');
      expect(props.producer_prestige_min?.type).toBe('number');
      expect(props.popularity_min?.type).toBe('number');
      expect(props.producer_prestige_min?.minimum).toBe(0);
      expect(props.producer_prestige_min?.maximum).toBe(1);
      expect(props.popularity_min?.minimum).toBe(0);
      expect(props.popularity_min?.maximum).toBe(1);
      expect(props.sweetness_min?.minimum).toBe(0);
      expect(props.sweetness_min?.maximum).toBe(1);
      expect(props.sweetness_max?.minimum).toBe(0);
      expect(props.sweetness_max?.maximum).toBe(1);
      expect(props.recipient_profile?.enum).toEqual([
        'parents_first_time',
        'senior_colleague_gift',
        'unknown_preference_recipient',
      ]);
      expect(props.acidity_min?.minimum).toBe(0);
      expect(props.acidity_min?.maximum).toBe(1);
      expect(props.acidity_max?.minimum).toBe(0);
      expect(props.acidity_max?.maximum).toBe(1);
      expect(props.tannin_max?.minimum).toBe(0);
      expect(props.tannin_max?.maximum).toBe(1);
      expect(props.country_a?.type).toBe('string');
      expect(props.country_b?.type).toBe('string');
      expect(props.region_a?.type).toBe('string');
      expect(props.region_b?.type).toBe('string');
    });
  });
});

describe('Claude tool input schemas', () => {
  it('search_wines should ACCEPT unknown fields (rule 10: LLMs emit extras like reasoning/confidence)', () => {
    // Per CLAUDE.md rule 10 exception: LLM tool-input schemas MUST NOT be
    // strict — Claude routinely emits extra fields (reasoning, confidence,
    // metadata). Reject would force a tool-error round-trip; passing
    // through silently is the documented contract.
    const parsed = SearchToolInputSchema.safeParse({
      query: 'Opus One 2018',
      reasoning: 'user named a specific wine',
      confidence: 0.92,
      unexpected: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.query).toBe('Opus One 2018');
      // Unknown fields are stripped from the parsed output (Zod default).
      expect(parsed.data).not.toHaveProperty('reasoning');
      expect(parsed.data).not.toHaveProperty('unexpected');
    }
  });

  it('search_wines should normalize a single occasion tag to the canonical array shape', () => {
    const parsed = SearchToolInputSchema.parse({
      query: '분위기 좋은 와인',
      occasion: 'date_night',
    });

    expect(parsed.occasion).toEqual(['date_night']);
  });

  it('search_wines should accept recipient profile and indexed sensory bounds', () => {
    const parsed = SearchToolInputSchema.parse({
      query: '와인 처음 마시는 부모님께 추천할 와인',
      recipient_profile: 'parents_first_time',
      sweetness_min: '0.2',
      sweetness_max: 0.75,
      acidity_max: 0.75,
      tannin_max: 0.3,
    });

    expect(parsed).toMatchObject({
      recipient_profile: 'parents_first_time',
      sweetness_min: 0.2,
      sweetness_max: 0.75,
      acidity_max: 0.75,
      tannin_max: 0.3,
    });
  });

  it('search_wines should reject food-pairing-scale sensory values', () => {
    const parsed = SearchToolInputSchema.safeParse({
      query: '와인 처음 마시는 부모님께 추천할 와인',
      acidity_max: 6,
      tannin_max: 4,
    });

    expect(parsed.success).toBe(false);
  });

  it('compare_wines should normalize a single shared occasion tag to the canonical array shape', () => {
    const parsed = CompareWinesInputSchema.parse({
      query_a: 'Barolo',
      query_b: 'Brunello',
      occasion: 'anniversary',
    });

    expect(parsed.occasion).toEqual(['anniversary']);
  });

  it('compare_wines should accept shared recipient profile and indexed sensory bounds', () => {
    const parsed = CompareWinesInputSchema.parse({
      query_a: 'Moscato',
      query_b: 'Beaujolais',
      recipient_profile: 'parents_first_time',
      acidity_max: 0.75,
      tannin_max: 0.3,
    });

    expect(parsed).toMatchObject({
      recipient_profile: 'parents_first_time',
      acidity_max: 0.75,
      tannin_max: 0.3,
    });
  });

  it('compare_wines should accept side-specific comparison fields', () => {
    const parsed = CompareWinesInputSchema.parse({
      query_a: '말벡',
      query_b: '말벡',
      country_a: 'France',
      country_b: 'Argentina',
      region_b: 'Mendoza',
    });

    expect(parsed.country_a).toBe('France');
    expect(parsed.country_b).toBe('Argentina');
    expect(parsed.region_b).toBe('Mendoza');
  });

  it('get_food_pairings should reject placeholder food', () => {
    const parsed = FoodPairingInputSchema.safeParse({
      food: '__TO_BE_FILLED__',
    });
    expect(parsed.success).toBe(false);
  });

  it('get_food_pairings should accept typed objective fields', () => {
    const parsed = FoodPairingInputSchema.parse({
      food: '매운 떡볶이',
      sweetness_target: '0.35',
      acidity_min: '6',
      tannin_max: 3,
      styles: ['off_dry'],
      pairing_tags: ['spicy_food'],
    });

    expect(parsed).toMatchObject({
      sweetness_target: 0.35,
      acidity_min: 6,
      tannin_max: 3,
      styles: ['off_dry'],
      pairing_tags: ['spicy_food'],
    });
  });

  it('get_food_pairings should reject out-of-scale typed objectives', () => {
    const parsed = FoodPairingInputSchema.safeParse({
      food: 'salmon',
      sweetness_target: 1.5,
      acidity_min: 11,
    });

    expect(parsed.success).toBe(false);
  });

  it('check_drinking_window should reject placeholder entity_id', () => {
    const parsed = DrinkingWindowInputSchema.safeParse({
      entity_id: '__TO_BE_FILLED__',
    });
    expect(parsed.success).toBe(false);
  });

  it('compare_wines should ACCEPT unknown fields (rule 10: LLMs emit extras)', () => {
    // CLAUDE.md rule 10 exception — see search_wines test above.
    const parsed = CompareWinesInputSchema.safeParse({
      query_a: 'Opus One 2018',
      query_b: 'Sassicaia 2018',
      reasoning: 'side-by-side request',
      extra: 'nope',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.query_a).toBe('Opus One 2018');
      expect(parsed.data.query_b).toBe('Sassicaia 2018');
      expect(parsed.data).not.toHaveProperty('reasoning');
      expect(parsed.data).not.toHaveProperty('extra');
    } else {
      throw new Error('compare_wines must accept extras per rule 10');
    }
  });

  it('search_wines attempt schema should reject non-string-array exclude_grapes', () => {
    const parsed = SearchToolAttemptInputSchema.safeParse({
      query: 'Opus One 2018',
      exclude_grapes: [1, 2],
    });
    expect(parsed.success).toBe(false);
  });

  it('get_food_pairings attempt schema should reject non-string food', () => {
    const parsed = FoodPairingAttemptInputSchema.safeParse({
      food: 123,
    });
    expect(parsed.success).toBe(false);
  });

  it('get_food_pairings attempt schema should preserve typed objective keys', () => {
    const parsed = FoodPairingAttemptInputSchema.parse({
      food: 'tteokbokki',
      sweetness_target: 0.35,
      acidity_min: 6,
      tannin_max: 3,
      styles: ['off_dry'],
      pairing_tags: ['spicy_food'],
    });

    expect(parsed).toMatchObject({
      sweetness_target: 0.35,
      acidity_min: 6,
      tannin_max: 3,
      styles: ['off_dry'],
      pairing_tags: ['spicy_food'],
    });
  });

  it('check_drinking_window attempt schema should reject non-string entity_id', () => {
    const parsed = DrinkingWindowAttemptInputSchema.safeParse({
      entity_id: { nested: 'bad' },
    });
    expect(parsed.success).toBe(false);
  });

  it('compare_wines attempt schema should reject non-string query fields', () => {
    const parsed = CompareWinesAttemptInputSchema.safeParse({
      query_a: ['Opus One'],
      query_b: 'Sassicaia',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('manifest ↔ validator ↔ contract parity', () => {
  it('manifest tool names match KNOWN_AGENT_TOOL_NAMES SSOT', () => {
    const manifestNames = WINE_SEARCH_TOOLS.map((t) => t.name).sort();
    expect(manifestNames).toEqual([...KNOWN_AGENT_TOOL_NAMES].sort());
  });

  it('search_wines manifest properties match contract builder keys', () => {
    const tool = WINE_SEARCH_TOOLS.find((t) => t.name === 'search_wines')!;
    const manifestKeys = Object.keys(tool.input_schema.properties).sort();
    // Contract builder produces all keys except 'query' (which is added separately)
    const contractKeys = ['query', ...Object.keys(buildSearchToolFieldShape({
      limitMax: 50, defaultLimit: 10, defaultRetrievalMode: 'auto', maxPriceKrwMax: Number.MAX_SAFE_INTEGER,
    }))].sort();
    expect(manifestKeys).toEqual(contractKeys);
  });

  it('get_food_pairings manifest properties match contract builder keys', () => {
    const tool = WINE_SEARCH_TOOLS.find((t) => t.name === 'get_food_pairings')!;
    const manifestKeys = Object.keys(tool.input_schema.properties).sort();
    const contractKeys = Object.keys(buildFoodPairingFieldShape({
      foodRequiredMessage: '', maxPriceKrwMax: Number.MAX_SAFE_INTEGER,
    })).sort();
    expect(manifestKeys).toEqual(contractKeys);
  });

  it('check_drinking_window manifest properties match validator schema keys', () => {
    const tool = WINE_SEARCH_TOOLS.find((t) => t.name === 'check_drinking_window')!;
    const manifestKeys = Object.keys(tool.input_schema.properties).sort();
    expect(manifestKeys).toEqual(['entity_id', 'target_year']);
  });

  it('compare_wines manifest properties match validator schema keys', () => {
    const tool = WINE_SEARCH_TOOLS.find((t) => t.name === 'compare_wines')!;
    const manifestKeys = Object.keys(tool.input_schema.properties).sort();
    const contractKeys = [
      'query_a',
      'query_b',
      ...Object.keys(buildCompareToolFieldShape({
        maxPriceKrwMax: Number.MAX_SAFE_INTEGER,
      })),
      'country_a',
      'country_b',
      'region_a',
      'region_b',
      'appellation_a',
      'appellation_b',
      'grape_primary_a',
      'grape_primary_b',
      'wine_type_a',
      'wine_type_b',
      'vintage_min_a',
      'vintage_min_b',
      'vintage_max_a',
      'vintage_max_b',
    ].sort();
    expect(manifestKeys).toEqual(contractKeys);
  });

  it('retrieval_mode enum in manifest matches contract SSOT', () => {
    const tool = WINE_SEARCH_TOOLS.find((t) => t.name === 'search_wines')!;
    const prop = tool.input_schema.properties.retrieval_mode as { enum: readonly string[] };
    expect(prop.enum).toEqual([...SEARCH_TOOL_RETRIEVAL_MODES]);
  });

  it('wine_type enum in manifest matches contract SSOT', () => {
    const tool = WINE_SEARCH_TOOLS.find((t) => t.name === 'search_wines')!;
    const prop = tool.input_schema.properties.wine_type as { enum: readonly string[] };
    expect(prop.enum).toEqual([...SEARCH_TOOL_WINE_TYPES]);
  });

  it('food pairing color enum in manifest matches contract SSOT', () => {
    const tool = WINE_SEARCH_TOOLS.find((t) => t.name === 'get_food_pairings')!;
    const prop = tool.input_schema.properties.color as { enum: readonly string[] };
    expect(prop.enum).toEqual([...FOOD_PAIRING_COLORS]);
  });

  it('vintage bounds in manifest match contract SSOT', () => {
    const tool = WINE_SEARCH_TOOLS.find((t) => t.name === 'search_wines')!;
    const vintageMin = tool.input_schema.properties.vintage_min as { minimum: number; maximum: number };
    const vintageMax = tool.input_schema.properties.vintage_max as { minimum: number; maximum: number };
    expect(vintageMin.minimum).toBe(SEARCH_TOOL_VINTAGE_MIN);
    expect(vintageMin.maximum).toBe(SEARCH_TOOL_VINTAGE_MAX);
    expect(vintageMax.minimum).toBe(SEARCH_TOOL_VINTAGE_MIN);
    expect(vintageMax.maximum).toBe(SEARCH_TOOL_VINTAGE_MAX);
  });

  it('array maxItems in manifest match contract SSOT', () => {
    const tool = WINE_SEARCH_TOOLS.find((t) => t.name === 'search_wines')!;
    const excludeGrapes = tool.input_schema.properties.exclude_grapes as { maxItems: number };
    const excludeRegions = tool.input_schema.properties.exclude_regions as { maxItems: number };
    const styles = tool.input_schema.properties.styles as { maxItems: number };
    expect(excludeGrapes.maxItems).toBe(SEARCH_TOOL_MAX_EXCLUDE_FILTERS);
    expect(excludeRegions.maxItems).toBe(SEARCH_TOOL_MAX_EXCLUDE_FILTERS);
    expect(styles.maxItems).toBe(SEARCH_TOOL_MAX_STYLES);
  });
});

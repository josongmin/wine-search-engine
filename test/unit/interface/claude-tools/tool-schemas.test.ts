/**
 * Unit tests for Claude tool schemas.
 *
 * Validates:
 * - WINE_SEARCH_TOOLS constant contains exactly 4 tools
 * - Each tool has required fields: name, description, input_schema
 * - Input schema format is valid for Claude API
 * - All 4 tools are present: search_wines, get_food_pairings, check_drinking_window, compare_wines
 * - Tool properties have correct types and constraints
 */

import { describe, it, expect } from 'vitest';
import {
  ClaudeToolDefinitionSchema,
  CompareWinesInputSchema,
  DrinkingWindowInputSchema,
  FoodPairingInputSchema,
  SearchToolInputSchema,
  WINE_SEARCH_TOOLS,
} from '../../../../src/interface/claude-tools/tool-schemas.js';

describe('WINE_SEARCH_TOOLS', () => {
  it('should be schema-valid manifest entries', () => {
    const parsed = ClaudeToolDefinitionSchema.array().safeParse(WINE_SEARCH_TOOLS);
    expect(parsed.success).toBe(true);
  });

  it('should contain exactly 4 tools', () => {
    expect(WINE_SEARCH_TOOLS).toHaveLength(4);
  });

  it('should have all 4 required tools', () => {
    const names = WINE_SEARCH_TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'search_wines',
        'get_food_pairings',
        'check_drinking_window',
        'compare_wines',
      ]),
    );
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
      expect(props.vintage_min?.minimum).toBe(1600);
      expect(props.vintage_max?.maximum).toBe(2100);
      expect(props.appellation?.type).toBe('string');
      expect(props.style?.type).toBe('string');
      expect(props.styles?.type).toBe('array');
      expect(props.styles?.maxItems).toBe(5);
      expect(props.certification?.type).toBe('string');
      expect(props.want_diversity?.type).toBe('boolean');
    });

    it('should document the extended semantic style vocabulary', () => {
      const props = tool.input_schema.properties as Record<string, any>;
      expect(props.style?.description).toContain('losslessly');
      expect(props.style?.description).toContain('chillable');
      expect(props.style?.description).toContain('screw_cap');
      expect(props.style?.description).toContain('approachable');
      expect(props.style?.description).toContain('crowd_pleasing');
      expect(props.styles?.description).toContain('approachable');
      expect(props.styles?.description).toContain('crowd_pleasing');
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
  });
});

describe('Claude tool input schemas', () => {
  it('search_wines should reject unknown fields at the boundary', () => {
    const parsed = SearchToolInputSchema.safeParse({
      query: 'Opus One 2018',
      unexpected: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('get_food_pairings should reject placeholder food', () => {
    const parsed = FoodPairingInputSchema.safeParse({
      food: '__TO_BE_FILLED__',
    });
    expect(parsed.success).toBe(false);
  });

  it('check_drinking_window should reject placeholder entity_id', () => {
    const parsed = DrinkingWindowInputSchema.safeParse({
      entity_id: '__TO_BE_FILLED__',
    });
    expect(parsed.success).toBe(false);
  });

  it('compare_wines should reject unknown fields at the boundary', () => {
    const parsed = CompareWinesInputSchema.safeParse({
      query_a: 'Opus One 2018',
      query_b: 'Sassicaia 2018',
      extra: 'nope',
    });
    expect(parsed.success).toBe(false);
  });
});

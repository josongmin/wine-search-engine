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
import { WINE_SEARCH_TOOLS } from '../../../../src/interface/claude-tools/tool-schemas.js';

describe('WINE_SEARCH_TOOLS', () => {
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

    it('should have optional color property with wine colors', () => {
      const colorProp = tool.input_schema.properties.color as any;
      expect(colorProp).toBeDefined();
      expect(colorProp.enum).toEqual(['red', 'white', 'rosé', 'sparkling', 'both']);
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

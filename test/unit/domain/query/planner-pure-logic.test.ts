import { describe, expect, it } from 'vitest';
import {
  shouldApplyFuzzyAnchorFallback,
  shouldTreatSemanticDiscoveryAsShortEntitySurface,
  promoteIntentForVintageBearingSpecificSkuLookup,
} from '../../../../src/domain/query/service/planner-pure-logic.js';
import type { ConstraintBundle } from '../../../../src/domain/shared/types/index.js';

const emptyBundle: ConstraintBundle = { hard: [], soft: [], inferred: [] };

describe('planner pure logic — producer-label identity posture', () => {
  it('allows fuzzy fallback when ontology soft constraints come from a two-token label', () => {
    const constraints: ConstraintBundle = {
      hard: [],
      soft: [{
        attribute: 'appellation',
        operator: '=',
        value: 'Barolo',
        source_phrase: 'barolo',
        confidence: 0.9,
        mapping_version: 'test-v1',
      }],
      inferred: [],
    };

    expect(shouldApplyFuzzyAnchorFallback(
      'barolo giacomo',
      'semantic_preference',
      'semantic_discovery',
      constraints,
      null,
    )).toBe(true);
  });

  it('blocks fuzzy fallback for sensory discovery constraints', () => {
    const constraints: ConstraintBundle = {
      hard: [],
      soft: [{
        attribute: 'body',
        operator: '>=',
        value: 0.7,
        source_phrase: 'full body',
        confidence: 0.9,
        mapping_version: 'test-v1',
      }],
      inferred: [],
    };

    expect(shouldApplyFuzzyAnchorFallback(
      'barolo giacomo',
      'semantic_preference',
      'semantic_discovery',
      constraints,
      null,
    )).toBe(false);
  });

  it('treats two-token semantic_discovery surfaces as short_entity posture', () => {
    expect(shouldTreatSemanticDiscoveryAsShortEntitySurface(
      'barolo giacomo',
      'barolo giacomo',
      'semantic_discovery',
      [],
    )).toBe(true);
  });

  it('keeps single-token appellation surfaces on discovery posture', () => {
    expect(shouldTreatSemanticDiscoveryAsShortEntitySurface(
      'barolo',
      'barolo',
      'semantic_discovery',
      [],
    )).toBe(false);
  });

  it('does not override when anchors already exist', () => {
    expect(shouldTreatSemanticDiscoveryAsShortEntitySurface(
      'barolo giacomo',
      'barolo giacomo',
      'semantic_discovery',
      [{
        normalizedForm: 'barolo giacomo',
        surfaceForm: 'Barolo Giacomo',
        confidence: 0.95,
        candidateEntityIds: ['barolo-giacomo'] as never,
      }],
    )).toBe(false);
  });

  it('keeps recommendation-tailed varietal queries on semantic posture', () => {
    expect(shouldTreatSemanticDiscoveryAsShortEntitySurface(
      '까쇼 추천해줘',
      'cabernet sauvignon',
      'semantic_discovery',
      [],
    )).toBe(false);
  });

  it('still allows fuzzy on short surfaces with no constraints', () => {
    expect(shouldApplyFuzzyAnchorFallback(
      '자코모',
      'unknown',
      'semantic_discovery',
      emptyBundle,
      null,
    )).toBe(true);
  });
});

describe('planner pure logic — vintage-bearing specific SKU intent promotion', () => {
  const fuzzyAnchor = [{
    normalizedForm: 'chateau margxaux',
    surfaceForm: 'Chateau Margxaux',
    confidence: 0.72,
    candidateEntityIds: ['chateau-margaux-2015'] as never,
  }] as const;

  it('promotes facet_search with vintage typo anchors to entity_fuzzy', () => {
    expect(promoteIntentForVintageBearingSpecificSkuLookup(
      'facet_search',
      'Chateau Margxaux 2015',
      'chateau margxaux 2015',
      fuzzyAnchor,
    )).toBe('entity_fuzzy');
  });

  it('does not promote region vintage browse without specific_sku classification', () => {
    expect(promoteIntentForVintageBearingSpecificSkuLookup(
      'facet_search',
      'bordeaux 2015',
      'bordeaux 2015',
      fuzzyAnchor,
    )).toBe('facet_search');
  });

  it('does not promote when anchors are absent', () => {
    expect(promoteIntentForVintageBearingSpecificSkuLookup(
      'facet_search',
      'Chateau Margxaux 2015',
      'chateau margxaux 2015',
      [],
    )).toBe('facet_search');
  });
});
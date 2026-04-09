import { describe, expect, it } from 'vitest';
import { Planner } from '../planner.js';
import { AnchorExtractor } from '../anchor-extractor.js';
import { ExpansionBuilder } from '../expansion-builder.js';
import { NLMapper } from '../../../attribute/service/nl-mapper.js';
import type { MappingTablePort } from '../../../attribute/port/mapping-table.port.js';
import type { NLMapping } from '../../../attribute/model/nl-mapping.js';
import type { AmbiguityDictionary } from '../../port/ambiguity-dictionary.port.js';
import type { AliasMatcher } from '../anchor-extractor.js';

class EmptyAliasMatcher implements AliasMatcher {
  findMatches(): Promise<readonly []> {
    return Promise.resolve([]);
  }
}

class EmptyMappingTable implements MappingTablePort {
  findMapping(): Promise<NLMapping | null> {
    return Promise.resolve(null);
  }

  findMappingsByAttribute(): Promise<readonly NLMapping[]> {
    return Promise.resolve([]);
  }

  getCurrentVersion(): Promise<string> {
    return Promise.resolve('test');
  }
}

const noAmbiguityDict: AmbiguityDictionary = {
  isKnownAmbiguous: () => Promise.resolve(false),
  getAmbiguityInfo: () => Promise.resolve(null),
};

function makePlanner(): Planner {
  const anchorExtractor = new AnchorExtractor(new EmptyAliasMatcher());
  const expansionBuilder = new ExpansionBuilder();
  return new Planner(
    noAmbiguityDict,
    anchorExtractor,
    expansionBuilder,
    new NLMapper(new EmptyMappingTable()),
  );
}

describe('Planner RFC-019 semantic compiler path', () => {
  it('adds ontology-bearing shadow entities and enriched trace for champagne queries', async () => {
    const planner = makePlanner();
    const plan = await planner.plan('샴페인 추천');

    expect(plan.constraints.hard).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'wine_type', value: 'sparkling' }),
        expect.objectContaining({ attribute: 'region', value: 'Champagne' }),
      ]),
    );
    expect(plan.constraints.soft).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'country', value: 'France' }),
      ]),
    );
    expect(plan.constraints.inferred).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'acidity', operator: '>=' }),
      ]),
    );

    expect(plan.constraintExtraction?.source).toBe('resolver');
    expect(plan.constraintExtraction?.resolvedEntityCount).toBeGreaterThan(0);
    expect(plan.constraintExtraction?.candidateSpanCount).toBeGreaterThan(0);
    expect(plan.constraintExtraction?.phrasesByTier?.tier2_entity_resolver).toBeGreaterThan(0);
    expect(plan.constraintExtraction?.categoriesCovered).toEqual(
      expect.arrayContaining(['country', 'region', 'wine_type']),
    );
  });

  it('merges Tier 6 numeric constraints even when entity constraints already matched', async () => {
    const planner = makePlanner();
    const plan = await planner.plan('보르도 2018년 이후 추천');

    expect(plan.constraints.hard).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'region', value: 'Bordeaux' }),
        expect.objectContaining({ attribute: 'vintage_year', operator: '>=', value: 2018 }),
      ]),
    );
    expect(plan.constraintExtraction?.phrasesByTier?.tier6_regex_fallback).toBeGreaterThan(0);
  });
});

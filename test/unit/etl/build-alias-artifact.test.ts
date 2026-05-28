import { describe, expect, it } from 'vitest';
import { buildAliasArtifact } from '../../../scripts/etl/build-alias-artifact.js';
import {
  buildEntityIdBySourceId,
  silverGoldMatchKey,
} from '../../../scripts/etl/snapshot-entity-identity.js';
import type { EnrichedSilverRecord } from '../../../scripts/etl/types.js';

function makeRecord(overrides?: Partial<EnrichedSilverRecord>): EnrichedSilverRecord {
  return {
    sourceId: 'wine-opus-one',
    externalId: 'opus-one-ext',
    canonicalLabel: 'Opus One 2018',
    producer: 'Opus One',
    vintageYear: 2018,
    country: 'United States',
    region: 'Napa Valley',
    appellation: 'Oakville',
    wineType: 'red',
    grapePrimary: 'Cabernet Sauvignon',
    grapes: ['Cabernet Sauvignon', 'Merlot'],
    body: 0.9,
    sweetness: 0.1,
    acidity: 0.5,
    tannin: 0.8,
    pairingTags: ['steak'],
    flavorProfiles: ['black-fruit', 'oak'],
    searchTextEn: 'Opus One 2018 Napa Valley Cabernet blend.',
    ratingAvg: 4.8,
    ratingsCount: 1200,
    priceUsd: 420,
    priceBand: 'luxury',
    popularityScore: 0.95,
    scrapedAt: '2026-04-12T00:00:00.000Z',
    alcoholPct: 14.5,
    producerPrestige: 0.98,
    isTopRated: true,
    aliases: {
      proposed: [
        {
          value: 'Opus One',
          type: 'translation',
          source: 'rule:no_vintage_v1',
          confidencePrior: 0.95,
          needsReview: false,
        },
      ],
      identitySafeProjection: ['Opus One'],
      noisyRecallProjection: [],
    },
    ...overrides,
  };
}

describe('buildAliasArtifact', () => {
  it('transliterates producer and other proposed aliases, not only canonical labels', () => {
    const record = makeRecord();
    const goldLookup = new Map<string, string>([[silverGoldMatchKey(record), 'opus-one-2018']]);
    const entityIdBySourceId = buildEntityIdBySourceId([record], goldLookup);
    const aliases = buildAliasArtifact([record], entityIdBySourceId);

    // entityId is an identity-hash canonical ID, not the gold fixture ID.
    // Find by scope + source instead of hardcoded entityId.
    const transliteratedProducer = aliases.find(
      (alias) =>
        alias.scope === 'locale_ko'
        && alias.source.includes('rule:no_vintage_v1'),
    );

    expect(transliteratedProducer).toBeDefined();
    expect(transliteratedProducer?.value).toContain('오');
    // EXCEPTIONS: 'opus one' → '오푸스원' (compound form includes typo correction)
    expect(transliteratedProducer?.value.replace(/\s+/g, '')).toContain('오푸스');
  });

  it('materializes approved abbreviation overlays into the alias artifact', () => {
    const record = makeRecord({
      sourceId: 'wine-romanee',
      externalId: 'romanee-ext',
      canonicalLabel: 'DRC Romanée-Conti 2015',
      producer: 'Domaine de la Romanée-Conti',
    });
    const goldLookup = new Map<string, string>([[silverGoldMatchKey(record), 'romanee-conti-2015']]);
    const entityIdBySourceId = buildEntityIdBySourceId([record], goldLookup);
    const runtimeEntityId = entityIdBySourceId.get(record.sourceId);
    expect(runtimeEntityId).toBeDefined();
    const aliases = buildAliasArtifact(
      [record],
      entityIdBySourceId,
      new Map([
        [runtimeEntityId!, [{
          value: 'DRC',
          type: 'abbreviation',
          source: 'etl:abbreviation_derivation_v1',
          sourceTrust: 1,
          confidencePrior: 0.82,
          scope: 'global',
        }]],
      ]),
    );

    expect(
      aliases.some((alias) =>
        alias.entityId === runtimeEntityId
        && alias.value === 'DRC'
        && alias.type === 'abbreviation'
        && alias.source === 'etl:abbreviation_derivation_v1'),
    ).toBe(true);
  });
});

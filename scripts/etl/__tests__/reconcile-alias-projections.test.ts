import { describe, expect, it } from 'vitest';
import { createSourceRecordId } from '../../../src/domain/shared/types/index.js';
import type { AliasBundle, EnrichedSilverRecord, ProposedAlias } from '../types.js';
import {
  reconcileAliasBundle,
  reconcileAliasProjectionRecord,
} from '../reconcile-alias-projections.js';

function makeAlias(
  value: string,
  source: string,
  type: ProposedAlias['type'],
  confidencePrior: number,
  needsReview: boolean,
): ProposedAlias {
  return {
    value,
    source,
    type,
    confidencePrior,
    needsReview,
  };
}

function makeRecord(sourceId: string, aliases: AliasBundle): EnrichedSilverRecord {
  return {
    sourceId: createSourceRecordId(sourceId),
    externalId: sourceId,
    canonicalLabel: `Wine ${sourceId}`,
    producer: 'Producer',
    vintageYear: 2018,
    country: 'France',
    region: 'Bordeaux',
    appellation: null,
    wineType: 'red',
    grapePrimary: 'Cabernet Sauvignon',
    grapes: ['Cabernet Sauvignon'],
    body: null,
    sweetness: null,
    acidity: null,
    tannin: null,
    pairingTags: [],
    flavorProfiles: [],
    searchTextEn: 'wine',
    ratingAvg: null,
    ratingsCount: 0,
    priceUsd: null,
    priceBand: 'mid',
    popularityScore: 0,
    scrapedAt: null,
    alcoholPct: null,
    producerPrestige: null,
    isTopRated: false,
    aliases,
  };
}

describe('reconcileAliasBundle', () => {
  it('replaces stale producer-only aliases with authoritative aliases and preserves Hangul phonetics', () => {
    const authoritative: AliasBundle = {
      proposed: [
        makeAlias('Opus One Overture', 'rule:no_vintage_v1', 'translation', 0.85, false),
      ],
      identitySafeProjection: ['Opus One Overture'],
      noisyRecallProjection: [],
    };
    const current: AliasBundle = {
      proposed: [
        makeAlias('Opus One', 'rule:producer_identity_v1', 'translation', 0.95, false),
        makeAlias('오푸스 원', 'llm:ko_translit_v1', 'phonetic', 0.6, false),
        makeAlias('DRC', 'llm:ko_translit_v1', 'phonetic', 0.6, false),
      ],
      identitySafeProjection: ['Opus One'],
      noisyRecallProjection: ['오푸스 원', 'DRC'],
    };

    const result = reconcileAliasBundle(authoritative, current);

    expect(result.proposed).toEqual([
      makeAlias('Opus One Overture', 'rule:no_vintage_v1', 'translation', 0.85, false),
      makeAlias('오푸스 원', 'llm:ko_translit_v1', 'phonetic', 0.6, false),
    ]);
    expect(result.identitySafeProjection).toEqual(['Opus One Overture']);
    expect(result.noisyRecallProjection).toEqual(['오푸스 원']);
  });
});

describe('reconcileAliasProjectionRecord', () => {
  it('regenerates orphaned vivino rows instead of preserving stale producer-only aliases', () => {
    const current = makeRecord('vivino-orphan', {
      proposed: [
        makeAlias('Producer', 'rule:producer_identity_v1', 'translation', 0.95, false),
        makeAlias('Producer 2018', 'rule:producer_vintage_v1', 'translation', 0.95, false),
      ],
      identitySafeProjection: ['Producer', 'Producer 2018'],
      noisyRecallProjection: [],
    });
    const noisyLabelRecord: EnrichedSilverRecord = {
      ...current,
      canonicalLabel: '2018 Producer Producer',
      producer: 'Producer',
    };

    const result = reconcileAliasProjectionRecord(noisyLabelRecord, new Map());

    expect(result.aliases.proposed).toEqual([
      makeAlias('Producer Producer', 'rule:no_vintage_v1', 'translation', 0.85, false),
      makeAlias('Bordeaux Cabernet Sauvignon', 'rule:region_grape_v1', 'catalog_noise_alias', 0.25, true),
    ]);
    expect(result.aliases.identitySafeProjection).toEqual(['Producer Producer']);
    expect(result.aliases.noisyRecallProjection).toEqual(['Bordeaux Cabernet Sauvignon']);
  });

  it('leaves carry-forward records without authoritative source aliases untouched', () => {
    const current = makeRecord('carry-forward', {
      proposed: [
        makeAlias('DRC Romanée-Conti 2015', 'carry_forward', 'translation', 0.95, false),
      ],
      identitySafeProjection: ['DRC Romanée-Conti 2015'],
      noisyRecallProjection: [],
    });

    const result = reconcileAliasProjectionRecord(current, new Map());
    expect(result).toEqual(current);
  });
});

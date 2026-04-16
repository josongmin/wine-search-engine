import { describe, expect, it } from 'vitest';
import { SearchIndexAliasMatcher } from '../search-index-alias-matcher.js';
import { InMemorySearchIndex } from '../../../../test/integration/helpers/in-memory-adapters.js';
import type { RetrievalDocument } from '../../../domain/retrieval/model/retrieval-document.js';
import { createCanonicalEntityId } from '../../../domain/shared/types/index.js';

function makeDoc(overrides: Partial<RetrievalDocument> = {}): RetrievalDocument {
  return {
    entityId: createCanonicalEntityId('wine-opus-one-2018'),
    entityType: 'wine',
    canonicalLabel: 'Opus One 2018',
    aliasesIdentitySafe: ['Opus One 2018'],
    aliasesNoisyRecall: ['오푸스원', '오퍼스 원', 'opus one'],
    producer: 'Opus One',
    region: 'United States / Napa Valley',
    grapes: ['Cabernet Sauvignon'],
    searchTextKo: '오푸스원 2018 나파 밸리 카베르네 소비뇽',
    searchTextEn: 'Opus One 2018 Napa Valley Cabernet Sauvignon',
    semanticSummary: 'Opus One Napa Valley flagship red wine',
    style: 'full red',
    priceBand: 'luxury',
    pairing: ['steak'],
    availability: true,
    popularityScore: 0.95,
    ...overrides,
  };
}

describe('SearchIndexAliasMatcher', () => {
  it('matches vintage-stripped canonical labels from the search index', async () => {
    const searchIndex = new InMemorySearchIndex();
    const doc = makeDoc();
    await searchIndex.upsertDocument(doc);

    const matcher = new SearchIndexAliasMatcher(searchIndex);
    const matches = await matcher.findMatches('Opus One');

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.entityIds).toContain(doc.entityId);
    expect(matches[0]?.lookupStrategy).toContain('index_exact');
  });

  it('matches Korean noisy-recall aliases via transliterated exactness', async () => {
    const searchIndex = new InMemorySearchIndex();
    const doc = makeDoc();
    await searchIndex.upsertDocument(doc);

    const matcher = new SearchIndexAliasMatcher(searchIndex);
    const matches = await matcher.findMatches('오푸스원');

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.entityIds).toContain(doc.entityId);
    expect(matches[0]?.lookupStrategy).toContain('index_transliterated_exact');
  });

  it('matches Korean typo variants through the search-index alias substrate', async () => {
    const searchIndex = new InMemorySearchIndex();
    const doc = makeDoc();
    await searchIndex.upsertDocument(doc);

    const matcher = new SearchIndexAliasMatcher(searchIndex);
    const matches = await matcher.findMatches('오퍼스원');

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.entityIds).toContain(doc.entityId);
    expect(matches[0]?.lookupStrategy).toContain('index_transliterated_exact');
  });

  it('anchors entity phrases embedded in metadata questions', async () => {
    const searchIndex = new InMemorySearchIndex();
    const doc = makeDoc();
    await searchIndex.upsertDocument(doc);

    const matcher = new SearchIndexAliasMatcher(searchIndex);
    const matches = await matcher.findMatches('오푸스원 지금 마시기 좋아?');

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.entityIds).toContain(doc.entityId);
    expect(matches[0]?.lookupStrategy).toContain('index_transliterated_exact');
  });

  it('anchors canonical grape names even when trailing request words remain in the query', async () => {
    const searchIndex = new InMemorySearchIndex();
    const doc = makeDoc({
      canonicalLabel: 'Cabernet Sauvignon 2018',
      aliasesIdentitySafe: ['Cabernet Sauvignon 2018'],
      aliasesNoisyRecall: ['cabernet sauvignon'],
      grapes: ['Cabernet Sauvignon'],
      searchTextKo: '까베르네 소비뇽 2018',
      searchTextEn: 'Cabernet Sauvignon 2018 Napa Valley',
    });
    await searchIndex.upsertDocument(doc);

    const matcher = new SearchIndexAliasMatcher(searchIndex);
    const matches = await matcher.findMatches('Cabernet Sauvignon 추천');

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.entityIds).toContain(doc.entityId);
    expect(matches[0]?.lookupStrategy).toContain('index_exact');
  });
});

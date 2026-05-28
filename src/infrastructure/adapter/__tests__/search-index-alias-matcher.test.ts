import { describe, expect, it, vi } from 'vitest';
import { SearchIndexAliasMatcher } from '../search-index-alias-matcher.js';
import type { AliasMatcher } from '../../../domain/query/service/anchor-extractor.js';
import { InMemorySearchIndex } from '../../../../test/integration/helpers/in-memory-adapters.js';
import type { RetrievalDocument } from '../../../domain/retrieval/model/retrieval-document.js';
import { createCanonicalEntityId } from '../../../domain/shared/types/index.js';
import type { SearchIndexPort } from '../../../domain/retrieval/port/search-index.port.js';
import { CascadingAliasMatcher } from '../search-index-alias-matcher.js';
import { CircuitBreakerOpenError } from '../../../domain/shared/error/circuit-breaker-open-error.js';
import { VespaNetworkError } from '../../vespa/vespa-client.js';

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

  it('rejects whole-token short lexical entity forms against multi-token canonical labels', async () => {
    const searchIndex = new InMemorySearchIndex();
    const doc = makeDoc();
    await searchIndex.upsertDocument(doc);

    const matcher = new SearchIndexAliasMatcher(searchIndex);
    const matches = await matcher.findMatches('opus');

    expect(matches).toEqual([]);
  });

  it('matches latin entity prefixes through the dedicated prefix substrate', async () => {
    const searchIndex = new InMemorySearchIndex();
    const doc = makeDoc();
    await searchIndex.upsertDocument(doc);

    const matcher = new SearchIndexAliasMatcher(searchIndex);
    const matches = await matcher.findMatches('opu');

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.entityIds).toContain(doc.entityId);
    expect(matches[0]?.lookupStrategy).toContain('index_prefix_exact');
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

  it.each(['오푸스', '오퍼스'])(
    'matches completed Korean entity prefixes through cross-script prefix substrate (%s)',
    async (query) => {
      const searchIndex = new InMemorySearchIndex();
      const doc = makeDoc();
      await searchIndex.upsertDocument(doc);

      const matcher = new SearchIndexAliasMatcher(searchIndex);
      const matches = await matcher.findMatches(query);

      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0]?.entityIds).toContain(doc.entityId);
      expect(matches[0]?.lookupStrategy).toContain('index_transliterated_exact');
    },
  );

  it('matches IME-incomplete Korean prefixes through curated exception prefix romanization', async () => {
    const searchIndex = new InMemorySearchIndex();
    const doc = makeDoc();
    await searchIndex.upsertDocument(doc);

    const matcher = new SearchIndexAliasMatcher(searchIndex);
    const matches = await matcher.findMatches('오푸스ㅇ');

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.entityIds).toContain(doc.entityId);
    expect(matches[0]?.lookupStrategy).toContain('index_transliterated_fuzzy');
  });

  it('matches completed multi-syllable Korean prefixes through curated exception prefix romanization', async () => {
    const searchIndex = new InMemorySearchIndex();
    const doc = makeDoc();
    await searchIndex.upsertDocument(doc);

    const matcher = new SearchIndexAliasMatcher(searchIndex);
    const matches = await matcher.findMatches('오푸');

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.entityIds).toContain(doc.entityId);
    expect(matches[0]?.lookupStrategy).toContain('index_transliterated_exact');
  });

  it('matches IME-incomplete Korean typo prefixes through typo-corrected exception prefix romanization', async () => {
    const searchIndex = new InMemorySearchIndex();
    const doc = makeDoc();
    await searchIndex.upsertDocument(doc);

    const matcher = new SearchIndexAliasMatcher(searchIndex);
    const matches = await matcher.findMatches('오퍼스ㅇ');

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.entityIds).toContain(doc.entityId);
    expect(matches[0]?.lookupStrategy).toContain('index_transliterated_fuzzy');
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

  it('batches multiple lookup queries into a single sparseSearch call', async () => {
    const backingIndex = new InMemorySearchIndex();
    await backingIndex.upsertDocument(makeDoc());

    const searchIndex = {
      sparseSearch: vi.fn(backingIndex.sparseSearch.bind(backingIndex)),
    } satisfies Pick<SearchIndexPort, 'sparseSearch'>;

    const matcher = new SearchIndexAliasMatcher(searchIndex as SearchIndexPort);
    const batch = await matcher.findMatchesBatch([
      '오푸스원 지금 마시기 좋아?',
      '오퍼스원',
    ]);

    expect(searchIndex.sparseSearch).toHaveBeenCalledTimes(1);
    expect(batch.get('오푸스원 지금 마시기 좋아?')?.[0]?.entityIds).toContain(
      createCanonicalEntityId('wine-opus-one-2018'),
    );
    expect(batch.get('오퍼스원')?.[0]?.entityIds).toContain(
      createCanonicalEntityId('wine-opus-one-2018'),
    );
  });

  it('surface-only mode does not expand span-level fallback queries for generic misses', async () => {
    const searchIndex = {
      sparseSearch: vi.fn(async () => []),
    } satisfies Pick<SearchIndexPort, 'sparseSearch'>;

    const matcher = new SearchIndexAliasMatcher(searchIndex as SearchIndexPort, {
      surfaceOnly: true,
    });
    await matcher.findMatchesBatch(['wine for cheese']);

    expect(searchIndex.sparseSearch).toHaveBeenCalledTimes(1);
    expect(searchIndex.sparseSearch.mock.calls[0]?.[0]).toEqual(
      expect.not.arrayContaining(['wine', 'for', 'cheese']),
    );
  });

  it('drops punctuation-only fallback queries before sparseSearch so Vespa never sees NullItem YQL', async () => {
    const backingIndex = new InMemorySearchIndex();
    await backingIndex.upsertDocument(makeDoc());

    const searchIndex = {
      sparseSearch: vi.fn(backingIndex.sparseSearch.bind(backingIndex)),
    } satisfies Pick<SearchIndexPort, 'sparseSearch'>;

    const matcher = new SearchIndexAliasMatcher(searchIndex as SearchIndexPort);
    const batch = await matcher.findMatchesBatch([
      '&',
      'Opus One',
    ]);

    expect(searchIndex.sparseSearch).toHaveBeenCalledTimes(1);
    expect(searchIndex.sparseSearch.mock.calls[0]?.[0]).toEqual(
      expect.not.arrayContaining(['&']),
    );
    expect(batch.get('&')).toEqual([]);
    expect(batch.get('Opus One')?.[0]?.entityIds).toContain(
      createCanonicalEntityId('wine-opus-one-2018'),
    );
  });

  it('returns empty matches without calling sparseSearch when every fallback query is punctuation-only', async () => {
    const searchIndex = {
      sparseSearch: vi.fn(),
    } satisfies Pick<SearchIndexPort, 'sparseSearch'>;

    const matcher = new SearchIndexAliasMatcher(searchIndex as SearchIndexPort);
    const batch = await matcher.findMatchesBatch(['&', '/', '...']);

    expect(searchIndex.sparseSearch).not.toHaveBeenCalled();
    expect(batch.get('&')).toEqual([]);
    expect(batch.get('/')).toEqual([]);
    expect(batch.get('...')).toEqual([]);
  });

  it('degrades Vespa transport failures to empty alias matches instead of throwing', async () => {
    const searchIndex = {
      sparseSearch: vi.fn(async () => {
        throw new VespaNetworkError('HTTP/2 GOAWAY', new TypeError('HTTP/2 GOAWAY'));
      }),
    } satisfies Pick<SearchIndexPort, 'sparseSearch'>;

    const matcher = new SearchIndexAliasMatcher(searchIndex as SearchIndexPort);
    const batch = await matcher.findMatchesBatch([
      '오푸스원 지금 마시기 좋아?',
      '오퍼스원',
    ]);

    expect(searchIndex.sparseSearch).toHaveBeenCalledTimes(1);
    expect(batch.get('오푸스원 지금 마시기 좋아?')).toEqual([]);
    expect(batch.get('오퍼스원')).toEqual([]);
  });

  it('degrades OPEN circuit-breaker alias lookups to empty matches instead of crashing', async () => {
    const searchIndex = {
      sparseSearch: vi.fn(async () => {
        throw new CircuitBreakerOpenError('vespa-search');
      }),
    } satisfies Pick<SearchIndexPort, 'sparseSearch'>;

    const matcher = new SearchIndexAliasMatcher(searchIndex as SearchIndexPort);
    const batch = await matcher.findMatchesBatch([
      '오푸스원',
      '오퍼스원',
    ]);

    expect(searchIndex.sparseSearch).toHaveBeenCalledTimes(1);
    expect(batch.get('오푸스원')).toEqual([]);
    expect(batch.get('오퍼스원')).toEqual([]);
  });

  it('falls back to secondary batch for unresolved primary misses', async () => {
    const primary: AliasMatcher = {
      findMatches: async () => [],
    };
    const secondary: AliasMatcher = {
      findMatches: async () => [],
      findMatchesBatch: async (_queries) => new Map([
        [
          '오푸스원',
          [
            {
              surfaceForm: '오푸스원',
              normalizedForm: '오푸스원',
              entityIds: [createCanonicalEntityId('entity-opus')],
              matchConfidence: 0.84,
            },
          ],
        ],
        [
          '오퍼스원',
          [
            {
              surfaceForm: '오퍼스원',
              normalizedForm: '오퍼스원',
              entityIds: [createCanonicalEntityId('entity-opus')],
              matchConfidence: 0.83,
            },
          ],
        ],
      ]),
    };

    const matcher = new CascadingAliasMatcher(primary, secondary);
    const batch = await matcher.findMatchesBatch(['오푸스원', '오퍼스원']);

    expect(batch.get('오푸스원')?.[0]?.entityIds).toContain(createCanonicalEntityId('entity-opus'));
    expect(batch.get('오퍼스원')?.[0]?.entityIds).toContain(createCanonicalEntityId('entity-opus'));
  });
});

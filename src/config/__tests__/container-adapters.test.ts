import { describe, expect, it, vi } from 'vitest';
import { SearchSnapshotAliasMatcher } from '../../infrastructure/adapter/search-snapshot-alias-matcher.js';
import { CachedAliasMatcher } from '../../infrastructure/adapter/cached-alias-matcher.js';
import * as PgAliasMatcherAdapter from '../../infrastructure/adapter/pg-alias-matcher.js';
import { buildCoreAdapterServices } from '../container-adapters.js';
import { parseEnv } from '../env.js';
import { CachedReranker } from '../../infrastructure/ai/cached-reranker.js';
import { VespaSearchIndex } from '../../infrastructure/vespa/vespa-search-index.js';
import type { SparseHit } from '../../domain/retrieval/port/search-index.port.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';

describe('buildCoreAdapterServices', () => {
  it('rejects stub-backed core adapters in production without PostgreSQL', async () => {
    const config = parseEnv({
      NODE_ENV: 'production',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
      OPENAI_API_KEY: 'sk-test',
    });

    await expect(buildCoreAdapterServices(config, {})).rejects.toThrowError(/PostgreSQL-backed adapters/);
  });

  it('still allows local stub-backed adapters outside production', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });

    await expect(buildCoreAdapterServices(config, {})).resolves.toBeDefined();
  });

  it('wires CohereReranker when COHERE_API_KEY is set', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
      COHERE_API_KEY: 'co-test',
      COHERE_RERANK_MODEL: 'rerank-v4.0-pro',
    });

    const adapters = await buildCoreAdapterServices(config, {});

    expect(adapters.reranker).toBeInstanceOf(CachedReranker);
  });

  it('leaves reranker undefined when COHERE_API_KEY is not set', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });

    const adapters = await buildCoreAdapterServices(config, {});

    expect(adapters.reranker).toBeUndefined();
  });

  it('uses search-index alias authority when PostgreSQL is unavailable', async () => {
    const loadSpy = vi
      .spyOn(SearchSnapshotAliasMatcher, 'loadFromRuntimeState')
      .mockResolvedValue({
        findMatches: () => Promise.resolve([
          {
            surfaceForm: 'Snapshot Opus One',
            normalizedForm: 'snapshot opus one',
            entityIds: ['snapshot-opus-one'],
            matchConfidence: 0.99,
            lookupStrategy: 'in_memory',
          },
        ]),
        findMatchesBatch: () => Promise.resolve(new Map()),
      } as SearchSnapshotAliasMatcher);
    const sparseSearchSpy = vi
      .spyOn(VespaSearchIndex.prototype, 'sparseSearch')
      .mockResolvedValue([
        {
          entityId: createCanonicalEntityId('index-opus-one'),
          score: 1,
          rank: 1,
          matchedFields: ['canonical_label'],
          summary: {
            canonicalLabel: 'Opus One',
          },
        },
      ] satisfies readonly SparseHit[]);

    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });

    try {
      const adapters = await buildCoreAdapterServices(config, {});
      expect(adapters.aliasMatcher).toBeInstanceOf(CachedAliasMatcher);
      expect(await adapters.aliasMatcher.findMatches('opus one')).toEqual([
        {
          surfaceForm: 'Opus One',
          normalizedForm: 'opus one',
          entityIds: ['index-opus-one'],
          matchConfidence: 0.97,
          lookupStrategy: 'index_exact',
        },
      ]);
      expect(loadSpy).not.toHaveBeenCalled();
      expect(sparseSearchSpy).toHaveBeenCalled();
    } finally {
      loadSpy.mockRestore();
      sparseSearchSpy.mockRestore();
    }
  });

  it('prefers PostgreSQL in-memory alias substrate when aliases table is present', async () => {
    const aliasTableAvailableSpy = vi
      .spyOn(PgAliasMatcherAdapter, 'isAliasTableAvailable')
      .mockResolvedValue(true);
    const loadFromPostgresSpy = vi
      .spyOn(SearchSnapshotAliasMatcher, 'loadFromPostgres')
      .mockResolvedValue({
        findMatches: () => Promise.resolve([]),
        findMatchesBatch: () => Promise.resolve(new Map()),
      } as SearchSnapshotAliasMatcher);
    const loadSpy = vi
      .spyOn(SearchSnapshotAliasMatcher, 'loadFromRuntimeState')
      .mockResolvedValue(undefined);

    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });
    const fakePool = { query: vi.fn() } as never;

    try {
      await buildCoreAdapterServices(config, { pool: fakePool });
      expect(aliasTableAvailableSpy).toHaveBeenCalledWith(fakePool);
      expect(loadFromPostgresSpy).toHaveBeenCalledWith(fakePool);
      expect(loadSpy).not.toHaveBeenCalled();
    } finally {
      aliasTableAvailableSpy.mockRestore();
      loadSpy.mockRestore();
      loadFromPostgresSpy.mockRestore();
    }
  });

  it('uses search-index alias authority when PostgreSQL aliases table is absent', async () => {
    const aliasTableAvailableSpy = vi
      .spyOn(PgAliasMatcherAdapter, 'isAliasTableAvailable')
      .mockResolvedValue(false);
    const loadFromPostgresSpy = vi
      .spyOn(SearchSnapshotAliasMatcher, 'loadFromPostgres')
      .mockResolvedValue(undefined);
    const loadSpy = vi
      .spyOn(SearchSnapshotAliasMatcher, 'loadFromRuntimeState')
      .mockResolvedValue(undefined);
    const sparseSearchSpy = vi
      .spyOn(VespaSearchIndex.prototype, 'sparseSearch')
      .mockResolvedValue([
        {
          entityId: createCanonicalEntityId('index-opus-one'),
          score: 1,
          rank: 1,
          matchedFields: ['canonical_label'],
          summary: {
            canonicalLabel: 'Opus One',
          },
        },
      ] satisfies readonly SparseHit[]);

    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });
    const fakePool = { query: vi.fn() } as never;

    try {
      const adapters = await buildCoreAdapterServices(config, { pool: fakePool });
      expect(aliasTableAvailableSpy).toHaveBeenCalledWith(fakePool);
      expect(loadFromPostgresSpy).not.toHaveBeenCalled();
      expect(loadSpy).not.toHaveBeenCalled();
      expect(adapters.aliasMatcher).toBeInstanceOf(CachedAliasMatcher);
      const matches = await adapters.aliasMatcher.findMatches('opus one');
      expect(matches).toEqual([
        {
          surfaceForm: 'Opus One',
          normalizedForm: 'opus one',
          entityIds: ['index-opus-one'],
          matchConfidence: 0.97,
          lookupStrategy: 'index_exact',
        },
      ]);
      expect(sparseSearchSpy).toHaveBeenCalled();
    } finally {
      aliasTableAvailableSpy.mockRestore();
      loadSpy.mockRestore();
      loadFromPostgresSpy.mockRestore();
      sparseSearchSpy.mockRestore();
    }
  });
});

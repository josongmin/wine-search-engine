import { describe, expect, it, vi } from 'vitest';
import { SearchSnapshotAliasMatcher } from '../../infrastructure/adapter/search-snapshot-alias-matcher.js';
import { CachedAliasMatcher } from '../../infrastructure/adapter/cached-alias-matcher.js';
import type { AliasMatcher } from '../../domain/query/service/anchor-extractor.js';
import * as PgAliasMatcherAdapter from '../../infrastructure/adapter/pg-alias-matcher.js';
import { buildCoreAdapterServices } from '../container-adapters.js';
import { parseEnv } from '../env.js';
import { CachedReranker } from '../../infrastructure/ai/cached-reranker.js';

describe('buildCoreAdapterServices', () => {
  it('rejects stub-backed core adapters in production without PostgreSQL', async () => {
    const config = parseEnv({
      NODE_ENV: 'production',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
      ANTHROPIC_API_KEY: 'sk-ant-test',
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

  it('prefers in-memory search-snapshot alias matcher when PG is unavailable', async () => {
    const fakeSnapshotAliasMatcher = {
      findMatches: () => Promise.resolve([]),
      findMatchesBatch: () => Promise.resolve(new Map()),
    } as AliasMatcher;
    const loadSpy = vi
      .spyOn(SearchSnapshotAliasMatcher, 'loadFromRuntimeState')
      .mockResolvedValue(fakeSnapshotAliasMatcher as SearchSnapshotAliasMatcher);

    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });

    try {
      const adapters = await buildCoreAdapterServices(config, {});
      expect(loadSpy).toHaveBeenCalled();
      expect(adapters.aliasMatcher).toBeInstanceOf(CachedAliasMatcher);
      expect(await adapters.aliasMatcher.findMatches('opus one')).toEqual([]);
    } finally {
      loadSpy.mockRestore();
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
    const fakeSnapshotAliasMatcher = {
      findMatches: () => Promise.resolve([]),
      findMatchesBatch: () => Promise.resolve(new Map()),
    } as AliasMatcher;
    const loadSpy = vi
      .spyOn(SearchSnapshotAliasMatcher, 'loadFromRuntimeState')
      .mockResolvedValue(fakeSnapshotAliasMatcher as SearchSnapshotAliasMatcher);

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

  it('falls back to search-snapshot matcher when PostgreSQL aliases table is absent', async () => {
    const aliasTableAvailableSpy = vi
      .spyOn(PgAliasMatcherAdapter, 'isAliasTableAvailable')
      .mockResolvedValue(false);
    const loadFromPostgresSpy = vi
      .spyOn(SearchSnapshotAliasMatcher, 'loadFromPostgres')
      .mockResolvedValue(undefined);
    const fakeSnapshotAliasMatcher = {
      findMatches: () => Promise.resolve([
        {
          surfaceForm: 'Opus One',
          normalizedForm: 'opus one',
          entityIds: ['entity-opus-one'],
          matchConfidence: 0.97,
          lookupStrategy: 'in_memory',
        },
      ]),
      findMatchesBatch: () => Promise.resolve(
        new Map([
          [
            'opus one',
            [
              {
                surfaceForm: 'Opus One',
                normalizedForm: 'opus one',
                entityIds: ['entity-opus-one'],
                matchConfidence: 0.97,
                lookupStrategy: 'in_memory',
              },
            ],
          ],
        ]),
      ),
    } as AliasMatcher;
    const loadSpy = vi
      .spyOn(SearchSnapshotAliasMatcher, 'loadFromRuntimeState')
      .mockResolvedValue(fakeSnapshotAliasMatcher as SearchSnapshotAliasMatcher);

    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });
    const fakePool = { query: vi.fn() } as never;

    try {
      const adapters = await buildCoreAdapterServices(config, { pool: fakePool });
      expect(aliasTableAvailableSpy).toHaveBeenCalledWith(fakePool);
      expect(loadFromPostgresSpy).not.toHaveBeenCalled();
      expect(loadSpy).toHaveBeenCalled();
      expect(adapters.aliasMatcher).toBeInstanceOf(CachedAliasMatcher);
      const matches = await adapters.aliasMatcher.findMatches('opus one');
      expect(matches).toEqual([
        {
          surfaceForm: 'Opus One',
          normalizedForm: 'opus one',
          entityIds: ['entity-opus-one'],
          matchConfidence: 0.97,
          lookupStrategy: 'in_memory',
        },
      ]);
    } finally {
      aliasTableAvailableSpy.mockRestore();
      loadSpy.mockRestore();
      loadFromPostgresSpy.mockRestore();
    }
  });
});

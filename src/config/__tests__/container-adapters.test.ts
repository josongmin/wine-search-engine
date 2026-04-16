import { describe, expect, it, vi } from 'vitest';
import { SearchSnapshotAliasMatcher } from '../../infrastructure/adapter/search-snapshot-alias-matcher.js';
import { CachedAliasMatcher } from '../../infrastructure/adapter/cached-alias-matcher.js';
import type { AliasMatcher } from '../../domain/query/service/anchor-extractor.js';
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

  it('does not preload search-snapshot matcher when PostgreSQL is present', async () => {
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
    const fakePool = {} as never;

    try {
      await buildCoreAdapterServices(config, { pool: fakePool });
      expect(loadSpy).not.toHaveBeenCalled();
    } finally {
      loadSpy.mockRestore();
    }
  });
});

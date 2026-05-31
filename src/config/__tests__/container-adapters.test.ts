import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchSnapshotAliasMatcher } from '../../infrastructure/adapter/search-snapshot-alias-matcher.js';
import { CachedAliasMatcher } from '../../infrastructure/adapter/cached-alias-matcher.js';
import * as PgAliasMatcherAdapter from '../../infrastructure/adapter/pg-alias-matcher.js';
import { buildCoreAdapterServices } from '../container-adapters.js';
import { parseEnv } from '../env.js';
import { CachedReranker } from '../../infrastructure/ai/cached-reranker.js';
import { OpenAiEmbeddingService } from '../../infrastructure/ai/openai-embedding-service.js';
import { VespaSearchIndex } from '../../infrastructure/vespa/vespa-search-index.js';
import { VespaNetworkError } from '../../infrastructure/vespa/vespa-client.js';
import type { SparseHit } from '../../domain/retrieval/port/search-index.port.js';
import { CircuitBreakerOpenError } from '../../domain/shared/error/circuit-breaker-open-error.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';
import { LazyFuzzyMatcher } from '../../infrastructure/adapter/lazy-fuzzy-matcher.js';

describe('buildCoreAdapterServices', () => {
  afterEach(() => {
    delete process.env['CODEX_AUTH_JSON_PATH'];
  });

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

  it('constructs runtime chatLlm from an explicit Codex auth path when OpenAI keys are absent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wine-container-codex-chat-'));
    const authPath = path.join(dir, 'auth.json');
    const previousApiKey = process.env['OPENAI_API_KEY'];
    const previousApiKeys = process.env['OPENAI_API_KEYS'];
    process.env['CODEX_AUTH_JSON_PATH'] = authPath;
    delete process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEYS'];
    try {
      await writeFile(authPath, JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          access_token: 'at-1',
          refresh_token: 'rt-1',
          account_id: 'acct-1',
        },
      }), 'utf8');

      const config = parseEnv({ NODE_ENV: 'test' });
      const adapters = await buildCoreAdapterServices(config, {});
      expect(adapters.chatLlm).toBeDefined();
    } finally {
      if (previousApiKey !== undefined) process.env['OPENAI_API_KEY'] = previousApiKey;
      if (previousApiKeys !== undefined) process.env['OPENAI_API_KEYS'] = previousApiKeys;
      await rm(dir, { recursive: true, force: true });
    }
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

  it('wires the embedding adapter with retrieval-specific timeout instead of chat timeout', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
      OPENAI_API_KEY: 'sk-test',
      OPENAI_HTTP_TIMEOUT_MS: '120000',
      EMBEDDING_HTTP_TIMEOUT_MS: '30000',
    });

    const adapters = await buildCoreAdapterServices(config, {});

    expect(adapters.embeddingService).toBeInstanceOf(OpenAiEmbeddingService);
    expect((adapters.embeddingService as unknown as { httpTimeoutMs: number }).httpTimeoutMs).toBe(30000);
  });

  it('uses search-index alias authority when PostgreSQL is unavailable', async () => {
    const warmSpy = vi.spyOn(LazyFuzzyMatcher.prototype, 'warm');
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
        getSurfaceForms: () => ['Snapshot Opus One'],
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
      expect(adapters.fuzzyMatcher).toBeUndefined();
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

  it('shares the fast-fail Vespa unavailability latch between alias fallback and retrieval', async () => {
    const sparseSearchSpy = vi
      .spyOn(VespaSearchIndex.prototype, 'sparseSearch')
      .mockRejectedValue(new VespaNetworkError(
        'Vespa request timed out after 3000ms',
        new Error('connect ETIMEDOUT'),
      ));
    const denseSearchSpy = vi
      .spyOn(VespaSearchIndex.prototype, 'denseSearch')
      .mockResolvedValue([]);

    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });

    try {
      const adapters = await buildCoreAdapterServices(config, {});
      await expect(adapters.aliasMatcher.findMatches('medium body united states')).resolves.toEqual([]);
      await expect(adapters.searchIndex.denseSearch([0.1, 0.2, 0.3])).rejects.toBeInstanceOf(CircuitBreakerOpenError);
      expect(sparseSearchSpy).toHaveBeenCalledTimes(1);
      expect(denseSearchSpy).not.toHaveBeenCalled();
    } finally {
      sparseSearchSpy.mockRestore();
      denseSearchSpy.mockRestore();
    }
  });

  it('uses snapshot-manifest alias substrate for non-live snapshot bindings without PostgreSQL', async () => {
    const warmSpy = vi.spyOn(LazyFuzzyMatcher.prototype, 'warm');
    const exactQuery = '2017 delas le clos rouge crozes-hermitage';
    const exactMatch = {
      surfaceForm: 'Delas Le Clos Rouge Crozes-Hermitage',
      normalizedForm: 'delas le clos rouge crozes-hermitage',
      entityIds: ['snapshot-delas'],
      matchConfidence: 0.99,
      lookupStrategy: 'in_memory',
    } as const;
    const loadFromManifestSpy = vi
      .spyOn(SearchSnapshotAliasMatcher, 'loadFromManifest')
      .mockResolvedValue({
        findMatches: (query: string) => Promise.resolve(query === exactQuery ? [exactMatch] : []),
        findMatchesBatch: (queries: readonly string[]) => Promise.resolve(new Map(
          queries.map((query) => [query, query === exactQuery ? [exactMatch] : []] as const),
        )),
        getSurfaceForms: () => ['Delas Le Clos Rouge Crozes-Hermitage'],
      } as SearchSnapshotAliasMatcher);
    const sparseSearchSpy = vi
      .spyOn(VespaSearchIndex.prototype, 'sparseSearch')
      .mockResolvedValue([] satisfies readonly SparseHit[]);

    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });

    try {
      const adapters = await buildCoreAdapterServices(config, {
        searchSnapshotId: 'search-snapshot:v1:target',
        searchSnapshotManifestPath: '/tmp/search-snapshot:v1:target/manifest.json',
      });
      expect(adapters.fuzzyMatcher).toBeDefined();
      const matches = await adapters.aliasMatcher.findMatches(exactQuery);
      const misses = await adapters.aliasMatcher.findMatches('missing non-snapshot alias');
      expect(loadFromManifestSpy).toHaveBeenCalledWith('/tmp/search-snapshot:v1:target/manifest.json');
      expect(matches).toEqual([
        exactMatch,
      ]);
      expect(misses).toEqual([]);
      expect(sparseSearchSpy).not.toHaveBeenCalled();
      expect(warmSpy).toHaveBeenCalledTimes(1);
    } finally {
      warmSpy.mockRestore();
      loadFromManifestSpy.mockRestore();
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
        getSurfaceForms: () => ['Opus One'],
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
      expect(aliasTableAvailableSpy).toHaveBeenCalledWith(fakePool, {
        queryTimeoutMs: 1500,
      });
      expect(loadFromPostgresSpy).toHaveBeenCalledWith(fakePool, undefined, {
        queryTimeoutMs: 1500,
      });
      expect(loadSpy).not.toHaveBeenCalled();
    } finally {
      aliasTableAvailableSpy.mockRestore();
      loadSpy.mockRestore();
      loadFromPostgresSpy.mockRestore();
    }
  });

  it('skips snapshot manifest alias preload when PostgreSQL alias overlay is available', async () => {
    const aliasTableAvailableSpy = vi
      .spyOn(PgAliasMatcherAdapter, 'isAliasTableAvailable')
      .mockResolvedValue(true);
    const loadFromPostgresSpy = vi
      .spyOn(SearchSnapshotAliasMatcher, 'loadFromPostgres')
      .mockResolvedValue({
        findMatches: () => Promise.resolve([]),
        findMatchesBatch: () => Promise.resolve(new Map()),
        getSurfaceForms: () => ['Opus One'],
      } as SearchSnapshotAliasMatcher);
    const loadFromManifestSpy = vi
      .spyOn(SearchSnapshotAliasMatcher, 'loadFromManifest')
      .mockResolvedValue(undefined);

    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });
    const fakePool = { query: vi.fn() } as never;

    try {
      await buildCoreAdapterServices(config, {
        pool: fakePool,
        searchSnapshotId: 'search-snapshot:v1:target',
        searchSnapshotManifestPath: '/tmp/search-snapshot:v1:target/manifest.json',
      });
      expect(aliasTableAvailableSpy).toHaveBeenCalledWith(fakePool, {
        queryTimeoutMs: 1500,
      });
      expect(loadFromPostgresSpy).toHaveBeenCalledWith(
        fakePool,
        'search-snapshot:v1:target',
        {
          queryTimeoutMs: 1500,
        },
      );
      expect(loadFromManifestSpy).not.toHaveBeenCalled();
    } finally {
      aliasTableAvailableSpy.mockRestore();
      loadFromPostgresSpy.mockRestore();
      loadFromManifestSpy.mockRestore();
    }
  });

  it('falls back to snapshot manifest alias preload when PostgreSQL overlay resolves empty', async () => {
    const exactQuery = '2017 delas le clos rouge crozes-hermitage';
    const exactMatch = {
      surfaceForm: 'Delas Le Clos Rouge Crozes-Hermitage',
      normalizedForm: 'delas le clos rouge crozes-hermitage',
      entityIds: ['snapshot-delas'],
      matchConfidence: 0.99,
      lookupStrategy: 'in_memory',
    } as const;
    const aliasTableAvailableSpy = vi
      .spyOn(PgAliasMatcherAdapter, 'isAliasTableAvailable')
      .mockResolvedValue(true);
    const loadFromPostgresSpy = vi
      .spyOn(SearchSnapshotAliasMatcher, 'loadFromPostgres')
      .mockResolvedValue(undefined);
    const loadFromManifestSpy = vi
      .spyOn(SearchSnapshotAliasMatcher, 'loadFromManifest')
      .mockResolvedValue({
        findMatches: (query: string) => Promise.resolve(query === exactQuery ? [exactMatch] : []),
        findMatchesBatch: (queries: readonly string[]) => Promise.resolve(new Map(
          queries.map((query) => [query, query === exactQuery ? [exactMatch] : []] as const),
        )),
        getSurfaceForms: () => ['Delas Le Clos Rouge Crozes-Hermitage'],
      } as SearchSnapshotAliasMatcher);
    const sparseSearchSpy = vi
      .spyOn(VespaSearchIndex.prototype, 'sparseSearch')
      .mockResolvedValue([] satisfies readonly SparseHit[]);

    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });
    const fakePool = { query: vi.fn() } as never;

    try {
      const adapters = await buildCoreAdapterServices(config, {
        pool: fakePool,
        searchSnapshotId: 'search-snapshot:v1:target',
        searchSnapshotManifestPath: '/tmp/search-snapshot:v1:target/manifest.json',
      });
      expect(aliasTableAvailableSpy).toHaveBeenCalledWith(fakePool, {
        queryTimeoutMs: 1500,
      });
      expect(loadFromPostgresSpy).toHaveBeenCalledWith(
        fakePool,
        'search-snapshot:v1:target',
        {
          queryTimeoutMs: 1500,
        },
      );
      expect(loadFromManifestSpy).toHaveBeenCalledWith('/tmp/search-snapshot:v1:target/manifest.json');
      expect(await adapters.aliasMatcher.findMatches(exactQuery)).toEqual([exactMatch]);
      expect(await adapters.aliasMatcher.findMatches('missing snapshot alias')).toEqual([]);
      expect(sparseSearchSpy).not.toHaveBeenCalled();
    } finally {
      aliasTableAvailableSpy.mockRestore();
      loadFromPostgresSpy.mockRestore();
      loadFromManifestSpy.mockRestore();
      sparseSearchSpy.mockRestore();
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
      expect(aliasTableAvailableSpy).toHaveBeenCalledWith(fakePool, {
        queryTimeoutMs: 1500,
      });
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

  it('scopes PostgreSQL alias preload to the explicit snapshot override', async () => {
    const exactQuery = '2017 delas le clos rouge crozes-hermitage';
    const exactMatch = {
      surfaceForm: 'Delas Le Clos Rouge Crozes-Hermitage',
      normalizedForm: 'delas le clos rouge crozes-hermitage',
      entityIds: ['snapshot-delas'],
      matchConfidence: 0.99,
      lookupStrategy: 'in_memory',
    } as const;
    const aliasTableAvailableSpy = vi
      .spyOn(PgAliasMatcherAdapter, 'isAliasTableAvailable')
      .mockResolvedValue(true);
    const loadFromPostgresSpy = vi
      .spyOn(SearchSnapshotAliasMatcher, 'loadFromPostgres')
      .mockResolvedValue({
        findMatches: (query: string) => Promise.resolve(query === exactQuery ? [exactMatch] : []),
        findMatchesBatch: (queries: readonly string[]) => Promise.resolve(new Map(
          queries.map((query) => [query, query === exactQuery ? [exactMatch] : []] as const),
        )),
        getSurfaceForms: () => ['Delas Le Clos Rouge Crozes-Hermitage'],
      } as SearchSnapshotAliasMatcher);
    const sparseSearchSpy = vi
      .spyOn(VespaSearchIndex.prototype, 'sparseSearch')
      .mockResolvedValue([] satisfies readonly SparseHit[]);

    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });
    const fakePool = { query: vi.fn() } as never;

    try {
      const adapters = await buildCoreAdapterServices(config, {
        pool: fakePool,
        searchSnapshotId: 'search-snapshot:v1:target',
      });
      expect(adapters.fuzzyMatcher).toBeDefined();
      expect(aliasTableAvailableSpy).toHaveBeenCalledWith(fakePool, {
        queryTimeoutMs: 1500,
      });
      expect(loadFromPostgresSpy).toHaveBeenCalledWith(
        fakePool,
        'search-snapshot:v1:target',
        {
          queryTimeoutMs: 1500,
        },
      );
      expect(await adapters.aliasMatcher.findMatches(exactQuery)).toEqual([exactMatch]);
      expect(await adapters.aliasMatcher.findMatches('missing snapshot alias')).toEqual([]);
      expect(sparseSearchSpy).not.toHaveBeenCalled();
    } finally {
      aliasTableAvailableSpy.mockRestore();
      loadFromPostgresSpy.mockRestore();
      sparseSearchSpy.mockRestore();
    }
  });
});

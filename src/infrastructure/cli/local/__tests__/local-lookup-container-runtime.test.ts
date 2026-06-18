import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalLookupContainerRuntime } from '../local-lookup-container-runtime.js';
import * as envModule from '../../../../config/env.js';
import * as containerLookupModule from '../../../../config/container-lookup.js';
import * as runtimeHandlesModule from '../../../../config/runtime-handles.js';
import * as readinessModule from '../../../../infrastructure/health/search-snapshot-readiness.js';
import * as redisModule from '../../../db/redis-client.js';
import * as pgPoolModule from '../../../db/pg-pool.js';

describe('LocalLookupContainerRuntime', () => {
  beforeEach(() => {
    vi.spyOn(envModule, 'loadConfig').mockReturnValue({
      pg: {},
      redis: {},
    } as never);
    vi.spyOn(pgPoolModule, 'shouldUsePgPool').mockReturnValue(false);
    vi.spyOn(runtimeHandlesModule, 'bindLiveSearchSnapshotRuntimeHandles').mockImplementation(async (runtime) => runtime);
    vi.spyOn(redisModule, 'connectRedisClient').mockResolvedValue(undefined as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('reuses the cached direct lookup container for the same active snapshot', async () => {
    vi.spyOn(readinessModule, 'loadSearchSnapshotRuntimeState').mockResolvedValue({
      schemaVersion: 'search_snapshot_runtime_state.v7',
      snapshotId: 'search-snapshot:v1:alpha',
      manifestPath: '/tmp/alpha-manifest.json',
      fieldAvailability: {},
      lookupAliasRuntimePath: '/tmp/lookup-alias-runtime.json',
      lookupExactSafeRuntimePath: '/tmp/lookup-exact-safe-runtime.json',
      lookupResolverProjectionPath: '/tmp/lookup-resolver-projection.json',
      lookupEntityProjectionPath: '/tmp/lookup-entity-projection.json',
      lookupAmbiguityRuntimePath: '/tmp/lookup-ambiguity-runtime.json',
      lookupConceptRedirectRuntimePath: '/tmp/lookup-concept-redirect-runtime.json',
      counts: {
        lookupAliasRuntimeAliases: 1,
        lookupExactSafeRuntimeEntries: 1,
        lookupResolverProjectionDocuments: 1,
        lookupEntityProjectionDocuments: 1,
        lookupAmbiguityRuntimeEntries: 1,
        lookupConceptRedirectRuntimeEntries: 1,
      },
      hashes: {
        lookupAliasRuntime: 'h1',
        lookupExactSafeRuntime: 'h2',
        lookupResolverProjection: 'h3',
        lookupEntityProjection: 'h4',
        lookupAmbiguityRuntime: 'h5',
        lookupConceptRedirectRuntime: 'h6',
      },
    } as never);

    const close = vi.fn(async () => {});
    vi.spyOn(runtimeHandlesModule, 'createManagedRuntimeHandles').mockImplementation((runtime) => ({
      ...runtime,
      close,
    }));
    const container = { entityLookupV2UseCase: { execute: vi.fn() } };
    const createContainerSpy = vi
      .spyOn(containerLookupModule, 'createLookupDirectContainer')
      .mockResolvedValue(container as never);

    const runtime = new LocalLookupContainerRuntime({});
    try {
      const first = await runtime.withContainer(async (value) => value);
      const second = await runtime.withContainer(async (value) => value);

      expect(first).toBe(container);
      expect(second).toBe(container);
      expect(createContainerSpy).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('swaps the cached container only when the active snapshot changes', async () => {
    const snapshotStates = [
      {
        schemaVersion: 'search_snapshot_runtime_state.v7',
        snapshotId: 'search-snapshot:v1:alpha',
        manifestPath: '/tmp/alpha-manifest.json',
      },
      {
        schemaVersion: 'search_snapshot_runtime_state.v7',
        snapshotId: 'search-snapshot:v1:beta',
        manifestPath: '/tmp/beta-manifest.json',
      },
      {
        schemaVersion: 'search_snapshot_runtime_state.v7',
        snapshotId: 'search-snapshot:v1:beta',
        manifestPath: '/tmp/beta-manifest.json',
      },
    ].map((state) => ({
      ...state,
      fieldAvailability: {},
      lookupAliasRuntimePath: '/tmp/lookup-alias-runtime.json',
      lookupExactSafeRuntimePath: '/tmp/lookup-exact-safe-runtime.json',
      lookupResolverProjectionPath: '/tmp/lookup-resolver-projection.json',
      lookupEntityProjectionPath: '/tmp/lookup-entity-projection.json',
      lookupAmbiguityRuntimePath: '/tmp/lookup-ambiguity-runtime.json',
      lookupConceptRedirectRuntimePath: '/tmp/lookup-concept-redirect-runtime.json',
      counts: {
        lookupAliasRuntimeAliases: 1,
        lookupExactSafeRuntimeEntries: 1,
        lookupResolverProjectionDocuments: 1,
        lookupEntityProjectionDocuments: 1,
        lookupAmbiguityRuntimeEntries: 1,
        lookupConceptRedirectRuntimeEntries: 1,
      },
      hashes: {
        lookupAliasRuntime: 'h1',
        lookupExactSafeRuntime: 'h2',
        lookupResolverProjection: 'h3',
        lookupEntityProjection: 'h4',
        lookupAmbiguityRuntime: 'h5',
        lookupConceptRedirectRuntime: 'h6',
      },
    }));
    vi.spyOn(readinessModule, 'loadSearchSnapshotRuntimeState')
      .mockResolvedValueOnce(snapshotStates[0] as never)
      .mockResolvedValueOnce(snapshotStates[1] as never)
      .mockResolvedValueOnce(snapshotStates[2] as never);

    const firstClose = vi.fn(async () => {});
    const secondClose = vi.fn(async () => {});
    vi.spyOn(runtimeHandlesModule, 'createManagedRuntimeHandles')
      .mockImplementationOnce((runtime) => ({ ...runtime, close: firstClose }))
      .mockImplementationOnce((runtime) => ({ ...runtime, close: secondClose }));

    const alphaContainer = { entityLookupV2UseCase: { execute: vi.fn() }, tag: 'alpha' };
    const betaContainer = { entityLookupV2UseCase: { execute: vi.fn() }, tag: 'beta' };
    const createContainerSpy = vi
      .spyOn(containerLookupModule, 'createLookupDirectContainer')
      .mockResolvedValueOnce(alphaContainer as never)
      .mockResolvedValueOnce(betaContainer as never);

    const runtime = new LocalLookupContainerRuntime({});
    try {
      const first = await runtime.withContainer(async (value) => value);
      const second = await runtime.withContainer(async (value) => value);
      const third = await runtime.withContainer(async (value) => value);

      expect(first).toBe(alphaContainer);
      expect(second).toBe(betaContainer);
      expect(third).toBe(betaContainer);
      expect(createContainerSpy).toHaveBeenCalledTimes(2);
      expect(firstClose).toHaveBeenCalledTimes(1);
      expect(secondClose).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }

    expect(secondClose).toHaveBeenCalledTimes(1);
  });

  it('preload hydrates the cached container before the first work call', async () => {
    vi.spyOn(readinessModule, 'loadSearchSnapshotRuntimeState').mockResolvedValue({
      schemaVersion: 'search_snapshot_runtime_state.v7',
      snapshotId: 'search-snapshot:v1:alpha',
      manifestPath: '/tmp/alpha-manifest.json',
      fieldAvailability: {},
      lookupAliasRuntimePath: '/tmp/lookup-alias-runtime.json',
      lookupExactSafeRuntimePath: '/tmp/lookup-exact-safe-runtime.json',
      lookupResolverProjectionPath: '/tmp/lookup-resolver-projection.json',
      lookupEntityProjectionPath: '/tmp/lookup-entity-projection.json',
      lookupAmbiguityRuntimePath: '/tmp/lookup-ambiguity-runtime.json',
      lookupConceptRedirectRuntimePath: '/tmp/lookup-concept-redirect-runtime.json',
      counts: {
        lookupAliasRuntimeAliases: 1,
        lookupExactSafeRuntimeEntries: 1,
        lookupResolverProjectionDocuments: 1,
        lookupEntityProjectionDocuments: 1,
        lookupAmbiguityRuntimeEntries: 1,
        lookupConceptRedirectRuntimeEntries: 1,
      },
      hashes: {
        lookupAliasRuntime: 'h1',
        lookupExactSafeRuntime: 'h2',
        lookupResolverProjection: 'h3',
        lookupEntityProjection: 'h4',
        lookupAmbiguityRuntime: 'h5',
        lookupConceptRedirectRuntime: 'h6',
      },
    } as never);

    const close = vi.fn(async () => {});
    vi.spyOn(runtimeHandlesModule, 'createManagedRuntimeHandles').mockImplementation((runtime) => ({
      ...runtime,
      close,
    }));
    const container = { entityLookupV2UseCase: { execute: vi.fn() } };
    const createContainerSpy = vi
      .spyOn(containerLookupModule, 'createLookupDirectContainer')
      .mockResolvedValue(container as never);

    const runtime = new LocalLookupContainerRuntime({});
    try {
      await runtime.preload();
      const resolved = await runtime.withContainer(async (value) => value);

      expect(resolved).toBe(container);
      expect(createContainerSpy).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.close();
    }

    expect(close).toHaveBeenCalledTimes(1);
  });
});

/**
 * Regression: Wave 2 feature-activation registry.
 *
 * The registry centralises SOTA feature-flag states so a single
 * pipeline_debug payload (and a single startup log line) can show
 * "which features are on / off / experiment" for this process.
 *
 * Locks:
 *  - `snapshotActivations()` returns `'on'` for an env-on feature and
 *    `'off'` when the env is unset (or explicitly disabled).
 *  - Reading the snapshot is live: mutating `process.env` between
 *    snapshot calls flips the state without a re-register.
 *  - `registerFeature(name, getter)` is idempotent — re-registering
 *    the same name OVERWRITES (last-write-wins). Pinned semantics so
 *    test bootstraps don't crash on double-registration.
 *  - A newly-registered feature shows up in subsequent snapshots.
 *
 * Append-only per CLAUDE.md regression-test discipline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerFeature,
  snapshotActivations,
  __resetFeatureActivationRegistryForTests,
} from '../../src/domain/observability/feature-activation-registry.js';

const ENV_KEYS = [
  'WINE_SEARCH_MULTI_QUERY_ENABLED',
  'WINE_SEARCH_TOOL_CACHE_ENABLED',
  'WINE_SEARCH_DISABLED_TOOLS',
  'WINE_SEARCH_REASONING_HEADROOM_TOKENS',
  'WINE_SEARCH_REASONING_EFFORT',
  'VESPA_BULK_HYDRATION_TIMEOUT_MS',
  'VESPA_BULK_HYDRATION_BATCH_SIZE',
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) {
  originalEnv[key] = process.env[key];
}

/**
 * Re-import the registry module so the module-load
 * `registerFeature(...)` calls re-execute against a clean Map.
 *
 * Without this the registry would already be populated by the test
 * harness's first import of any module that transitively pulls in
 * `feature-activation-registry.ts` (e.g. `request-pipeline-debug.ts`).
 *
 * We use `vi.resetModules()` instead of a cache-busting query string
 * because Vite forbids variable dynamic imports.
 */
async function loadRegistryWithFreshDefaults(): Promise<typeof import('../../src/domain/observability/feature-activation-registry.js')> {
  __resetFeatureActivationRegistryForTests();
  vi.resetModules();
  return import('../../src/domain/observability/feature-activation-registry.js');
}

/**
 * Surgical delete helper. Avoids the dynamic-delete lint by routing
 * through a single typed key. The cast is safe — the env keys come
 * from the readonly `ENV_KEYS` tuple defined above.
 */
function clearEnvKey(key: string): void {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- env cleanup uses a known fixed key set
  delete (process.env as Record<string, string | undefined>)[key];
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    clearEnvKey(key);
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prior = originalEnv[key];
    if (prior === undefined) {
      clearEnvKey(key);
    } else {
      process.env[key] = prior;
    }
  }
  __resetFeatureActivationRegistryForTests();
});

describe('feature-activation-registry — env-driven state', () => {
  it('default env → multi_query_rewrite reports `on` (Wave 2 default flip)', async () => {
    const mod = await loadRegistryWithFreshDefaults();
    const snap = mod.snapshotActivations();
    expect(snap['multi_query_rewrite']).toBe('on');
  });

  it('`WINE_SEARCH_MULTI_QUERY_ENABLED=false` → multi_query_rewrite reports `off`', async () => {
    process.env['WINE_SEARCH_MULTI_QUERY_ENABLED'] = 'false';
    const mod = await loadRegistryWithFreshDefaults();
    expect(mod.snapshotActivations()['multi_query_rewrite']).toBe('off');
  });

  it('`WINE_SEARCH_TOOL_CACHE_ENABLED=0` → tool_result_cache reports `off`', async () => {
    process.env['WINE_SEARCH_TOOL_CACHE_ENABLED'] = '0';
    const mod = await loadRegistryWithFreshDefaults();
    expect(mod.snapshotActivations()['tool_result_cache']).toBe('off');
  });

  it('`WINE_SEARCH_TOOL_CACHE_ENABLED` unset → tool_result_cache reports `on`', async () => {
    const mod = await loadRegistryWithFreshDefaults();
    expect(mod.snapshotActivations()['tool_result_cache']).toBe('on');
  });

  it('`WINE_SEARCH_DISABLED_TOOLS=lookup_wine` → disabled_tools_fail_closed reports `on`', async () => {
    process.env['WINE_SEARCH_DISABLED_TOOLS'] = 'lookup_wine';
    const mod = await loadRegistryWithFreshDefaults();
    expect(mod.snapshotActivations()['disabled_tools_fail_closed']).toBe('on');
  });

  it('empty `WINE_SEARCH_DISABLED_TOOLS` → disabled_tools_fail_closed reports `off`', async () => {
    process.env['WINE_SEARCH_DISABLED_TOOLS'] = '';
    const mod = await loadRegistryWithFreshDefaults();
    expect(mod.snapshotActivations()['disabled_tools_fail_closed']).toBe('off');
  });

  it('numeric `WINE_SEARCH_REASONING_HEADROOM_TOKENS=4096` → reasoning_headroom override reports `on`', async () => {
    process.env['WINE_SEARCH_REASONING_HEADROOM_TOKENS'] = '4096';
    const mod = await loadRegistryWithFreshDefaults();
    expect(mod.snapshotActivations()['openai_reasoning_headroom_override']).toBe('on');
  });

  it('non-numeric `WINE_SEARCH_REASONING_HEADROOM_TOKENS=abc` → reasoning_headroom override reports `off`', async () => {
    process.env['WINE_SEARCH_REASONING_HEADROOM_TOKENS'] = 'abc';
    const mod = await loadRegistryWithFreshDefaults();
    expect(mod.snapshotActivations()['openai_reasoning_headroom_override']).toBe('off');
  });

  it('snapshot is LIVE — mutating env between calls flips the state', async () => {
    const mod = await loadRegistryWithFreshDefaults();
    expect(mod.snapshotActivations()['multi_query_rewrite']).toBe('on');

    process.env['WINE_SEARCH_MULTI_QUERY_ENABLED'] = 'false';
    expect(mod.snapshotActivations()['multi_query_rewrite']).toBe('off');

    delete process.env['WINE_SEARCH_MULTI_QUERY_ENABLED'];
    expect(mod.snapshotActivations()['multi_query_rewrite']).toBe('on');
  });
});

describe('feature-activation-registry — registerFeature() semantics', () => {
  // These tests intentionally do NOT call `loadRegistryWithFreshDefaults`
  // because `vi.resetModules()` would split the registered Map between
  // the statically-imported `registerFeature` and the dynamically-imported
  // `snapshotActivations`. Reset state via the test seam directly so both
  // helpers continue to point at the same module instance.
  it('a newly-registered feature appears in subsequent snapshots', () => {
    __resetFeatureActivationRegistryForTests();
    expect(snapshotActivations()['my_new_feature']).toBeUndefined();

    registerFeature('my_new_feature', () => 'experiment');

    expect(snapshotActivations()['my_new_feature']).toBe('experiment');
  });

  it('re-registering the same name OVERWRITES (last-write-wins)', () => {
    __resetFeatureActivationRegistryForTests();

    registerFeature('to_overwrite', () => 'on');
    expect(snapshotActivations()['to_overwrite']).toBe('on');

    // Last write wins — the new getter replaces the prior entry.
    registerFeature('to_overwrite', () => 'off');
    expect(snapshotActivations()['to_overwrite']).toBe('off');

    registerFeature('to_overwrite', () => 'experiment');
    expect(snapshotActivations()['to_overwrite']).toBe('experiment');
  });

  it('__resetFeatureActivationRegistryForTests() clears all registrations', () => {
    __resetFeatureActivationRegistryForTests();
    registerFeature('temp', () => 'on');
    expect(snapshotActivations()['temp']).toBe('on');

    __resetFeatureActivationRegistryForTests();
    expect(snapshotActivations()['temp']).toBeUndefined();
    // And no leftover module-load features either after a reset.
    expect(snapshotActivations()['multi_query_rewrite']).toBeUndefined();
  });
});

/**
 * Regression: Wave 2 — WINE_SEARCH_MULTI_QUERY_ENABLED default flip.
 *
 * Prior to Wave 2, `WINE_SEARCH_MULTI_QUERY_ENABLED` defaulted OFF and
 * required `=true` to opt in. Wave 2 inverts the polarity:
 *   - default (unset / any non-'false' value) → ENABLED
 *   - explicit `=false` → DISABLED
 *
 * Locks (mirrored against the feature-activation registry, which is
 * the single observable surface for the flag's state):
 *  - Default env → multi_query_rewrite reports `'on'`
 *  - `WINE_SEARCH_MULTI_QUERY_ENABLED=false` → `'off'`
 *  - `WINE_SEARCH_MULTI_QUERY_ENABLED=anything-else` (typo, 'true',
 *    empty string, garbage) → `'on'`
 *
 * Append-only per CLAUDE.md regression-test discipline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetFeatureActivationRegistryForTests,
} from '../../src/domain/observability/feature-activation-registry.js';

const FLAG = 'WINE_SEARCH_MULTI_QUERY_ENABLED';
const originalValue = process.env[FLAG];

/**
 * Re-import the registry module so its module-load `registerFeature(...)`
 * calls re-execute and pick up the current `process.env` state. We use
 * `vi.resetModules()` (rather than a cache-busting query string, which
 * Vite forbids for variable dynamic imports) so the module load runs
 * fresh against the just-mutated env.
 */
async function freshRegistry(): Promise<typeof import('../../src/domain/observability/feature-activation-registry.js')> {
  __resetFeatureActivationRegistryForTests();
  vi.resetModules();
  return import('../../src/domain/observability/feature-activation-registry.js');
}

/** Avoid the dynamic-delete lint while still cleaning the single env key. */
function clearFlag(): void {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- single fixed key
  delete (process.env as Record<string, string | undefined>)[FLAG];
}

beforeEach(() => {
  clearFlag();
});

afterEach(() => {
  if (originalValue === undefined) {
    clearFlag();
  } else {
    process.env[FLAG] = originalValue;
  }
  __resetFeatureActivationRegistryForTests();
});

describe('multi-query default-on flag semantics (Wave 2)', () => {
  it('default env (unset) → multi_query_rewrite reports `on`', async () => {
    const mod = await freshRegistry();
    expect(mod.snapshotActivations()['multi_query_rewrite']).toBe('on');
  });

  it('`WINE_SEARCH_MULTI_QUERY_ENABLED=false` → multi_query_rewrite reports `off`', async () => {
    process.env[FLAG] = 'false';
    const mod = await freshRegistry();
    expect(mod.snapshotActivations()['multi_query_rewrite']).toBe('off');
  });

  it('`WINE_SEARCH_MULTI_QUERY_ENABLED=true` → multi_query_rewrite reports `on`', async () => {
    // The explicit 'true' value continues to enable, but is no longer
    // required — the default is already on.
    process.env[FLAG] = 'true';
    const mod = await freshRegistry();
    expect(mod.snapshotActivations()['multi_query_rewrite']).toBe('on');
  });

  it('`WINE_SEARCH_MULTI_QUERY_ENABLED=garbage` (typo / unrecognised) → multi_query_rewrite reports `on`', async () => {
    // Typos in the env value must NOT silently disable a feature
    // whose Wave 2 default is ON — operators have to be explicit
    // with `=false` to opt out.
    process.env[FLAG] = 'enable';
    const mod = await freshRegistry();
    expect(mod.snapshotActivations()['multi_query_rewrite']).toBe('on');
  });

  it('`WINE_SEARCH_MULTI_QUERY_ENABLED=` (empty string) → multi_query_rewrite reports `on`', async () => {
    process.env[FLAG] = '';
    const mod = await freshRegistry();
    expect(mod.snapshotActivations()['multi_query_rewrite']).toBe('on');
  });

  it('`WINE_SEARCH_MULTI_QUERY_ENABLED=False` (case-sensitive) → reports `on` (only lowercase `false` disables)', async () => {
    // The env reads compare against the exact string 'false'. Operators
    // who mean to disable must use lowercase — this matches the rest
    // of the repo's env-flag conventions (no `String#toLowerCase()`
    // normalization for boolean flags).
    process.env[FLAG] = 'False';
    const mod = await freshRegistry();
    expect(mod.snapshotActivations()['multi_query_rewrite']).toBe('on');
  });
});

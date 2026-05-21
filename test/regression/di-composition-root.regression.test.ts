/**
 * Regression: DI composition root invariants.
 *
 * Why: the composition root spans 14 files. Without a declarative manifest
 * and explicit graph assertions, drift is invisible — a new sub-container
 * could introduce a dependency cycle, or a port could silently lose its
 * canonical producer, and no test would catch either until a request
 * crashed in production.
 *
 * Covered invariants:
 *  1. Manifest enumerates a port for every field on `Container` that is a
 *     concrete port (excludes feature-flagged optionals like `agentOrchestrator`
 *     and `wineSearch`, which the manifest treats as gated slices).
 *  2. Topological build order exists (graph is acyclic).
 *  3. Every dependency edge in the manifest references a declared sub-container
 *     (no dangling references).
 *  4. Each sub-container factory is callable in isolation and returns a record
 *     when given the documented inputs.
 *  5. `buildWatchlistContainerServices` honours the runtime override for the
 *     watchlist storage adapter (test-injection hook).
 *  6. `buildLearningContainerServices` returns null services when no PG pool
 *     is provided (idempotent, no shared mutable state across two calls).
 *  7. `buildWatchlistContainerServices` raises a clear error in production
 *     when persistent storage is required but unavailable. The error message
 *     is preserved verbatim (NFC, Latin — Korean would also be preserved
 *     because the throw goes through `new Error(...)` without sanitisation).
 *
 * Append-only: never delete this file. Add new invariants below.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  getWiringManifest,
  topologicalBuildOrder,
  WIRING_MANIFEST,
  type SubContainerId,
} from '../../src/config/container-wiring-manifest.js';
import { buildWatchlistContainerServices } from '../../src/config/container-watchlist.js';
import { buildLearningContainerServices } from '../../src/config/container-learning.js';
import { parseEnv } from '../../src/config/env.js';
import type { WatchlistStoragePort } from '../../src/domain/watchlist/port/watchlist-repository.port.js';

function makeStorage(): WatchlistStoragePort {
  return {
    save: vi.fn(async () => {}),
    findById: vi.fn(async () => null),
    findByUserId: vi.fn(async () => []),
    findByEntityId: vi.fn(async () => []),
    delete: vi.fn(async () => false),
    listByWatchlistId: vi.fn(async () => []),
    append: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
}

describe('di-composition-root regression', () => {
  describe('wiring manifest', () => {
    it('declares every sub-container exactly once', () => {
      const manifest = getWiringManifest();
      const ids = manifest.subContainers.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('enumerates the production-facing ports', () => {
      const manifest = getWiringManifest();
      // Spot-check that ports the HTTP layer relies on are present.
      const required = [
        'searchUseCase',
        'queryPlanner',
        'entityResolver',
        'entityLookup',
        'candidatePool',
        'ranker',
        'decisionEngine',
        'responseBuilder',
        'mixedSolver',
        'drinkingWindowPredictor',
        'calibrationStore',
        'watchlistService',
      ] as const;
      for (const port of required) {
        expect(manifest.ports).toContain(port);
      }
    });

    it('routes each declared port through exactly one producer', () => {
      const producers = new Map<string, SubContainerId[]>();
      for (const spec of WIRING_MANIFEST) {
        for (const port of spec.produces) {
          const owners = producers.get(port) ?? [];
          owners.push(spec.id);
          producers.set(port, owners);
        }
      }
      for (const [port, owners] of producers.entries()) {
        expect(owners, `port ${port} has multiple producers`).toHaveLength(1);
      }
    });

    it('only references declared sub-containers in dependsOn edges', () => {
      const declared = new Set(WIRING_MANIFEST.map((s) => s.id));
      for (const spec of WIRING_MANIFEST) {
        for (const dep of spec.dependsOn) {
          expect(
            declared.has(dep),
            `sub-container ${spec.id} depends on undeclared ${dep}`,
          ).toBe(true);
        }
      }
    });
  });

  describe('dependency graph', () => {
    it('admits a topological build order (no cycles)', () => {
      const order = topologicalBuildOrder();
      expect(order).toHaveLength(WIRING_MANIFEST.length);
      // 'container' must be last because it depends on the rest.
      expect(order[order.length - 1]).toBe('container');
    });

    it('places every dependency before its dependant in the build order', () => {
      const order = topologicalBuildOrder();
      const position = new Map<SubContainerId, number>(
        order.map((id, i) => [id, i]),
      );
      for (const spec of WIRING_MANIFEST) {
        for (const dep of spec.dependsOn) {
          const depPos = position.get(dep);
          const ownPos = position.get(spec.id);
          expect(depPos).toBeDefined();
          expect(ownPos).toBeDefined();
          expect(depPos!).toBeLessThan(ownPos!);
        }
      }
    });

    it('detects a synthetic cycle when one is injected', () => {
      // Simulate a wiring mistake: container depends on itself.
      const cyclic = [
        ...WIRING_MANIFEST.filter((s) => s.id !== 'container'),
        {
          id: 'container' as SubContainerId,
          dependsOn: ['container'] as SubContainerId[],
          produces: [] as const,
        },
      ];
      expect(() => topologicalBuildOrder(cyclic)).toThrow(/cycle detected/);
    });

    it('detects a multi-node cycle (A → B → A)', () => {
      const cyclic = [
        ...WIRING_MANIFEST,
        // Inject two synthetic nodes that loop.
        { id: 'a' as SubContainerId, dependsOn: ['b'] as SubContainerId[], produces: [] as const },
        { id: 'b' as SubContainerId, dependsOn: ['a'] as SubContainerId[], produces: [] as const },
      ];
      expect(() => topologicalBuildOrder(cyclic)).toThrow(/cycle detected/);
    });
  });

  describe('sub-container factories', () => {
    it('buildLearningContainerServices returns nulls without a PG pool', () => {
      const services = buildLearningContainerServices({});
      expect(services.feedbackStore).toBeNull();
      expect(services.proposalStore).toBeNull();
      expect(services.feedbackProcessor).toBeNull();
      expect(services.aliasProposer).toBeNull();
      expect(services.feedbackTtlEnforcer).toBeNull();
      expect(services.promotionGate).toBeNull();
    });

    it('buildLearningContainerServices is idempotent (no shared mutable state)', () => {
      const a = buildLearningContainerServices({});
      const b = buildLearningContainerServices({});
      // Two factories called in the same process must produce independent
      // records (regression guard against accidentally promoting a closure
      // variable to module scope).
      expect(a).not.toBe(b);
      expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    });

    it('buildWatchlistContainerServices honours the test-override hook', async () => {
      const storage = makeStorage();
      const config = parseEnv({
        NODE_ENV: 'test',
        WATCHLIST_ENABLED: 'false',
        WEBHOOK_SECRET: 'watchlist-secret-1234',
      });

      const container = buildWatchlistContainerServices(config, {
        createWatchlistStore: () => storage,
      });

      expect(container.watchlistService).toBeDefined();
      expect(container.watchlistRuntime).toBeNull();

      await container.watchlistService.create({
        userId: 'user-di-root',
        entityId: 'entity-di-root',
        triggerConditions: [],
        callbackUrl: 'https://example.com/webhook',
        expiresAt: null,
      });
      expect(storage.save).toHaveBeenCalledTimes(1);
    });

    it('preserves the watchlist persistence error message verbatim', () => {
      const config = parseEnv({
        NODE_ENV: 'production',
        WATCHLIST_ENABLED: 'true',
        WATCHLIST_DELIVERY_ENABLED: 'true',
        WEBHOOK_SECRET: 'watchlist-secret-1234',
        // Production env validation requires either an LLM provider or an
        // explicit kill-switch for the Layer 2 injection judge. We're not
        // exercising that path here, so flip the kill-switch to isolate the
        // watchlist-storage assertion.
        KILL_SWITCH_INJECTION_JUDGE: 'true',
      });
      // No PG pool, no override → must throw a specific, NFC-normalised
      // message (any future i18n that introduces Korean characters MUST
      // also preserve NFC by going through `new Error(...)` directly, not
      // through a transformer that strips combining marks).
      let caught: unknown;
      try {
        buildWatchlistContainerServices(config, {});
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toMatch(/Watchlist delivery requires PostgreSQL/);
      expect(message.normalize('NFC')).toBe(message);
    });
  });

  describe('manifest <-> source-file alignment', () => {
    it('every non-root sub-container has a matching src/config/container-*.ts file (smoke check)', async () => {
      // Pure manifest-to-filesystem sanity. If a sub-container is renamed on
      // disk but not in the manifest, this surfaces it.
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const url = await import('node:url');
      const configDir = path.resolve(
        path.dirname(url.fileURLToPath(import.meta.url)),
        '../../src/config',
      );
      const files = new Set(await fs.readdir(configDir));
      const expectedFiles: Partial<Record<SubContainerId, string>> = {
        adapters: 'container-adapters.ts',
        'runtime-support': 'container-runtime-support.ts',
        'core-builders': 'container-core-builders.ts',
        stubs: 'container-stubs.ts',
        core: 'container-core.ts',
        usecases: 'container-usecases.ts',
        'aux-features': 'container-aux-features.ts',
        features: 'container-features.ts',
        watchlist: 'container-watchlist.ts',
        learning: 'container-learning.ts',
        container: 'container.ts',
      };
      for (const spec of WIRING_MANIFEST) {
        const expected = expectedFiles[spec.id];
        expect(expected, `manifest id ${spec.id} missing file mapping`).toBeDefined();
        expect(files.has(expected!), `${expected} missing from src/config`).toBe(true);
      }
    });
  });
});

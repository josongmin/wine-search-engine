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
 *  4. Every non-root manifest node still has a matching src/config/container-*.ts file.
 *
 * Append-only: never delete this file. Add new invariants below.
 */

import { describe, expect, it } from 'vitest';
import {
  getWiringManifest,
  topologicalBuildOrder,
  WIRING_MANIFEST,
  type SubContainerId,
} from '../../src/config/container-wiring-manifest.js';

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

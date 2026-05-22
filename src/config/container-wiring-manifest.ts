/**
 * Composition-root wiring manifest (SSoT for the DI graph shape).
 *
 * Why a static manifest instead of reflection over the live `Container`?
 *  - The runtime container is built from heavy async I/O (Vespa client, PG,
 *    Redis, embedding adapter). Reflecting on the live object would require
 *    booting the whole stack inside a unit test.
 *  - A declarative manifest lets the regression suite assert two invariants
 *    cheaply: (1) every port surfaced by `Container` is owned by exactly one
 *    sub-container factory, (2) the inter-factory dependency graph is a DAG
 *    (no cycles). Both invariants would otherwise rot silently as new
 *    services are wired.
 *
 * Append-only contract: when you add a sub-container or a new port, extend
 * this manifest in the same change set. The regression test under
 * `test/regression/di-composition-root.regression.test.ts` will fail until
 * the manifest is updated, surfacing the wiring drift at PR review time.
 */

/**
 * Stable identifiers for each composition-root sub-container.
 * Naming mirrors the file names under `src/config/` for greppability.
 */
export type SubContainerId =
  | 'adapters'
  | 'runtime-support'
  | 'core-builders'
  | 'stubs'
  | 'core'
  | 'usecases'
  | 'aux-features'
  | 'features'
  | 'watchlist'
  | 'learning'
  | 'container';

/** Ports surfaced on the root `Container` type. Keep alphabetised. */
export type ContainerPortId =
  | 'adaptiveToolExecutor'
  | 'autocompleteUseCase'
  | 'batchSearchUseCase'
  | 'calibrationStore'
  | 'candidatePool'
  | 'chatLlm'
  | 'decisionEngine'
  | 'decomposedSearchUseCase'
  | 'drinkingWindowPredictor'
  | 'drinkingWindowUseCase'
  | 'entityLookup'
  | 'entityResolver'
  | 'evalRunner'
  | 'feedbackIngestEnabled'
  | 'hybridUseCase'
  | 'interpretUseCase'
  | 'mixedSolver'
  | 'queryPlanner'
  | 'ranker'
  | 'replayUseCase'
  | 'resolveUseCase'
  | 'responseBuilder'
  | 'runtimeReadiness'
  | 'searchUseCase'
  | 'watchlistRuntime'
  | 'watchlistService';

interface SubContainerSpec {
  readonly id: SubContainerId;
  /** Sub-containers whose output is consumed as a constructor input. */
  readonly dependsOn: readonly SubContainerId[];
  /** Ports this sub-container is the canonical producer of, if any. */
  readonly produces: readonly ContainerPortId[];
}

/**
 * The composition-root graph as built by `createContainer` in container.ts.
 * Read top-to-bottom for boot order.
 */
export const WIRING_MANIFEST: readonly SubContainerSpec[] = [
  // Leaf sub-containers: depend only on config / runtime handles.
  { id: 'adapters', dependsOn: [], produces: [] },
  { id: 'runtime-support', dependsOn: [], produces: [] },
  { id: 'core-builders', dependsOn: [], produces: [] },
  { id: 'stubs', dependsOn: [], produces: [] },

  // Core: aggregates adapters + runtime-support + core-builders + stubs.
  {
    id: 'core',
    dependsOn: ['adapters', 'runtime-support', 'core-builders', 'stubs'],
    produces: [
      'queryPlanner',
      'entityResolver',
      'entityLookup',
      'candidatePool',
      'ranker',
      'decisionEngine',
      'responseBuilder',
      'mixedSolver',
      'chatLlm',
      'drinkingWindowPredictor',
      'calibrationStore',
      'runtimeReadiness',
    ],
  },

  // Use cases consume the core ports and expose application-layer surfaces.
  {
    id: 'usecases',
    dependsOn: ['core'],
    produces: [
      'searchUseCase',
      'replayUseCase',
      'interpretUseCase',
      'resolveUseCase',
      'autocompleteUseCase',
      'hybridUseCase',
      'decomposedSearchUseCase',
      'drinkingWindowUseCase',
      'batchSearchUseCase',
    ],
  },

  // Aux features (eval runner, adaptive tool executor) layer on top of use cases.
  {
    id: 'aux-features',
    dependsOn: ['usecases'],
    produces: ['adaptiveToolExecutor', 'evalRunner'],
  },

  // Features bundle exposes everything the route layer consumes.
  {
    id: 'features',
    dependsOn: ['core', 'usecases', 'aux-features'],
    produces: [],
  },

  // Watchlist + learning are independent slices wired directly into the root.
  {
    id: 'watchlist',
    dependsOn: [],
    produces: ['watchlistService', 'watchlistRuntime'],
  },
  {
    id: 'learning',
    dependsOn: [],
    produces: ['feedbackIngestEnabled'],
  },

  // Root composition.
  {
    id: 'container',
    dependsOn: ['core', 'features', 'watchlist', 'learning'],
    produces: [],
  },
] as const;

interface WiringManifest {
  readonly subContainers: readonly SubContainerSpec[];
  readonly ports: readonly ContainerPortId[];
}

/** Return the full manifest (subcontainers + the ports they collectively produce). */
export function getWiringManifest(): WiringManifest {
  const ports = new Set<ContainerPortId>();
  for (const spec of WIRING_MANIFEST) {
    for (const port of spec.produces) {
      ports.add(port);
    }
  }
  return {
    subContainers: WIRING_MANIFEST,
    ports: Array.from(ports).sort(),
  };
}

/**
 * Kahn's algorithm topological sort over the manifest. Returns a build order
 * if the graph is acyclic; throws with the offending nodes otherwise.
 *
 * Used by the regression test to prove that the declared composition order
 * cannot deadlock at boot. Implemented inline (no external dependency) so
 * the manifest itself is self-validating.
 */
export function topologicalBuildOrder(
  manifest: readonly SubContainerSpec[] = WIRING_MANIFEST,
): readonly SubContainerId[] {
  const indegree = new Map<SubContainerId, number>();
  const adjacency = new Map<SubContainerId, SubContainerId[]>();
  for (const spec of manifest) {
    indegree.set(spec.id, indegree.get(spec.id) ?? 0);
    adjacency.set(spec.id, adjacency.get(spec.id) ?? []);
    for (const dep of spec.dependsOn) {
      indegree.set(spec.id, (indegree.get(spec.id) ?? 0) + 1);
      const adj = adjacency.get(dep) ?? [];
      adj.push(spec.id);
      adjacency.set(dep, adj);
    }
  }

  const queue: SubContainerId[] = [];
  for (const [id, degree] of indegree.entries()) {
    if (degree === 0) {
      queue.push(id);
    }
  }
  // Sort the seed queue for deterministic output (Kahn doesn't constrain it).
  queue.sort();

  const order: SubContainerId[] = [];
  while (queue.length > 0) {
    const next = queue.shift() as SubContainerId;
    order.push(next);
    const neighbours = (adjacency.get(next) ?? []).slice().sort();
    for (const n of neighbours) {
      const remaining = (indegree.get(n) ?? 0) - 1;
      indegree.set(n, remaining);
      if (remaining === 0) {
        queue.push(n);
      }
    }
  }

  if (order.length !== manifest.length) {
    const visited = new Set(order);
    const cyclic = manifest
      .map((spec) => spec.id)
      .filter((id) => !visited.has(id));
    throw new Error(
      `[wiring-manifest] dependency cycle detected — unresolved sub-containers: ${cyclic.join(', ')}`,
    );
  }

  return order;
}

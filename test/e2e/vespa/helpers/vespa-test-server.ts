/**
 * Vespa-backed E2E test server factory.
 *
 * Creates a real Fastify server wired with a live Vespa instance.
 * All other adapters (aliases, thresholds, calibration) use in-memory stubs.
 *
 * Mirrors the shape of test/e2e/helpers/test-server.ts but substitutes
 * VespaSearchIndex for InMemorySearchIndex.
 */

import type { FastifyInstance } from 'fastify';
import { createServer } from '../../../../src/interface/http/server.js';
import {
  createVespaTestContainer,
  type VespaTestContainerParts,
  type VespaTestContainerOptions,
} from './vespa-test-container.js';

export interface VespaTestServer {
  readonly app: FastifyInstance;
  readonly parts: VespaTestContainerParts;
}

/**
 * Creates and initializes a Fastify server backed by real Vespa.
 *
 * Alias fixtures must be loaded by the caller after construction because the
 * set of aliases is test-specific — unlike the in-memory E2E server which
 * always pre-loads the same fixture set.
 *
 * @returns An initialized Fastify instance and the container parts for
 *          direct access to the VespaClient / aliasMatcher in tests.
 */
export async function createVespaTestServer(
  options: VespaTestContainerOptions = {},
): Promise<VespaTestServer> {
  const parts = await createVespaTestContainer(options);

  const app = await createServer(parts.container, {
    logLevel: 'silent',
    nodeEnv: 'test',
  });
  await app.ready();

  return { app, parts };
}

/**
 * Tears down the Vespa test server.
 */
export async function closeVespaTestServer(server: VespaTestServer): Promise<void> {
  await server.app.close();
  await server.parts.close();
}

/**
 * E2E test server factory.
 *
 * Creates a real Fastify server wired with in-memory adapters.
 * Uses Fastify's inject() API to avoid binding to a real port.
 */

import type { FastifyInstance } from 'fastify';
import { createServer } from '../../../src/interface/http/server.js';
import { createTestContainer } from '../../integration/helpers/test-container.js';
import {
  TEST_ALIASES,
  TEST_DOCUMENTS,
} from '../../integration/helpers/test-fixtures.js';

export interface TestServer {
  readonly app: FastifyInstance;
}

/**
 * Creates and initializes a Fastify test server backed by in-memory adapters.
 *
 * Loads the 10 test fixtures (aliases + documents) automatically.
 * Returns the Fastify instance for use with app.inject().
 */
export async function createTestServer(): Promise<TestServer> {
  const parts = createTestContainer();

  // Load test fixtures into in-memory adapters
  for (const alias of TEST_ALIASES) {
    parts.aliasMatcher.addAlias(alias.surfaceForm, alias.entityId, alias.confidence);
  }
  for (const doc of TEST_DOCUMENTS) {
    parts.searchIndex.upsertDoc(doc);
  }
  const uniqueIds = new Set(TEST_ALIASES.map((a) => a.entityId));
  parts.blockingAdapter.addEntityIds(Array.from(uniqueIds));

  // Mark "마고" as ambiguous for ambiguity-related tests
  parts.ambiguityDict.setAmbiguous('마고', ['region', 'entity'], 'medium');

  // createServer is now async (registers rate-limit plugin etc.)
  const app = await createServer(parts.container, { logLevel: 'silent' });

  // Initialize Fastify (registers routes, plugins, etc.)
  await app.ready();

  return { app };
}

/**
 * Closes the test server and releases resources.
 */
export async function closeTestServer(server: TestServer): Promise<void> {
  await server.app.close();
}

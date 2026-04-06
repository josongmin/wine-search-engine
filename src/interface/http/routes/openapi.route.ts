import type { FastifyInstance } from 'fastify';
import { buildHttpRouteContractOpenApiBridge } from './http-route-contract-openapi.js';

/**
 * Cached OpenAPI document. Built once on first request, then reused.
 * The document is derived from the declared route contract catalog,
 * which is static for the lifetime of the process.
 */
let cachedDocument: ReturnType<typeof buildHttpRouteContractOpenApiBridge> | undefined;

/**
 * Registers GET /openapi.json — serves the OpenAPI 3.1 specification
 * generated from declared route contracts (Zod-backed schemas).
 */
export function registerOpenApiRoute(app: FastifyInstance): void {
  app.get('/openapi.json', async (_request, reply) => {
    if (cachedDocument === undefined) {
      cachedDocument = buildHttpRouteContractOpenApiBridge();
    }

    await reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('cache-control', 'public, max-age=3600')
      .send(cachedDocument);
  });
}

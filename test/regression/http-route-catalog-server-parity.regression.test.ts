import { describe, expect, it, vi } from 'vitest';
import { createServer } from '../../src/interface/http/server.js';
import { DeclaredHttpRouteContractCatalog } from '../../src/interface/http/routes/http-route-contract-catalog.js';
import type { HttpServerDeps } from '../../src/interface/http/routes/route-deps.js';
import type { WineSearchOrchestratorContract } from '../../src/application/wine-search/wine-search-orchestrator.js';
import {
  computeAgentSessionExpiry,
  createProcessLocalAgentSessionStore,
} from '../../src/config/agent-session-store.js';
import { AgentSessionService } from '../../src/application/wine-search/agent-session-service.js';
import { AgentUseCase } from '../../src/application/wine-search/agent-usecase.js';

/**
 * Regression test (2026-05-23): every URL declared in
 * {@link DeclaredHttpRouteContractCatalog} MUST be registered with the live
 * Fastify server. The original catalog regression (`*-properties.test.ts`)
 * only checks structural invariants (no duplicate operationIds, semver shape,
 * fingerprint stability) — it does NOT verify that catalog entries map to
 * real registrations.
 *
 * Why this matters: the catalog drives the exported OpenAPI document
 * (`registerOpenApiRoute` → catalog → spec). Any entry not actually wired
 * advertises a 404 endpoint to every consumer reading the OpenAPI export.
 *
 * Found cases that motivated this test:
 *   - `/v2/search`, `/v2/search/hybrid`, `/v2/search/interpret` were declared
 *     in the catalog but `server.ts` never called a matching `register*Route`.
 *     V2 responses are actually served via content-negotiation on the
 *     corresponding `/v1/*` routes. Removed in catalog v2.0.0.
 */

function createStubDeps(): HttpServerDeps {
  const noopExecute = { execute: vi.fn() };
  const orchestrator = { execute: vi.fn() } as unknown as WineSearchOrchestratorContract;
  const agentSessionService = new AgentSessionService({
    store: createProcessLocalAgentSessionStore(),
    orchestrator,
    computeExpiry: (now) => computeAgentSessionExpiry(now),
  });
  return {
    searchUseCase: noopExecute,
    // V2 lookup surface (sole public lookup authority after the V2-only cutover)
    // + operator curation plane. Both are dep-gated in server.ts, so the parity
    // test must wire them or their catalog entries appear unregistered. Only
    // route REGISTRATION is exercised here (hasRoute), never the handlers, so
    // structural stubs suffice.
    entityLookupV2UseCase: noopExecute as never,
    curationUseCase: {} as never,
    wineSearch: {
      wineSearchOrchestrator: orchestrator,
      agentUseCase: new AgentUseCase({
        orchestrator,
        sessionService: agentSessionService,
      }),
      agentSessionService,
    },
    evalRunner: null,
  };
}

describe('observability.http-contract-catalog — server.register parity', () => {
  it('every catalog entry resolves to a registered Fastify route', async () => {
    const app = await createServer(createStubDeps(), { logLevel: 'silent', nodeEnv: 'test' });
    try {
      const missing: string[] = [];
      for (const entry of DeclaredHttpRouteContractCatalog) {
        const registered = app.hasRoute({ method: entry.method, url: entry.url });
        if (!registered) {
          missing.push(`${entry.method} ${entry.url}`);
        }
      }
      expect(
        missing,
        `${missing.length} catalog entries are not registered with the server. ` +
          `They will return 404 even though the OpenAPI export advertises them. ` +
          `Either remove them from the catalog or add the corresponding registerXxxRoute() ` +
          `call in src/interface/http/server.ts. Missing: ${missing.join(', ')}`,
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

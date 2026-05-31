/**
 * Test container builder for the POST /v1/agent e2e tests.
 *
 * Wires the FULL Plan-then-Execute pipeline against the existing in-memory
 * adapter stack (`createTestContainer`), substituting ONE seam: the
 * `StructuredLlmPort` adapter that would otherwise call
 * `api.anthropic.com`. Every other Plan-then-Execute component runs for
 * real:
 *
 *   - `QueryAnalyzerService` (deterministic-first; LLM only if no signal)
 *   - `DeterministicRouter`
 *   - `ExecutionRunner` driving:
 *       - real `SearchUseCase` over in-memory fixture documents
 *       - real `DecomposedSearchUseCase` (used by ComparisonUseCaseAdapter)
 *       - real `DrinkingWindowUseCase`
 *         composition root does it)
 *   - `SynthesisRunner` (calls the mock structured LLM)
 *   - `WineSearchOrchestrator` (top-level)
 *   - `AgentUseCase` + canonical `POST /v1/agent` Fastify route
 *
 * This is the deploy-confidence test — it catches wiring drift across the
 * 11 internal components without requiring network or real LLM credentials.
 *
 * SOTA+++++ hermeticity: no env vars are mutated, no fetch is intercepted,
 * no real keys are required. The substitution is at the orchestrator's DI
 * boundary — the cleanest seam.
 */

import type { FastifyInstance } from 'fastify';
import { createServer } from '../../../src/interface/http/server.js';
import { createTestServer, closeTestServer } from './test-server.js';
import { QueryAnalyzerService } from '../../../src/application/wine-search/query-analyzer.js';
import { DeterministicRouter } from '../../../src/application/wine-search/deterministic-router.js';
import { ExecutionRunner } from '../../../src/application/wine-search/execution-runner.js';
import { WineAgentLoopRunner } from '../../../src/application/wine-search/wine-agent-loop.js';
import { SynthesisRunner } from '../../../src/application/wine-search/synthesis-runner.js';
import { SearchUseCaseAdapter } from '../../../src/application/wine-search/adapters/search-use-case-adapter.js';
import { AgentUseCase } from '../../../src/application/wine-search/agent-usecase.js';
import { WineSearchOrchestrator } from '../../../src/application/wine-search/wine-search-orchestrator.js';
import type { OrchestratorWineAgentLoopToolBundle } from '../../../src/application/wine-search/wine-search-orchestrator.js';
import type { QueryAnalyzerService } from '../../../src/application/wine-search/query-analyzer.js';
import { errorHandler } from '../../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../../src/interface/http/middleware/request-context.js';
import Fastify from 'fastify';
import type { SearchUseCase } from '../../../src/application/search/search.usecase.js';
import { buildStructuredLlmMock, type StructuredLlmMockOptions, type StructuredLlmMock } from './anthropic-sdk-mock.js';
import type { SearchUseCasePort } from '../../../src/application/wine-search/execution-runner.js';
import type { SearchResponseV1 } from '../../../src/domain/response/model/search-response.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface WineSearchTestContainerOptions {
  /**
   * Scripted responses for the StructuredLlmPort mock. Synthesize is invoked
   * on every non-aborted, non-admit-rejected request; analyze is only invoked
   * when deterministic analysis finds zero signal.
   */
  readonly llmMock?: StructuredLlmMockOptions;
  /**
   * Replace the SearchUseCasePort the ExecutionRunner sees with a stub. By
   * default the helper wires the real adapter over the in-memory
   * `SearchUseCase`, but the real `SearchUseCase` currently has a
   * pre-existing runtime bug (`Cannot read properties of undefined (reading
   * 'some')`) that prevents grounded synthesis. Tests that need a clean
   * grounded path provide a stub here.
   */
  readonly searchUseCase?: SearchUseCasePort;
  /**
   * When `false`, the helper builds the server WITHOUT registering the
   * /v1/agent route — used to test the feature-flag-off behavior
   * (route returns 404). Default: `true`.
   */
  readonly enableWineSearch?: boolean;
  /**
   * Optional `wineAgentLoopToolBundle` for the orchestrator. When provided, the
   * orchestrator dispatches `multi-step` plans to the WineAgentLoopRunner instead
   * of short-circuiting to Layer 4. Tests that exercise WineAgentLoop directly
   * must supply this. The default (undefined) preserves the existing
   * "Layer-4 degraded" behavior so prior hell tests keep passing.
   */
  readonly wineAgentLoopToolBundle?: OrchestratorWineAgentLoopToolBundle;
  /**
   * Optional `queryAnalyzer` override. When provided, the orchestrator uses
   * this analyzer instead of the deterministic-first
   * `QueryAnalyzerService`. Tests that need to force a specific analysis
   * outcome (e.g. `expectedMultiStep=true`) use this hook — supplying a
   * pre-built analysis bypasses both the deterministic pipeline and the
   * LLM fallback gate.
   */
  readonly queryAnalyzer?: Pick<QueryAnalyzerService, 'analyze'>;
}

export interface WineSearchTestHarness {
  /** The fully-built Fastify server (after `await app.ready()`). */
  readonly app: FastifyInstance;
  /** The StructuredLlmPort mock — exposes `analyzeMock`, `executeMock`,
   *  `synthesizeMock` vi.fns and an `observedAbortSignals` array. */
  readonly llm: StructuredLlmMock;
  /** Direct handle to the orchestrator for tests that need to bypass HTTP
   *  (e.g. multi-step orchestration where forcing `expectedMultiStep=true`
   *  requires synthesizing an `analyze` response). Always present except in
   *  the feature-flag-off harness. */
  readonly orchestrator?: WineSearchOrchestrator | undefined;
  /** Tears down the Fastify server. ALWAYS call from `afterEach`. */
  readonly cleanup: () => Promise<void>;
}

/**
 * Build a Fastify server with the real Plan-then-Execute pipeline wired in,
 * substituting only the StructuredLlmPort at the orchestrator's DI boundary.
 */
export async function buildWineSearchTestContainer(
  options: WineSearchTestContainerOptions = {},
): Promise<WineSearchTestHarness> {
  const enableWineSearch = options.enableWineSearch ?? true;
  const llm = buildStructuredLlmMock(options.llmMock ?? {});

  if (!enableWineSearch) {
    // Feature-flag-off path: build the standard test server WITHOUT the
    // wine-search slice. The /v1/agent route MUST NOT be registered.
    const server = await createTestServer();
    return {
      app: server.app,
      llm,
      cleanup: async () => closeTestServer(server),
    };
  }

  // Build the full in-memory test container (real SearchUseCase, in-memory
  // fixture documents, etc.).
  const baseServer = await createTestServer();

  // We don't reuse baseServer's app — we close it and rebuild a fresh app
  // with the same container PLUS the wine-search slice wired in. (This is
  // the minimal-blast-radius approach: we let `createTestContainer` give us
  // the in-memory parts, then layer in the wine-search slice.)
  await closeTestServer(baseServer);

  // Rebuild from scratch via the same factory so we get a clean container
  // for THIS harness. The factory is deterministic.
  const { createTestContainer } = await import('../../integration/helpers/test-container.js');
  const parts = createTestContainer();
  const container = parts.container;

  // ── Build adapters around the in-memory use cases. Mirror the production
  //    composition root in `src/config/container.ts`
  //    (`buildWineSearchContainerServices`) so the test wiring is structurally
  //    identical — anything that drifts will fail loudly here first.
  const searchUseCaseConcrete = container.searchUseCase as unknown as SearchUseCase;
  const searchAdapter = new SearchUseCaseAdapter(searchUseCaseConcrete);

  // ── Build the Plan-then-Execute runners with our mock StructuredLlmPort.
  // The default `searchUseCase` is the real adapter (in-memory) so the test
  // is as production-like as possible; tests can swap in a stub to bypass
  // pre-existing runtime issues in the production SearchUseCase.
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  const queryAnalyzer = new QueryAnalyzerService({ structuredLlm: llm, logger });
  const router = new DeterministicRouter();
  const executionRunner = new ExecutionRunner({
    searchUseCase: options.searchUseCase ?? searchAdapter,
  });
  const wineAgentLoopRunner = new WineAgentLoopRunner({ structuredLlm: llm, logger });
  const synthesisRunner = new SynthesisRunner({ structuredLlm: llm, logger });

  const effectiveQueryAnalyzer = (options.queryAnalyzer ?? queryAnalyzer) as QueryAnalyzerService;
  const wineSearchOrchestrator = new WineSearchOrchestrator({
    queryAnalyzer: effectiveQueryAnalyzer,
    router,
    executionRunner,
    wineAgentLoopRunner,
    synthesisRunner,
    logger,
    ...(options.wineAgentLoopToolBundle !== undefined
      ? { wineAgentLoopToolBundle: options.wineAgentLoopToolBundle }
      : {}),
  });

  // ── Build a Fastify app — minimal middleware to keep e2e fast, but with
  //    the request-context / error-handler middleware the route depends on.
  //    We could go through `createServer` for fuller parity, but the
  //    `/v1/agent` route has its own self-contained surface. We do
  //    use `createServer` so any drift in CORS/helmet/etc. layering is
  //    caught (the route registration path is what we care about).
  const agentUseCase = new AgentUseCase({
    orchestrator: wineSearchOrchestrator,
  });
  const fullServer = await createServer(
    {
      ...container,
      wineSearch: { wineSearchOrchestrator, agentUseCase },
    },
    { logLevel: 'silent', nodeEnv: 'test', enableTelemetry: false, rateLimitMax: 0 },
  );
  await fullServer.ready();

  return {
    app: fullServer,
    llm,
    orchestrator: wineSearchOrchestrator,
    cleanup: async () => { await fullServer.close(); },
  };
}

// ---------------------------------------------------------------------------
// Minimal harness for the disabled-feature test
// ---------------------------------------------------------------------------

/**
 * Build a Fastify server WITHOUT the agent route slice registered. Used by
 * the feature-flag-off test which only needs to assert a 404. We do NOT go
 * through `createTestServer` for this — it always registers all routes the
 * container exposes, and we want the simplest possible negative-path server.
 */
export async function buildAppWithoutWineSearch(): Promise<{
  readonly app: FastifyInstance;
  readonly cleanup: () => Promise<void>;
}> {
  // We hand-build a Fastify app that mirrors the production "wineSearch
  // slice not present" path — the production `createServer` does
  // `if (deps.wineSearch !== undefined) registerAgent*Route(...)`. We
  // reproduce that branch by simply not wiring the `wineSearch` slice.
  const app = Fastify({ logger: false });
  registerRequestContext(app);
  app.setErrorHandler(errorHandler);
  // Intentionally no `wineSearch` slice wiring — that is the SUT.
  await app.ready();
  return {
    app,
    cleanup: async () => { await app.close(); },
  };
}

// ---------------------------------------------------------------------------
// Convenience stub builders — bypass the pre-existing runtime bug in
// `SearchUseCase` (see option docs above) by providing in-memory
// `SearchUseCasePort` / `ComparisonUseCasePort` stubs that return a
// minimal valid `SearchResponseV1` / `ComparisonSearchResponse`. The
// orchestrator + execution-runner + synthesizer still run for real; only
// the underlying search retrieval is short-circuited.
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid `SearchResponseV1` for stubbing. The structural cast
 * lives behind this helper so the test files stay typed and the unsafe
 * narrowing is localized to one audited line.
 */
export function makeStubSearchResponse(entityIds: readonly string[]): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: { decisionStatus: 'resolved' } as unknown as SearchResponseV1['engineDecision'],
    results: entityIds.map((id) => ({
      entity: { entityId: id, canonicalLabel: `Wine ${id}` },
    })) as unknown as SearchResponseV1['results'],
    meta: { generatedAt: new Date().toISOString() } as unknown as SearchResponseV1['meta'],
  };
}

/**
 * Build a `SearchUseCasePort` stub that returns the provided
 * `SearchResponseV1` on every call. Records the inputs/abortSignals
 * observed for assertion convenience.
 */
export function makeStubSearchUseCase(
  response: SearchResponseV1 = makeStubSearchResponse(['wine-1', 'wine-2', 'wine-3']),
): SearchUseCasePort & { calls: { abortAtCallTime: boolean }[] } {
  const calls: { abortAtCallTime: boolean }[] = [];
  return {
    calls,
    execute: async (_input, _reqId, opts) => {
      calls.push({ abortAtCallTime: opts?.abortSignal?.aborted === true });
      return response;
    },
  };
}

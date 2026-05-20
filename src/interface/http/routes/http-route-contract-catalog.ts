import type { HttpRouteContract } from './route-contracts.js';
import { AgentRouteContract } from './agent.contract.js';
import { WineSearchRouteContract } from './wine-search.contract.js';
import { AgentBenchmarkScenariosRouteContract } from './agent-benchmark-scenarios.route.js';
import {
  AgentMetricsRouteContract,
  BatchSearchRouteContract,
  ClaudeToolsExecuteRouteContract,
  ClaudeToolsListRouteContract,
  HealthRouteContract,
  HybridRouteContract,
  InterpretRouteContract,
  LookupRouteContract,
  AutocompleteRouteContract,
  ReadyRouteContract,
  ReplayRouteContract,
  ResolveRouteContract,
  RetrievalDegradationMetricsRouteContract,
  SearchRouteContract,
  WatchlistListRouteContract,
  WatchlistCreateRouteContract,
  WatchlistDeleteRouteContract,
  WatchlistDeliveriesRouteContract,
  WatchlistGetRouteContract,
  FeedbackSubmitRouteContract,
  SearchV2RouteContract,
  HybridV2RouteContract,
  InterpretV2RouteContract,
} from './route-contracts.js';
import type { HttpRouteContractManifest, RegisteredHttpRouteContract } from './register-contract-route.js';
import { toFiniteInteger } from '../../../domain/shared/utils/safe-number.js';
import {
  HTTP_SUCCESS_STATUS_MAX_EXCLUSIVE,
  HTTP_SUCCESS_STATUS_MIN,
} from '../constants.js';

interface DeclaredHttpRouteContract {
  readonly method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  readonly url: string;
  readonly contract: HttpRouteContract;
}

export const DeclaredHttpRouteContractCatalog: readonly DeclaredHttpRouteContract[] = [
  { method: 'GET', url: '/health', contract: HealthRouteContract },
  { method: 'GET', url: '/ready', contract: ReadyRouteContract },
  { method: 'GET', url: '/metrics/agent', contract: AgentMetricsRouteContract },
  { method: 'GET', url: '/metrics/retrieval-degradation', contract: RetrievalDegradationMetricsRouteContract },
  { method: 'GET', url: '/v1/claude-tools', contract: ClaudeToolsListRouteContract },
  { method: 'POST', url: '/v1/claude-tools', contract: ClaudeToolsExecuteRouteContract },
  { method: 'POST', url: '/v1/search', contract: SearchRouteContract },
  { method: 'POST', url: '/v1/search/lookup', contract: LookupRouteContract },
  { method: 'POST', url: '/v1/batch-search', contract: BatchSearchRouteContract },
  { method: 'POST', url: '/v1/search/replay', contract: ReplayRouteContract },
  { method: 'POST', url: '/v1/search/interpret', contract: InterpretRouteContract },
  { method: 'POST', url: '/v1/entity/resolve', contract: ResolveRouteContract },
  { method: 'POST', url: '/v1/entity/autocomplete', contract: AutocompleteRouteContract },
  { method: 'POST', url: '/v1/search/hybrid', contract: HybridRouteContract },
  { method: 'GET', url: '/v1/watchlist', contract: WatchlistListRouteContract },
  { method: 'POST', url: '/v1/watchlist', contract: WatchlistCreateRouteContract },
  { method: 'GET', url: '/v1/watchlist/:id', contract: WatchlistGetRouteContract },
  { method: 'DELETE', url: '/v1/watchlist/:id', contract: WatchlistDeleteRouteContract },
  { method: 'GET', url: '/v1/watchlist/:id/deliveries', contract: WatchlistDeliveriesRouteContract },
  { method: 'POST', url: '/v1/feedback', contract: FeedbackSubmitRouteContract },
  { method: 'POST', url: '/v2/search', contract: SearchV2RouteContract },
  { method: 'POST', url: '/v2/search/hybrid', contract: HybridV2RouteContract },
  { method: 'POST', url: '/v2/search/interpret', contract: InterpretV2RouteContract },
  { method: 'POST', url: '/v1/agent', contract: AgentRouteContract },
  { method: 'GET', url: '/v1/agent/benchmark-scenarios', contract: AgentBenchmarkScenariosRouteContract },
  { method: 'POST', url: '/v1/wine-search', contract: WineSearchRouteContract },
] as const;

function compareContracts(
  left: RegisteredHttpRouteContract,
  right: RegisteredHttpRouteContract,
): number {
  return left.url.localeCompare(right.url)
    || left.method.localeCompare(right.method)
    || left.operationId.localeCompare(right.operationId);
}

export function buildDeclaredHttpRouteContractManifest(): HttpRouteContractManifest {
  const routes: RegisteredHttpRouteContract[] = DeclaredHttpRouteContractCatalog.map((entry) => {
    // HTTP status codes are stringified integer keys; toFiniteInteger gives
    // a single guard point so semgrep wine-number-without-finite-guard does
    // not flag these coercions and a corrupted contract definition cannot
    // silently inject NaN into the catalog output.
    const statusCodes = Object.keys(entry.contract.responses)
      .map((statusCode) => toFiniteInteger(statusCode))
      .filter((n): n is number => n !== null)
      .sort((left, right) => left - right);
    return {
      method: entry.method,
      url: entry.url,
      operationId: entry.contract.operationId,
      hasBody: entry.contract.body !== undefined,
      hasParams: entry.contract.params !== undefined,
      responseStatusCodes: statusCodes,
      successStatusCodes: statusCodes.filter(
        (statusCode) => statusCode >= HTTP_SUCCESS_STATUS_MIN && statusCode < HTTP_SUCCESS_STATUS_MAX_EXCLUSIVE,
      ),
      errorStatusCodes: statusCodes.filter(
        (statusCode) => statusCode < HTTP_SUCCESS_STATUS_MIN || statusCode >= HTTP_SUCCESS_STATUS_MAX_EXCLUSIVE,
      ),
    };
  }).sort(compareContracts);

  return {
    version: 1,
    routes,
  };
}

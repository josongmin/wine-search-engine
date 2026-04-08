import type { HttpRouteContract } from './route-contracts.js';
import {
  BatchSearchRouteContract,
  ClaudeToolsExecuteRouteContract,
  ClaudeToolsListRouteContract,
  HealthRouteContract,
  HybridRouteContract,
  InterpretRouteContract,
  ReadyRouteContract,
  ReplayRouteContract,
  ResolveRouteContract,
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
import {
  HTTP_SUCCESS_STATUS_MAX_EXCLUSIVE,
  HTTP_SUCCESS_STATUS_MIN,
} from '../constants.js';

export interface DeclaredHttpRouteContract {
  readonly method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  readonly url: string;
  readonly contract: HttpRouteContract;
}

export const DeclaredHttpRouteContractCatalog: readonly DeclaredHttpRouteContract[] = [
  { method: 'GET', url: '/health', contract: HealthRouteContract },
  { method: 'GET', url: '/ready', contract: ReadyRouteContract },
  { method: 'GET', url: '/v1/claude-tools', contract: ClaudeToolsListRouteContract },
  { method: 'POST', url: '/v1/claude-tools', contract: ClaudeToolsExecuteRouteContract },
  { method: 'POST', url: '/v1/search', contract: SearchRouteContract },
  { method: 'POST', url: '/v1/batch-search', contract: BatchSearchRouteContract },
  { method: 'POST', url: '/v1/search/replay', contract: ReplayRouteContract },
  { method: 'POST', url: '/v1/search/interpret', contract: InterpretRouteContract },
  { method: 'POST', url: '/v1/entity/resolve', contract: ResolveRouteContract },
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
  const routes: RegisteredHttpRouteContract[] = DeclaredHttpRouteContractCatalog.map((entry) => ({
    method: entry.method,
    url: entry.url,
    operationId: entry.contract.operationId,
    hasBody: entry.contract.body !== undefined,
    hasParams: entry.contract.params !== undefined,
    responseStatusCodes: Object.keys(entry.contract.responses)
      .map((statusCode) => Number(statusCode))
      .sort((left, right) => left - right),
    successStatusCodes: Object.keys(entry.contract.responses)
      .map((statusCode) => Number(statusCode))
      .filter((statusCode) => statusCode >= HTTP_SUCCESS_STATUS_MIN && statusCode < HTTP_SUCCESS_STATUS_MAX_EXCLUSIVE)
      .sort((left, right) => left - right),
    errorStatusCodes: Object.keys(entry.contract.responses)
      .map((statusCode) => Number(statusCode))
      .filter((statusCode) => statusCode < HTTP_SUCCESS_STATUS_MIN || statusCode >= HTTP_SUCCESS_STATUS_MAX_EXCLUSIVE)
      .sort((left, right) => left - right),
  })).sort(compareContracts);

  return {
    version: 1,
    routes,
  };
}

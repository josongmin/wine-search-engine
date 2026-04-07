import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import { runWithRequestPipelineDebug } from '../../../observability/request-pipeline-debug.js';
import type { HttpRouteContract } from './route-contracts.js';

export interface RegisteredHttpRouteContract {
  readonly method: string;
  readonly url: string;
  readonly operationId: string;
  readonly hasBody: boolean;
  readonly hasParams: boolean;
  readonly responseStatusCodes: readonly number[];
  readonly successStatusCodes: readonly number[];
  readonly errorStatusCodes: readonly number[];
}

export interface HttpRouteContractManifest {
  readonly version: 1;
  readonly routes: readonly RegisteredHttpRouteContract[];
}

const routeContractRegistry = new WeakMap<
  FastifyInstance,
  RegisteredHttpRouteContract[]
>();

function ensureRouteContractStore(app: FastifyInstance): RegisteredHttpRouteContract[] {
  const existing = routeContractRegistry.get(app);
  if (existing !== undefined) {
    return existing;
  }

  const next: RegisteredHttpRouteContract[] = [];
  routeContractRegistry.set(app, next);
  return next;
}

export function registerContractRoute(
  app: FastifyInstance,
  options: {
    readonly method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
    readonly url: string;
    readonly contract: HttpRouteContract;
    readonly handler: RouteHandlerMethod;
  },
): void {
  const responseStatusCodes = Object.keys(options.contract.responses)
    .map((statusCode) => Number(statusCode))
    .sort((left, right) => left - right);
  const successStatusCodes = responseStatusCodes.filter((statusCode) => statusCode >= 200 && statusCode < 300);
  const errorStatusCodes = responseStatusCodes.filter((statusCode) => statusCode < 200 || statusCode >= 300);

  ensureRouteContractStore(app).push({
    method: options.method,
    url: options.url,
    operationId: options.contract.operationId,
    hasBody: options.contract.body !== undefined,
    hasParams: options.contract.params !== undefined,
    responseStatusCodes,
    successStatusCodes,
    errorStatusCodes,
  });

  const rawHandler = options.handler;

  const wrappedHandler: RouteHandlerMethod = function routeWithPipelineDebug(
    this: FastifyInstance,
    request,
    reply,
  ) {
    const requestId = request.requestId;
    return runWithRequestPipelineDebug(
      {
        requestId,
        debugRequest: request.debugRequest,
        requestLog: request.log,
      },
      () => Reflect.apply(
        rawHandler as (...args: unknown[]) => unknown,
        this,
        [request, reply],
      ),
    );
  };

  app.route({
    method: options.method,
    url: options.url,
    handler: wrappedHandler,
  });
}

export function getRegisteredHttpRouteContracts(
  app: FastifyInstance,
): readonly RegisteredHttpRouteContract[] {
  return [...(routeContractRegistry.get(app) ?? [])];
}

function compareContracts(
  left: RegisteredHttpRouteContract,
  right: RegisteredHttpRouteContract,
): number {
  return left.url.localeCompare(right.url)
    || left.method.localeCompare(right.method)
    || left.operationId.localeCompare(right.operationId);
}

export function buildHttpRouteContractManifest(
  app: FastifyInstance,
): HttpRouteContractManifest {
  const routes = getRegisteredHttpRouteContracts(app)
    .slice()
    .sort(compareContracts);

  return {
    version: 1,
    routes,
  };
}

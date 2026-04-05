import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import type { HttpRouteContract } from './route-contracts.js';

export interface RegisteredHttpRouteContract {
  readonly method: string;
  readonly url: string;
  readonly operationId: string;
  readonly responseStatusCodes: readonly number[];
}

declare module 'fastify' {
  interface FastifyInstance {
    httpRouteContracts: RegisteredHttpRouteContract[];
  }
}

function ensureRouteContractStore(app: FastifyInstance): RegisteredHttpRouteContract[] {
  if (!('httpRouteContracts' in app)) {
    app.decorate('httpRouteContracts', []);
  }

  return app.httpRouteContracts;
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

  ensureRouteContractStore(app).push({
    method: options.method,
    url: options.url,
    operationId: options.contract.operationId,
    responseStatusCodes,
  });

  app.route({
    method: options.method,
    url: options.url,
    config: {
      httpContract: {
        operationId: options.contract.operationId,
        responseStatusCodes,
      },
    },
    handler: options.handler,
  });
}

export function getRegisteredHttpRouteContracts(
  app: FastifyInstance,
): readonly RegisteredHttpRouteContract[] {
  return 'httpRouteContracts' in app ? [...app.httpRouteContracts] : [];
}

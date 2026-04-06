import type { SearchRequest } from './search-request.dto.js';

/**
 * Request shape for {@link SearchResponseCachePort} get/set (session only, no previousEntities).
 */
export function buildSearchCacheRequestContext(request: SearchRequest): {
  readonly sessionContext?: { readonly sessionId: string };
  readonly context?: { readonly locale: string };
} {
  const cacheSessionContext = request.sessionContext
    ? { sessionId: request.sessionContext.sessionId }
    : undefined;
  return {
    ...(cacheSessionContext !== undefined ? { sessionContext: cacheSessionContext } : {}),
    ...(request.context !== undefined ? { context: { locale: request.context.locale } } : {}),
  };
}

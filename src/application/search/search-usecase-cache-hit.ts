import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';

/**
 * Cache hit path: preserve body, refresh request id and wall-clock latency only.
 */
export function mergeCachedSearchResponseMeta(
  cached: SearchResponseV1,
  requestId: string,
  startTimeMs: number,
): SearchResponseV1 {
  return {
    ...cached,
    meta: {
      ...cached.meta,
      requestId,
      queryTimeMs: Date.now() - startTimeMs,
    },
  };
}

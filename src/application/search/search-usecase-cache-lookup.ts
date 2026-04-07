import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CacheReadRuntimeState } from '../../domain/cache/cache-policy.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { SearchResponseCachePort } from '../../domain/performance/port/search-response-cache.port.js';
import type { SearchRequest } from './search-request.dto.js';
import { buildSearchCacheRequestContext } from './search-usecase-cache-context.js';
import { buildDecisionSnapshotFromPlan } from './search-usecase-decision-snapshot.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';


export type SnapshotVersionInjection =
  | {
      readonly modelVersions: Readonly<Record<string, string>>;
      readonly indexVersions: Readonly<Record<string, string>>;
      readonly featureFlags: Readonly<Record<string, boolean>>;
    }
  | undefined;

export type CacheLookupRuntimeState = CacheReadRuntimeState;

/**
 * Wave 4 cache read — returns cached body on hit, otherwise `undefined`.
 */
export async function tryGetCachedSearchResponse(
  cacheService: SearchResponseCachePort,
  plan: QueryPlanV1,
  request: SearchRequest,
  snapshotVersions: SnapshotVersionInjection,
  runtimeState?: CacheLookupRuntimeState,
): Promise<SearchResponseV1 | undefined> {
  const cacheResult = await cacheService.getSearchResponse(
    plan,
    buildSearchCacheRequestContext(request),
    buildDecisionSnapshotFromPlan(plan, snapshotVersions),
    runtimeState,
  );
  if (cacheResult.hit && cacheResult.data) {
    const data = cacheResult.data;
    // Minimal runtime shape check — guard against corrupt or stale cached values
    // that are missing fields required by SearchResponseV1.
    const isValidShape =
      data !== null &&
      typeof data === 'object' &&
      'engineDecision' in data &&
      'results' in data &&
      'meta' in data;

    if (!isValidShape) {
      bootstrapLogger.warn(
        { rawQuery: plan.rawQuery },
        'cache_hit_shape_invalid: required fields missing (engineDecision, results, meta); treating as cache miss',
      );
      return undefined;
    }

    return data;
  }
  return undefined;
}

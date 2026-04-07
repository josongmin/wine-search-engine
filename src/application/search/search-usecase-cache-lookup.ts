import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { CacheReadRuntimeState } from '../../domain/cache/cache-policy.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { SearchResponseCachePort } from '../../domain/performance/port/search-response-cache.port.js';
import type { SearchRequest } from './search-request.dto.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { buildSearchCacheRequestContext } from './search-usecase-cache-context.js';
import { buildDecisionSnapshotFromPlan } from './search-usecase-decision-snapshot.js';

/** Runtime guard against corrupt or partially-written cached values. */
function isCachedResponseValid(data: SearchResponseV1): boolean {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return data.engineDecision !== undefined && data.results !== undefined && data.meta !== undefined;
}

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
  compiled: CompiledWineQuery | undefined,
  request: SearchRequest,
  snapshotVersions: SnapshotVersionInjection,
  runtimeState?: CacheLookupRuntimeState,
): Promise<SearchResponseV1 | undefined> {
  let cacheResult;
  try {
    cacheResult = await cacheService.getSearchResponse(
      plan,
      buildSearchCacheRequestContext(request),
      buildDecisionSnapshotFromPlan(plan, snapshotVersions),
      runtimeState,
      compiled,
    );
  } catch (err: unknown) {
    bootstrapLogger.warn(
      { err, rawQuery: plan.rawQuery.slice(0, 100) },
      '[CacheLookup] Cache read failed — treating as miss',
    );
    return undefined;
  }
  if (cacheResult.hit && cacheResult.data) {
    if (!isCachedResponseValid(cacheResult.data)) {
      bootstrapLogger.warn(
        { rawQuery: plan.rawQuery },
        '[CacheLookup] Cached response missing required fields — treating as miss',
      );
      return undefined;
    }
    return cacheResult.data;
  }
  return undefined;
}

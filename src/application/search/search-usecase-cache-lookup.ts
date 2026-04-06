import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { SearchResponseCachePort } from '../../domain/performance/port/search-response-cache.port.js';
import type { SearchRequest } from './search-request.dto.js';
import { buildSearchCacheRequestContext } from './search-usecase-cache-context.js';
import { buildDecisionSnapshotFromPlan } from './search-usecase-decision-snapshot.js';

export type SnapshotVersionInjection =
  | {
      readonly modelVersions: Readonly<Record<string, string>>;
      readonly indexVersions: Readonly<Record<string, string>>;
      readonly featureFlags: Readonly<Record<string, boolean>>;
    }
  | undefined;

/**
 * Wave 4 cache read — returns cached body on hit, otherwise `undefined`.
 */
export async function tryGetCachedSearchResponse(
  cacheService: SearchResponseCachePort,
  plan: QueryPlanV1,
  request: SearchRequest,
  snapshotVersions: SnapshotVersionInjection,
): Promise<SearchResponseV1 | undefined> {
  const cacheResult = await cacheService.getSearchResponse(
    plan,
    buildSearchCacheRequestContext(request),
    buildDecisionSnapshotFromPlan(plan, snapshotVersions),
  );
  if (cacheResult.hit && cacheResult.data) {
    return cacheResult.data;
  }
  return undefined;
}

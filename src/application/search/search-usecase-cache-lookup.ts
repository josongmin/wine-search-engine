import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { CacheReadRuntimeState } from '../../domain/cache/cache-policy.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { SearchResponseCachePort } from '../../domain/performance/port/search-response-cache.port.js';
import type { SearchRequest } from './search-request.dto.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { buildSearchCacheRequestContext } from './search-usecase-cache-context.js';
import { buildDecisionSnapshotFromPlan } from './search-usecase-decision-snapshot.js';
import { globalSilentSkipCounter } from '../../observability/silent-skip-counters.js';

const log = bootstrapLogger.child({ component: 'CacheLookup' });

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
  requestId?: string,
): Promise<SearchResponseV1 | undefined> {
  try {
    const cacheResult = await cacheService.getSearchResponse(
      plan,
      buildSearchCacheRequestContext(request),
      buildDecisionSnapshotFromPlan(plan, snapshotVersions),
      runtimeState,
      compiled,
    );
    switch (cacheResult.kind) {
      case 'hit':
        if (!isCachedResponseValid(cacheResult.value)) {
          globalSilentSkipCounter.increment('cache_read_failure', {
            surface: 'search_response',
            errorClass: 'corrupt_entry',
          });
          log.warn(
            { requestId, rawQuery: plan.rawQuery },
            'cached response missing required fields (corrupt_entry) — treating as miss',
          );
          return undefined;
        }
        return cacheResult.value;
      case 'breaker_open':
        globalSilentSkipCounter.increment('cache_read_failure', {
          surface: 'search_response',
          reason: 'breaker_open',
        });
        log.warn(
          { requestId, rawQuery: plan.rawQuery },
          'cache read short-circuited by breaker_open — treating as miss',
        );
        return undefined;
      case 'infra_error':
        globalSilentSkipCounter.increment('cache_read_failure', {
          surface: 'search_response',
          errorClass: cacheResult.errorClass,
        });
        log.warn(
          { err: cacheResult.message, requestId, errorClass: cacheResult.errorClass, rawQuery: plan.rawQuery.slice(0, 100) },
          'cache read failed (infra_error) — treating as miss',
        );
        return undefined;
      case 'corrupt_entry':
        globalSilentSkipCounter.increment('cache_read_failure', {
          surface: 'search_response',
          errorClass: 'corrupt_entry',
          reason: cacheResult.reason,
        });
        log.warn(
          { requestId, rawQuery: plan.rawQuery, reason: cacheResult.reason },
          'cache entry poisoned (corrupt_entry) — treating as miss',
        );
        return undefined;
      case 'miss':
        return undefined;
    }
  } catch (err: unknown) {
    // Wave 2: distinguish infra failure from a legitimate miss in
    // observability. The caller still gets `undefined` (continue computing)
    // but ops see which keys are hitting Redis errors vs just missing.
    const errorClass = err instanceof Error ? err.constructor.name : typeof err;
    globalSilentSkipCounter.increment('cache_read_failure', {
      surface: 'search_response',
      errorClass,
    });
    log.warn(
      { err, requestId, errorClass, rawQuery: plan.rawQuery.slice(0, 100) },
      'cache read failed (infra_error) — treating as miss',
    );
    return undefined;
  }
}

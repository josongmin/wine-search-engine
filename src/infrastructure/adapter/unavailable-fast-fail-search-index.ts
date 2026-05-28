import {
  createCircuitBreaker,
  type CircuitBreaker,
} from '../../domain/shared/circuit-breaker/circuit-breaker.js';
import { globalCircuitBreakerRegistry } from '../../domain/observability/circuit-breaker-registry.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { CircuitBreakerOpenError } from '../../domain/shared/error/circuit-breaker-open-error.js';
import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import type {
  RetrievalDocument,
  RetrievalDrinkingWindowProjection,
} from '../../domain/retrieval/model/retrieval-document.js';
import type { SearchIndexPort } from '../../domain/retrieval/port/search-index.port.js';
import { VespaHttpError, VespaNetworkError } from '../vespa/vespa-client.js';

const log = bootstrapLogger.child({ component: 'UnavailableFastFailSearchIndex' });

export const SEARCH_INDEX_UNAVAILABLE_BREAKER_NAME = 'vespa-search-unavailable';
const SEARCH_INDEX_UNAVAILABLE_FAILURE_THRESHOLD = 1;
const SEARCH_INDEX_UNAVAILABLE_RECOVERY_TIMEOUT_MS = 30_000;
const SEARCH_INDEX_UNAVAILABLE_HALF_OPEN_MAX = 1;

type SearchIndexFailureKind = 'service_failure' | 'caller_fault' | 'abort';

interface UnavailableFastFailSearchIndexOptions {
  readonly breakerName?: string | undefined;
  readonly failureThreshold?: number | undefined;
  readonly recoveryTimeoutMs?: number | undefined;
  readonly halfOpenMaxAttempts?: number | undefined;
}

function classifySearchIndexError(error: unknown): SearchIndexFailureKind {
  if (error instanceof CircuitBreakerOpenError) {
    return 'service_failure';
  }
  if (error instanceof VespaNetworkError) {
    return error.isAborted ? 'abort' : 'service_failure';
  }
  if (error instanceof VespaHttpError) {
    return error.isClientError && !error.isRateLimited
      ? 'caller_fault'
      : 'service_failure';
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'abort';
  }
  return 'caller_fault';
}

export class UnavailableFastFailSearchIndex implements SearchIndexPort {
  private readonly breaker: CircuitBreaker;
  private readonly breakerName: string;

  constructor(
    private readonly inner: SearchIndexPort,
    options: UnavailableFastFailSearchIndexOptions = {},
  ) {
    this.breakerName = options.breakerName ?? SEARCH_INDEX_UNAVAILABLE_BREAKER_NAME;
    this.breaker = createCircuitBreaker({
      name: this.breakerName,
      failureThreshold: options.failureThreshold ?? SEARCH_INDEX_UNAVAILABLE_FAILURE_THRESHOLD,
      recoveryTimeoutMs: options.recoveryTimeoutMs ?? SEARCH_INDEX_UNAVAILABLE_RECOVERY_TIMEOUT_MS,
      halfOpenMaxAttempts: options.halfOpenMaxAttempts ?? SEARCH_INDEX_UNAVAILABLE_HALF_OPEN_MAX,
    });
    globalCircuitBreakerRegistry.register(this.breakerName, this.breaker);
  }

  sparseSearch(...args: Parameters<SearchIndexPort['sparseSearch']>) {
    return this.runGuardedSearch('sparseSearch', () => this.inner.sparseSearch(...args));
  }

  denseSearch(...args: Parameters<SearchIndexPort['denseSearch']>) {
    return this.runGuardedSearch('denseSearch', () => this.inner.denseSearch(...args));
  }

  searchLearnedSparse(...args: Parameters<SearchIndexPort['searchLearnedSparse']>) {
    return this.runGuardedSearch('searchLearnedSparse', () => this.inner.searchLearnedSparse(...args));
  }

  getDocument(entityId: CanonicalEntityId): Promise<RetrievalDocument | null> {
    return this.inner.getDocument(entityId);
  }

  getDocuments(
    entityIds: readonly CanonicalEntityId[],
  ): Promise<ReadonlyMap<CanonicalEntityId, RetrievalDocument>> {
    return this.inner.getDocuments(entityIds);
  }

  getDrinkingWindowDocuments(
    entityIds: readonly CanonicalEntityId[],
  ): Promise<ReadonlyMap<CanonicalEntityId, RetrievalDrinkingWindowProjection>> {
    if (this.inner.getDrinkingWindowDocuments === undefined) {
      throw new Error(
        'getDrinkingWindowDocuments: inner search index does not implement drinking-window projection',
      );
    }
    return this.inner.getDrinkingWindowDocuments(entityIds);
  }

  upsertDocument(doc: RetrievalDocument): Promise<void> {
    return this.inner.upsertDocument(doc);
  }

  bulkUpsert(docs: readonly RetrievalDocument[]): Promise<void> {
    return this.inner.bulkUpsert(docs);
  }

  private async runGuardedSearch<T>(
    operation: 'sparseSearch' | 'denseSearch' | 'searchLearnedSparse',
    fn: () => Promise<T>,
  ): Promise<T> {
    let passthroughError: unknown;
    const passthrough = Symbol(`${operation}_passthrough`);
    const result = await this.breaker.execute(async () => {
      try {
        return await fn();
      } catch (error) {
        const kind = classifySearchIndexError(error);
        if (kind === 'service_failure') {
          throw error;
        }
        passthroughError = error;
        return passthrough;
      }
    });

    if (passthroughError !== undefined) {
      throw passthroughError;
    }

    if (this.breaker.state === 'OPEN') {
      log.warn(
        {
          breakerName: this.breakerName,
          operation,
        },
        'search index transport breaker opened; subsequent retrieval calls will fast-fail',
      );
    }

    if (result === passthrough) {
      throw new Error(`${operation}: passthrough sentinel escaped invariant`);
    }

    return result as T;
  }
}

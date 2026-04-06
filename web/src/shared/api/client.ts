import type {
  SearchRequest,
  SearchResponse,
  EntityResolveRequest,
  EntityResolveResponse,
  FeedbackRequest,
  FeedbackResponse,
  WatchlistCreateRequest,
  WatchlistEntry,
  WatchlistListResponse,
} from './types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
const DEFAULT_TIMEOUT_MS = 30_000;

class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const err =
        body && typeof body === 'object' && 'error' in body
          ? (body as { error: { code?: string; message?: string; retryable?: boolean } }).error
          : {};
      throw new ApiError(
        res.status,
        err.code ?? `HTTP_${res.status}`,
        err.message ?? res.statusText,
        err.retryable ?? res.status >= 500,
      );
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError(0, 'TIMEOUT', `Request timed out after ${timeoutMs}ms`, true);
    }
    throw new ApiError(0, 'NETWORK', String(err), true);
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  search(body: SearchRequest) {
    return request<SearchResponse>('/v1/search', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  searchHybrid(body: SearchRequest) {
    return request<SearchResponse>('/v1/search/hybrid', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  entityResolve(body: EntityResolveRequest) {
    return request<EntityResolveResponse>('/v1/entity/resolve', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  submitFeedback(body: FeedbackRequest) {
    return request<FeedbackResponse>('/v1/feedback', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  watchlist: {
    list() {
      return request<WatchlistListResponse>('/v1/watchlist');
    },
    get(id: string) {
      return request<WatchlistEntry>(`/v1/watchlist/${encodeURIComponent(id)}`);
    },
    create(body: WatchlistCreateRequest) {
      return request<WatchlistEntry>('/v1/watchlist', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    delete(id: string) {
      return request<void>(`/v1/watchlist/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },
  },
} as const;

export { ApiError };

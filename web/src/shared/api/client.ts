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
import { getSubjectId } from '@/shared/lib/subject';

// Direct backend URL — set NEXT_PUBLIC_API_URL in .env.local
// Default: http://localhost:4000 (Fastify dev server)
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const DEFAULT_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean = false,
    public readonly requestId?: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type RequestOptions = RequestInit & { subject?: boolean };

async function request<T>(
  path: string,
  options: RequestOptions = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const { subject, ...fetchInit } = options;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(fetchInit.headers as Record<string, string> | undefined),
  };
  if (subject) {
    headers['X-Authenticated-Subject'] = getSubjectId();
  }

  try {
    const res = await fetch(url, { ...fetchInit, signal: controller.signal, headers });

    const retryAfterRaw = res.headers.get('Retry-After');
    const retryAfterMs = retryAfterRaw ? parseInt(retryAfterRaw, 10) * 1000 : undefined;

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const err =
        body && typeof body === 'object' && 'error' in body
          ? (body as { error: { code?: string; message?: string; retryable?: boolean; request_id?: string } }).error
          : {};
      throw new ApiError(
        res.status,
        err.code ?? `HTTP_${res.status}`,
        err.message ?? res.statusText,
        err.retryable ?? res.status >= 500,
        err.request_id,
        retryAfterMs,
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
    return request<SearchResponse>('/v1/search', { method: 'POST', body: JSON.stringify(body) });
  },

  searchHybrid(body: SearchRequest) {
    return request<SearchResponse>('/v1/search/hybrid', { method: 'POST', body: JSON.stringify(body) });
  },

  entityResolve(body: EntityResolveRequest) {
    return request<EntityResolveResponse>('/v1/entity/resolve', { method: 'POST', body: JSON.stringify(body) });
  },

  submitFeedback(body: FeedbackRequest) {
    return request<FeedbackResponse>('/v1/feedback', { method: 'POST', body: JSON.stringify(body) });
  },

  health: {
    check() {
      return request<{ status: string; timestamp: string; uptime: number }>('/health', {}, 5_000);
    },
  },

  watchlist: {
    list() {
      return request<WatchlistListResponse>('/v1/watchlist', { subject: true });
    },
    get(id: string) {
      return request<WatchlistEntry>(`/v1/watchlist/${encodeURIComponent(id)}`, { subject: true });
    },
    create(body: WatchlistCreateRequest) {
      return request<WatchlistEntry>('/v1/watchlist', { method: 'POST', body: JSON.stringify(body), subject: true });
    },
    delete(id: string) {
      return request<void>(`/v1/watchlist/${encodeURIComponent(id)}`, { method: 'DELETE', subject: true });
    },
  },
} as const;

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
  AgentBenchmarkScenariosResponse,
  AgentExecuteRequest,
  AgentExecuteResponse,
} from './types';
import { getSubjectId } from '@/shared/lib/subject';

// Direct backend URL — set NEXT_PUBLIC_API_URL in .env.local
// Default: http://localhost:4000 (Fastify dev server)
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const DEFAULT_TIMEOUT_MS = 30_000;
/** Agent loop can exceed default browser/fetch timeouts. */
const AGENT_EXECUTE_TIMEOUT_MS = 180_000;

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

type RequestOptions = RequestInit & { subject?: boolean; externalSignal?: AbortSignal };

async function request<T>(
  path: string,
  options: RequestOptions = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const { subject, externalSignal, ...fetchInit } = options;

  // Compose external signal (e.g., React Query's queryFn signal) with the
  // local timeout controller. Either one aborting cancels the fetch.
  // Named handler so we can remove it in `finally` to prevent listener
  // leaks when the signal outlives this request.
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

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
    // Retry-After can be either delta-seconds or HTTP-date (RFC 7231).
    // parseInt on an HTTP-date returns NaN; clamp safely.
    let retryAfterMs: number | undefined;
    if (retryAfterRaw) {
      const asSeconds = Number.parseInt(retryAfterRaw, 10);
      if (Number.isFinite(asSeconds) && asSeconds >= 0) {
        retryAfterMs = asSeconds * 1000;
      } else {
        const asDate = Date.parse(retryAfterRaw);
        if (Number.isFinite(asDate)) {
          retryAfterMs = Math.max(0, asDate - Date.now());
        }
      }
    }

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
    // Avoid String(err) — it can leak Error.stack into user-facing messages.
    const message = err instanceof Error ? err.message : 'Network error';
    throw new ApiError(0, 'NETWORK', message, true);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

interface ApiCallOptions {
  readonly signal?: AbortSignal;
}

export const api = {
  search(body: SearchRequest, opts: ApiCallOptions = {}) {
    return request<SearchResponse>('/v1/search', {
      method: 'POST',
      body: JSON.stringify(body),
      externalSignal: opts.signal,
    });
  },

  searchHybrid(body: SearchRequest, opts: ApiCallOptions = {}) {
    return request<SearchResponse>('/v1/search/hybrid', {
      method: 'POST',
      body: JSON.stringify(body),
      externalSignal: opts.signal,
    });
  },

  entityResolve(body: EntityResolveRequest, opts: ApiCallOptions = {}) {
    return request<EntityResolveResponse>('/v1/entity/resolve', {
      method: 'POST',
      body: JSON.stringify(body),
      externalSignal: opts.signal,
    });
  },

  submitFeedback(body: FeedbackRequest, opts: ApiCallOptions = {}) {
    return request<FeedbackResponse>('/v1/feedback', {
      method: 'POST',
      body: JSON.stringify(body),
      externalSignal: opts.signal,
    });
  },

  health: {
    check(opts: ApiCallOptions = {}) {
      return request<{ status: string; timestamp: string; uptime: number }>(
        '/health',
        { externalSignal: opts.signal },
        5_000,
      );
    },
  },

  agent: {
    listBenchmarkScenarios(opts: ApiCallOptions = {}) {
      return request<AgentBenchmarkScenariosResponse>(
        '/v1/agent/benchmark-scenarios',
        { method: 'GET', externalSignal: opts.signal },
      );
    },

    execute(body: AgentExecuteRequest, opts: ApiCallOptions = {}) {
      return request<AgentExecuteResponse>(
        '/v1/agent',
        {
          method: 'POST',
          body: JSON.stringify(body),
          externalSignal: opts.signal,
        },
        AGENT_EXECUTE_TIMEOUT_MS,
      );
    },
  },

  watchlist: {
    list(opts: ApiCallOptions = {}) {
      return request<WatchlistListResponse>('/v1/watchlist', {
        subject: true,
        externalSignal: opts.signal,
      });
    },
    get(id: string, opts: ApiCallOptions = {}) {
      return request<WatchlistEntry>(`/v1/watchlist/${encodeURIComponent(id)}`, {
        subject: true,
        externalSignal: opts.signal,
      });
    },
    create(body: WatchlistCreateRequest, opts: ApiCallOptions = {}) {
      return request<WatchlistEntry>('/v1/watchlist', {
        method: 'POST',
        body: JSON.stringify(body),
        subject: true,
        externalSignal: opts.signal,
      });
    },
    delete(id: string, opts: ApiCallOptions = {}) {
      return request<void>(`/v1/watchlist/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        subject: true,
        externalSignal: opts.signal,
      });
    },
  },
} as const;

import type {
  SearchRequest,
  SearchResponse,
  EntityResolveResponse,
  EntitySummary,
  WineSearchRequest,
  WineSearchResponse,
  AgentSessionCreateRequest,
  AgentSessionCreateResponse,
  AgentSessionTurnRequest,
  AgentSessionTurnResponse,
} from './types';
import type {
  AliasAuditResponse,
  CoverageHealthResponse,
  ListProposalsRequest,
  ListProposalsResponse,
  OpsInspectResponse,
  ProposalResponse,
  PublishProposalRequest,
  ReviewProposalRequest,
  SubmitProposalRequest,
} from './ops-types';

/** Trusted-operator credentials. Read uses X-Debug-Key; write uses X-Ops-Write-Key. */
const DEBUG_KEY_HEADER = 'X-Debug-Key';
const WRITE_KEY_HEADER = 'X-Ops-Write-Key';

// Direct backend URL — set NEXT_PUBLIC_API_URL in .env.local
// Default: http://localhost:4000 (Fastify dev server)
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const DEFAULT_TIMEOUT_MS = 30_000;
/** Plan-then-execute wine-search can fan out several Vespa round-trips
 * before synthesis. Aligned with the wire schema's `agent_timeout_ms`
 * upper bound (120_000 ms) plus headroom for network + serialization. */
const WINE_SEARCH_EXECUTE_TIMEOUT_MS = 180_000;

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

type RequestOptions = RequestInit & { externalSignal?: AbortSignal };

async function request<T>(
  path: string,
  options: RequestOptions = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const { externalSignal, ...fetchInit } = options;

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
    return request<SearchResponse>('/v1/search/hybrid', {
      method: 'POST',
      body: JSON.stringify(body),
      externalSignal: opts.signal,
    });
  },

  async lookupEntity(body: SearchRequest, opts: ApiCallOptions = {}) {
    // V2-only cutover: lookup resolves via POST /v2/entity-lookup (the legacy
    // /v1/lookup/wine route was removed). The wire body is the snake_case
    // EntityLookupV2 4-state result.
    interface LookupV2Candidate {
      entity_id: string;
      canonical_label: string;
      entity_type?: string;
      calibrated_score?: number;
    }
    interface LookupV2Response {
      status: 'resolved' | 'ambiguous' | 'failed' | 'redirect_discovery';
      top_candidate: LookupV2Candidate | null;
      candidates: readonly LookupV2Candidate[];
    }
    const response = await request<LookupV2Response>('/v2/entity-lookup', {
      method: 'POST',
      body: JSON.stringify({ query: body.query }),
      externalSignal: opts.signal,
    });
    if (response.status !== 'resolved' || response.top_candidate === null) {
      throw new ApiError(404, 'ENTITY_NOT_FOUND', 'No lookup candidate matched the requested wine');
    }

    const top = response.top_candidate;
    const toSummary = (c: LookupV2Candidate): EntitySummary => ({
      entity_id: c.entity_id as EntitySummary['entity_id'],
      canonical_label: c.canonical_label,
      type: c.entity_type ?? 'wine',
    });
    return {
      entity: toSummary(top),
      confidence: top.calibrated_score ?? 1,
      alternatives: response.candidates
        .filter((c) => c.entity_id !== top.entity_id)
        .map(toSummary),
    } satisfies EntityResolveResponse;
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

  /**
   * Plan-then-Execute wine search (POST /v1/agent).
   * This is the canonical agentic API surface.
   */
  wineSearch: {
    execute(body: WineSearchRequest, opts: ApiCallOptions = {}) {
      return request<WineSearchResponse>(
        '/v1/agent',
        {
          method: 'POST',
          body: JSON.stringify(body),
          externalSignal: opts.signal,
        },
        WINE_SEARCH_EXECUTE_TIMEOUT_MS,
      );
    },
  },

  /**
   * Server-managed agent sessions (POST /v1/agent/sessions*).
   * Unlike `wineSearch.execute` (caller-managed history), the server stitches
   * prior turns; the caller sends only the new turn's messages.
   */
  agent: {
    sessions: {
      create(body: AgentSessionCreateRequest = {}, opts: ApiCallOptions = {}) {
        return request<AgentSessionCreateResponse>(
          '/v1/agent/sessions',
          {
            method: 'POST',
            body: JSON.stringify(body),
            externalSignal: opts.signal,
          },
          WINE_SEARCH_EXECUTE_TIMEOUT_MS,
        );
      },
      turn(sessionId: string, body: AgentSessionTurnRequest, opts: ApiCallOptions = {}) {
        return request<AgentSessionTurnResponse>(
          `/v1/agent/sessions/${encodeURIComponent(sessionId)}/turns`,
          {
            method: 'POST',
            body: JSON.stringify(body),
            externalSignal: opts.signal,
          },
          WINE_SEARCH_EXECUTE_TIMEOUT_MS,
        );
      },
    },
  },

  /**
   * Trusted operator curation plane (`/v2/entity-lookup/ops/*`, T-ELV2-07).
   * Reads pass the X-Debug-Key; writes pass the (separate) X-Ops-Write-Key.
   * Keys are supplied per-call by the operator console — never persisted server-side.
   */
  ops: {
    inspect(query: string, debugKey: string, opts: ApiCallOptions = {}) {
      return request<OpsInspectResponse>('/v2/entity-lookup/ops/inspect', {
        method: 'POST',
        headers: { [DEBUG_KEY_HEADER]: debugKey },
        body: JSON.stringify({ query }),
        externalSignal: opts.signal,
      });
    },
    aliasAudit(entityId: string, debugKey: string, opts: ApiCallOptions = {}) {
      return request<AliasAuditResponse>('/v2/entity-lookup/ops/alias-audit', {
        method: 'POST',
        headers: { [DEBUG_KEY_HEADER]: debugKey },
        body: JSON.stringify({ entity_id: entityId }),
        externalSignal: opts.signal,
      });
    },
    coverageHealth(debugKey: string, opts: ApiCallOptions = {}) {
      return request<CoverageHealthResponse>('/v2/entity-lookup/ops/coverage-health', {
        method: 'POST',
        headers: { [DEBUG_KEY_HEADER]: debugKey },
        body: JSON.stringify({}),
        externalSignal: opts.signal,
      });
    },
    listProposals(filter: ListProposalsRequest, debugKey: string, opts: ApiCallOptions = {}) {
      return request<ListProposalsResponse>('/v2/entity-lookup/ops/proposals', {
        method: 'POST',
        headers: { [DEBUG_KEY_HEADER]: debugKey },
        body: JSON.stringify(filter),
        externalSignal: opts.signal,
      });
    },
    submitProposal(body: SubmitProposalRequest, writeKey: string, opts: ApiCallOptions = {}) {
      return request<ProposalResponse>('/v2/entity-lookup/ops/proposals/submit', {
        method: 'POST',
        headers: { [WRITE_KEY_HEADER]: writeKey },
        body: JSON.stringify(body),
        externalSignal: opts.signal,
      });
    },
    reviewProposal(body: ReviewProposalRequest, writeKey: string, opts: ApiCallOptions = {}) {
      return request<ProposalResponse>('/v2/entity-lookup/ops/proposals/review', {
        method: 'POST',
        headers: { [WRITE_KEY_HEADER]: writeKey },
        body: JSON.stringify(body),
        externalSignal: opts.signal,
      });
    },
    publishProposal(body: PublishProposalRequest, writeKey: string, opts: ApiCallOptions = {}) {
      return request<ProposalResponse>('/v2/entity-lookup/ops/proposals/publish', {
        method: 'POST',
        headers: { [WRITE_KEY_HEADER]: writeKey },
        body: JSON.stringify(body),
        externalSignal: opts.signal,
      });
    },
  },
} as const;

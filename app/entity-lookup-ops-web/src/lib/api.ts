// Live client for the wine-search-engine backend ops API (/v2/entity-lookup*).
// In dev, Vite proxies /v2 → the backend (see vite.config.ts). When the backend
// is unreachable the UI falls back to the static public/data snapshot.

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string; failure_reason?: string } };
      msg = j?.error?.message ?? j?.error?.failure_reason ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

// --- ops auth keys (curation plane gates) ----------------------------------
// Read ops need X-Debug-Key (HTTP_DEBUG_SECRET); writes also need X-Ops-Write-Key
// (HTTP_OPS_WRITE_SECRET). Stored in localStorage, entered by the operator once.
const KEY_DEBUG = 'ops.debugKey';
const KEY_WRITE = 'ops.writeKey';
export function getOpsKeys(): { debug: string; write: string } {
  return { debug: localStorage.getItem(KEY_DEBUG) ?? '', write: localStorage.getItem(KEY_WRITE) ?? '' };
}
export function setOpsKeys(debug: string, write: string): void {
  localStorage.setItem(KEY_DEBUG, debug);
  localStorage.setItem(KEY_WRITE, write);
}

async function postOps<T>(url: string, body: unknown, write = false): Promise<T> {
  const { debug, write: wkey } = getOpsKeys();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (debug) headers['x-debug-key'] = debug;
  if (write && wkey) headers['x-ops-write-key'] = wkey;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string; failure_reason?: string } };
      msg = j?.error?.message ?? j?.error?.failure_reason ?? msg;
    } catch {
      /* ignore */
    }
    if (res.status === 403 || /policy_blocked/i.test(msg)) msg = '운영 키가 없거나 틀렸어요 (우상단 🔑 운영 키에서 입력).';
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export interface Candidate {
  readonly entityId: string;
  readonly label: string;
  readonly score?: number;
}

export async function searchCatalog(query: string, max = 8): Promise<Candidate[]> {
  const r = await post<{ candidates?: { entity_id: string; canonical_label: string; calibrated_score?: number; score?: number }[] }>(
    '/v2/entity-lookup',
    { query, max_candidates: max },
  );
  return (r.candidates ?? []).map((c) => ({
    entityId: c.entity_id,
    label: c.canonical_label,
    score: c.calibrated_score ?? c.score,
  }));
}

export interface CoverageHealth {
  readonly queue_by_status: { pending: number; approved: number; rejected: number; published: number };
  readonly queue_by_kind: { alias: number; ambiguity: number; suppression: number };
  readonly total_proposals: number;
}
export function coverageHealth(): Promise<CoverageHealth> {
  return postOps<CoverageHealth>('/v2/entity-lookup/ops/coverage-health', {});
}

export interface Proposal {
  readonly proposal_id: string;
  readonly status: string;
  readonly kind: string;
  readonly surface_form?: string;
  readonly target_entity_id?: string;
  readonly proposed_type?: string;
  readonly confidence?: number;
  readonly proposed_by?: string;
  readonly decision_reason?: string;
  readonly created_at?: string;
}
export async function listProposals(filter: { status?: string; kind?: string; limit?: number } = {}): Promise<Proposal[]> {
  const r = await postOps<{ proposals?: Proposal[] }>('/v2/entity-lookup/ops/proposals', { limit: 100, ...filter });
  return r.proposals ?? [];
}

const ALIAS_TYPES = ['canonical', 'translation', 'phonetic', 'misspelling', 'observed_query_alias'] as const;
export type AliasType = (typeof ALIAS_TYPES)[number];
export const ALIAS_TYPE_OPTIONS: { value: AliasType; label: string }[] = [
  { value: 'observed_query_alias', label: '손님이 실제로 친 검색어' },
  { value: 'phonetic', label: '소리나는 대로(음역)' },
  { value: 'translation', label: '번역/한글 표기' },
  { value: 'misspelling', label: '오타/변형' },
  { value: 'canonical', label: '정식 명칭' },
];

export function submitAliasProposal(input: {
  surface_form: string;
  target_entity_id: string;
  proposed_type?: AliasType;
  confidence?: number;
  evidence?: Record<string, unknown>;
  proposed_by?: string;
}): Promise<Proposal> {
  return postOps<Proposal>('/v2/entity-lookup/ops/proposals/submit', {
    kind: 'alias',
    surface_form: input.surface_form,
    target_entity_id: input.target_entity_id,
    proposed_type: input.proposed_type ?? 'observed_query_alias',
    confidence: input.confidence ?? 0.9,
    evidence: input.evidence ?? { source: 'entity-lookup-ops-web' },
    proposed_by: input.proposed_by ?? 'ops-web',
  }, true);
}

export function reviewProposal(proposalId: string, decision: 'approve' | 'reject', reason: string, by = 'ops-web'): Promise<Proposal> {
  return postOps<Proposal>('/v2/entity-lookup/ops/proposals/review', {
    kind: 'alias',
    proposal_id: proposalId,
    decision,
    reviewed_by: by,
    decision_reason: reason,
  }, true);
}

export function publishProposal(proposalId: string, by = 'ops-web'): Promise<Proposal> {
  return postOps<Proposal>('/v2/entity-lookup/ops/proposals/publish', {
    kind: 'alias',
    proposal_id: proposalId,
    reviewed_by: by,
  }, true);
}

export interface AliasRow {
  readonly alias_id: string;
  readonly surface_form: string;
  readonly alias_type: string;
  readonly source: string;
}
export interface AliasAudit {
  readonly entity_id: string;
  readonly aliases: readonly AliasRow[];
  readonly related_proposals: readonly Proposal[];
}
export function aliasAudit(entityId: string): Promise<AliasAudit> {
  return postOps<AliasAudit>('/v2/entity-lookup/ops/alias-audit', { entity_id: entityId });
}

// --- search-engine ops -----------------------------------------------------

export interface SearchHit {
  readonly entityId?: string;
  readonly label: string;
  readonly score?: number;
  readonly region?: string;
  readonly price?: number;
}
export async function hybridSearch(query: string): Promise<{ hits: SearchHit[]; raw: unknown }> {
  const r = await post<Record<string, unknown>>('/v1/search/hybrid', { query });
  const arr = (r.results ?? r.hits ?? r.candidates ?? r.wines ?? []) as Record<string, unknown>[];
  const hits = (Array.isArray(arr) ? arr : []).map((x) => ({
    entityId: (x.entity_id ?? x.entityId ?? x.id) as string | undefined,
    label: (x.canonical_label ?? x.label ?? x.name ?? x.title ?? '(이름 없음)') as string,
    score: (x.score ?? x.rrf_score ?? x.calibrated_score) as number | undefined,
    region: (x.region ?? x.region_name) as string | undefined,
    price: (x.price_usd ?? x.price) as number | undefined,
  }));
  return { hits, raw: r };
}

export async function fetchReady(): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const res = await fetch('/ready');
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

let _reachable: boolean | null = null;
export async function backendReachable(): Promise<boolean> {
  if (_reachable !== null) return _reachable;
  try {
    // Any HTTP response (even 4xx/5xx) means the backend is there; only a thrown
    // network error means it is not running.
    await fetch('/v2/entity-lookup/ops/coverage-health', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    _reachable = true;
  } catch {
    _reachable = false;
  }
  return _reachable;
}

export function resetReachable(): void {
  _reachable = null;
}

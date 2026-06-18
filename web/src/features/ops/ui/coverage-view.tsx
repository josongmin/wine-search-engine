'use client';

/**
 * Operator coverage/health + alias audit (T-ELV2-07). Shows the curation queue
 * health (counts by status/kind) and, for a given entity, its live aliases plus
 * any proposals touching it. Read-only (X-Debug-Key).
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { api, ApiError } from '@/shared/api/client';
import type { AliasAuditResponse, CoverageHealthResponse } from '@/shared/api/ops-types';
import { Badge, Button, Card, CardContent, CardHeader } from '@/shared/ui';
import { OpsNav } from './ops-nav';
import { OpsKeysPanel, useOpsKeys } from './ops-keys';

export function OpsCoverageView() {
  const keys = useOpsKeys();
  const [health, setHealth] = useState<CoverageHealthResponse | null>(null);
  const [audit, setAudit] = useState<AliasAuditResponse | null>(null);
  const [entityId, setEntityId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadHealth = useCallback(async () => {
    if (keys.debugKey.length === 0) return;
    setError(null);
    try {
      setHealth(await api.ops.coverageHealth(keys.debugKey));
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status} ${e.code}: ${e.message}` : 'Request failed');
    }
  }, [keys.debugKey]);

  useEffect(() => { void loadHealth(); }, [loadHealth]);

  async function runAudit() {
    if (entityId.trim() === '' || keys.debugKey.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      setAudit(await api.ops.aliasAudit(entityId.trim(), keys.debugKey));
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status} ${e.code}: ${e.message}` : 'Request failed');
      setAudit(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <h1 className="text-xl font-bold">Entity Lookup V2 — Ops</h1>
      <OpsNav />
      <OpsKeysPanel keys={keys} />

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card>
        <CardHeader><h2 className="text-sm font-semibold">Curation queue health</h2></CardHeader>
        <CardContent className="text-sm">
          {health ? (
            <div className="grid grid-cols-2 gap-6 font-mono text-xs">
              <div>
                <p className="mb-1 font-semibold">by status</p>
                {Object.entries(health.queue_by_status).map(([k, v]) => (
                  <div key={k} className="flex justify-between"><span className="text-neutral-500">{k}</span><span>{v}</span></div>
                ))}
              </div>
              <div>
                <p className="mb-1 font-semibold">by kind</p>
                {Object.entries(health.queue_by_kind).map(([k, v]) => (
                  <div key={k} className="flex justify-between"><span className="text-neutral-500">{k}</span><span>{v}</span></div>
                ))}
                <div className="mt-2 flex justify-between border-t pt-1"><span className="text-neutral-500">total</span><span>{health.total_proposals}</span></div>
                <div className="mt-2 flex justify-between border-t pt-1 font-semibold text-amber-700 dark:text-amber-400">
                  <span>awaiting materialization</span>
                  <span>{health.published_awaiting_materialization}</span>
                </div>
                <div className="mt-2 flex justify-between border-t pt-1 text-amber-700 dark:text-amber-400">
                  <span>legacy approved abbreviation</span>
                  <span>{health.legacy_approved_abbreviation_backlog}</span>
                </div>
                {health.lookup_runtime != null && (
                  <div className="mt-2 space-y-1 border-t pt-2 text-xs text-neutral-500">
                    <div>snapshot: {health.lookup_runtime.search_snapshot_id ?? '—'}</div>
                    <div>family graph edges: {health.lookup_runtime.family_graph_edge_count}</div>
                    <div>LTR: {health.lookup_runtime.ltr_support_status}</div>
                    {health.lookup_runtime.unwired_substrate_ids.length > 0 && (
                      <div>unwired: {health.lookup_runtime.unwired_substrate_ids.join(', ')}</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : <p className="text-neutral-500">Enter the debug key to load health.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><h2 className="text-sm font-semibold">Alias audit</h2></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <input
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void runAudit(); }}
              placeholder="entity id"
            />
            <Button onClick={() => void runAudit()} disabled={loading || keys.debugKey.length === 0}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              Audit
            </Button>
          </div>
          {audit ? (
            <div className="space-y-3 text-sm">
              <div>
                <h3 className="mb-1 font-semibold">Live aliases ({audit.aliases.length})</h3>
                {audit.aliases.map((a) => (
                  <div key={a.alias_id} className="flex justify-between font-mono text-xs">
                    <span>{a.surface_form}</span>
                    <span className="text-neutral-500">{a.alias_type} · {a.source}</span>
                  </div>
                ))}
              </div>
              <div>
                <h3 className="mb-1 font-semibold">Related proposals ({audit.related_proposals.length})</h3>
                {audit.related_proposals.map((p) => (
                  <div key={p.proposal_id} className="flex items-center gap-2 font-mono text-xs">
                    <Badge>{p.kind}</Badge><span>{p.status}</span><span className="text-neutral-500">{p.proposal_id}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

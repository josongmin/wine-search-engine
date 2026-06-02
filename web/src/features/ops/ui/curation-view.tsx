'use client';

/**
 * Operator curation queue (T-ELV2-07, DoD §2 — alias/ambiguity/suppression run
 * on a staging-based plane). Lists proposals, lets a reviewer approve/reject
 * (pending→approved/rejected) and publish (approved→published), and submit a new
 * alias proposal. Reads use X-Debug-Key; writes use X-Ops-Write-Key.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { api, ApiError } from '@/shared/api/client';
import type { ProposalStatus, ProposalWire } from '@/shared/api/ops-types';
import { Badge, Button, Card, CardContent, CardHeader } from '@/shared/ui';
import { OpsNav } from './ops-nav';
import { OpsKeysPanel, useOpsKeys } from './ops-keys';

const STATUS_VARIANT: Record<ProposalStatus, string> = {
  pending: 'text-amber-700 bg-amber-100',
  approved: 'text-blue-700 bg-blue-100',
  rejected: 'text-red-700 bg-red-100',
  published: 'text-green-700 bg-green-100',
};

function proposalSummary(p: ProposalWire): string {
  switch (p.kind) {
    case 'alias': return `${p.surface_form} → ${p.target_entity_id} (${p.proposed_type})`;
    case 'ambiguity': return `${p.normalized_form} → [${p.member_entity_ids.join(', ')}]`;
    case 'suppression': return `${p.surface_form}${p.target_entity_id ? ` @ ${p.target_entity_id}` : ''}`;
  }
}

export function OpsCurationView() {
  const keys = useOpsKeys();
  const [proposals, setProposals] = useState<ProposalWire[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (keys.debugKey.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.ops.listProposals({ limit: 100 }, keys.debugKey);
      setProposals(res.proposals);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status} ${e.code}: ${e.message}` : 'Request failed');
    } finally {
      setLoading(false);
    }
  }, [keys.debugKey]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function act(p: ProposalWire, action: 'approve' | 'reject' | 'publish') {
    if (keys.writeKey.length === 0) { setError('X-Ops-Write-Key required for writes'); return; }
    setBusyId(p.proposal_id);
    setError(null);
    try {
      if (action === 'publish') {
        await api.ops.publishProposal({ kind: p.kind, proposal_id: p.proposal_id, reviewed_by: 'console' }, keys.writeKey);
      } else {
        await api.ops.reviewProposal(
          { kind: p.kind, proposal_id: p.proposal_id, decision: action, reviewed_by: 'console', decision_reason: `${action} via ops console` },
          keys.writeKey,
        );
      }
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status} ${e.code}: ${e.message}` : 'Request failed');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <h1 className="text-xl font-bold">Entity Lookup V2 — Ops</h1>
      <OpsNav />
      <OpsKeysPanel keys={keys} requireWrite />
      <SubmitAliasForm keys={keys} onSubmitted={() => void refresh()} />

      <Card>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Proposal queue</h2>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          {proposals.length === 0 ? <p className="text-sm text-neutral-500">No proposals.</p> : null}
          {proposals.map((p) => (
            <div key={p.proposal_id} className="flex items-center justify-between gap-2 rounded-md border border-neutral-200 p-2 dark:border-neutral-800">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_VARIANT[p.status]}`}>{p.status}</span>
                  <Badge>{p.kind}</Badge>
                </div>
                <p className="truncate font-mono text-xs">{proposalSummary(p)}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                {p.status === 'pending' ? (
                  <>
                    <Button size="sm" onClick={() => void act(p, 'approve')} disabled={busyId === p.proposal_id}>Approve</Button>
                    <Button size="sm" variant="ghost" onClick={() => void act(p, 'reject')} disabled={busyId === p.proposal_id}>Reject</Button>
                  </>
                ) : null}
                {p.status === 'approved' ? (
                  <Button size="sm" onClick={() => void act(p, 'publish')} disabled={busyId === p.proposal_id}>Publish</Button>
                ) : null}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

const inputClass = 'rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900';

function SubmitAliasForm({ keys, onSubmitted }: { keys: ReturnType<typeof useOpsKeys>; onSubmitted: () => void }) {
  const [surface, setSurface] = useState('');
  const [entity, setEntity] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (keys.writeKey.length === 0) { setErr('X-Ops-Write-Key required'); return; }
    if (surface.trim() === '' || entity.trim() === '') return;
    setBusy(true);
    setErr(null);
    try {
      await api.ops.submitProposal(
        {
          kind: 'alias', surface_form: surface.trim(), target_entity_id: entity.trim(),
          proposed_type: 'misspelling', confidence: 0.8,
          evidence: { source: 'ops_console', note: note.trim() },
          proposed_by: 'console',
        },
        keys.writeKey,
      );
      setSurface(''); setEntity(''); setNote('');
      onSubmitted();
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.status} ${e.code}: ${e.message}` : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader><h2 className="text-sm font-semibold">Submit alias proposal</h2></CardHeader>
      <CardContent className="flex flex-wrap items-end gap-2">
        <input className={inputClass} value={surface} onChange={(e) => setSurface(e.target.value)} placeholder="surface form" />
        <input className={inputClass} value={entity} onChange={(e) => setEntity(e.target.value)} placeholder="target entity id" />
        <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="evidence note" />
        <Button size="sm" onClick={() => void submit()} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null} Submit
        </Button>
        {err ? <p className="w-full text-sm text-red-600">{err}</p> : null}
      </CardContent>
    </Card>
  );
}

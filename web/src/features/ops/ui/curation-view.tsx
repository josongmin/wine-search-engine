'use client';

/**
 * Operator curation console (T-ELV2-07, DoD §2 — alias/ambiguity/suppression on
 * a staging-based plane). Redesigned as a keyword-management workbench:
 *
 *   1. Find a wine by name (no slug memorisation) via the {@link EntityPicker},
 *      which also previews where a surface form currently routes.
 *   2. See that entity's LIVE aliases + any in-flight proposals (alias audit).
 *   3. Add a keyword (alias) bound to the selected entity — typed + scored.
 *   4. Work the proposal queue: approve / reject (pending→…) and publish
 *      (approved→published), with status/kind filters.
 *   5. Advanced: submit ambiguity / suppression proposals.
 *
 * Reads use X-Debug-Key; writes use X-Ops-Write-Key.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, X } from 'lucide-react';
import { api, ApiError } from '@/shared/api/client';
import type {
  AliasAuditResponse,
  ProposalKind,
  ProposalStatus,
  ProposalWire,
  SubmitProposalRequest,
} from '@/shared/api/ops-types';
import { Badge, Button, Card, CardContent, CardHeader } from '@/shared/ui';
import { OpsNav } from './ops-nav';
import { OpsKeysPanel, useOpsKeys, type OpsKeys } from './ops-keys';
import { EntityPicker, type EntityCandidate } from './entity-picker';

const STATUS_VARIANT: Record<ProposalStatus, string> = {
  pending: 'text-amber-700 bg-amber-100',
  approved: 'text-blue-700 bg-blue-100',
  rejected: 'text-red-700 bg-red-100',
  published: 'text-green-700 bg-green-100',
};

/**
 * Alias types an operator can curate by hand. The remaining {@link ALIAS_TYPES}
 * members (`canonical`, `catalog_noise_alias`, `derived_initialism`) are
 * machine-derived at index time and must not be hand-authored here.
 */
const CURATED_ALIAS_TYPES = [
  'misspelling',
  'abbreviation',
  'translation',
  'phonetic',
  'observed_query_alias',
] as const;
const DEFAULT_ALIAS_CONFIDENCE = 0.8;

const inputClass =
  'rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900';

function errMsg(e: unknown): string {
  return e instanceof ApiError ? `${e.status} ${e.code}: ${e.message}` : 'Request failed';
}

function proposalSummary(p: ProposalWire): string {
  switch (p.kind) {
    case 'alias':
      return `${p.surface_form} → ${p.target_entity_id} (${p.proposed_type})`;
    case 'ambiguity':
      return `${p.normalized_form} → [${p.member_entity_ids.join(', ')}]`;
    case 'suppression':
      return `${p.surface_form}${p.target_entity_id ? ` @ ${p.target_entity_id}` : ''}`;
  }
}

export function OpsCurationView() {
  const keys = useOpsKeys();
  const [selected, setSelected] = useState<EntityCandidate | null>(null);
  // Bumped after any write so the queue + audit re-fetch.
  const [revision, setRevision] = useState(0);
  const bump = useCallback(() => setRevision((r) => r + 1), []);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <h1 className="text-xl font-bold">Entity Lookup V2 — Ops</h1>
      <OpsNav />
      <OpsKeysPanel keys={keys} requireWrite />

      <KeywordWorkbench
        keys={keys}
        selected={selected}
        onSelect={setSelected}
        onClear={() => setSelected(null)}
        revision={revision}
        onChanged={bump}
      />

      <ProposalQueue keys={keys} revision={revision} onChanged={bump} />

      <AdvancedProposals keys={keys} onChanged={bump} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Keyword workbench: pick entity → see live aliases → add a keyword           */
/* -------------------------------------------------------------------------- */

function KeywordWorkbench({
  keys,
  selected,
  onSelect,
  onClear,
  revision,
  onChanged,
}: {
  keys: OpsKeys;
  selected: EntityCandidate | null;
  onSelect: (c: EntityCandidate) => void;
  onClear: () => void;
  revision: number;
  onChanged: () => void;
}) {
  const [audit, setAudit] = useState<AliasAuditResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const entityId = selected?.entity_id ?? '';

  const loadAudit = useCallback(async () => {
    if (entityId === '' || keys.debugKey.length === 0) {
      setAudit(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setAudit(await api.ops.aliasAudit(entityId, keys.debugKey));
    } catch (e) {
      setError(errMsg(e));
      setAudit(null);
    } finally {
      setLoading(false);
    }
  }, [entityId, keys.debugKey]);

  // Re-audit whenever the selected entity, the credentials, or a write changes.
  useEffect(() => {
    void loadAudit();
  }, [loadAudit, revision]);

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold">Keyword workbench</h2>
        <p className="text-xs text-neutral-500">
          Find a wine, review its live keywords, then add a new one.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <EntityPicker debugKey={keys.debugKey} onSelect={onSelect} />

        {selected ? (
          <div className="space-y-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{selected.canonical_label}</p>
                <p className="truncate font-mono text-xs text-neutral-500">{selected.entity_id}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={onClear} aria-label="clear selection">
                <X className="size-4" />
              </Button>
            </div>

            {error ? <p className="text-sm text-red-600">{error}</p> : null}

            <div>
              <h3 className="mb-1 text-xs font-semibold">
                Live keywords{' '}
                {loading ? (
                  <Loader2 className="inline size-3 animate-spin" />
                ) : audit ? (
                  `(${audit.aliases.length})`
                ) : null}
              </h3>
              {audit && audit.aliases.length > 0 ? (
                <div className="space-y-0.5">
                  {audit.aliases.map((a) => (
                    <div key={a.alias_id} className="flex justify-between gap-2 font-mono text-xs">
                      <span className="truncate">{a.surface_form}</span>
                      <span className="shrink-0 text-neutral-500">
                        {a.alias_type} · {a.source}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-neutral-500">No live keywords yet.</p>
              )}
            </div>

            {audit && audit.related_proposals.length > 0 ? (
              <div>
                <h3 className="mb-1 text-xs font-semibold">
                  In-flight proposals ({audit.related_proposals.length})
                </h3>
                <div className="space-y-0.5">
                  {audit.related_proposals.map((p) => (
                    <div key={p.proposal_id} className="flex items-center gap-2 font-mono text-xs">
                      <span className={`rounded px-1 ${STATUS_VARIANT[p.status]}`}>{p.status}</span>
                      <Badge>{p.kind}</Badge>
                      <span className="truncate text-neutral-500">{proposalSummary(p)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <AddAliasForm
              keys={keys}
              entity={selected}
              onSubmitted={() => {
                void loadAudit();
                onChanged();
              }}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AddAliasForm({
  keys,
  entity,
  onSubmitted,
}: {
  keys: OpsKeys;
  entity: EntityCandidate;
  onSubmitted: () => void;
}) {
  const [surface, setSurface] = useState('');
  const [type, setType] = useState<(typeof CURATED_ALIAS_TYPES)[number]>('misspelling');
  const [confidence, setConfidence] = useState(String(DEFAULT_ALIAS_CONFIDENCE));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (keys.writeKey.length === 0) {
      setErr('X-Ops-Write-Key required for writes');
      return;
    }
    if (surface.trim() === '') return;
    const conf = Number.parseFloat(confidence);
    if (!Number.isFinite(conf) || conf < 0 || conf > 1) {
      setErr('Confidence must be a number between 0 and 1');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.ops.submitProposal(
        {
          kind: 'alias',
          surface_form: surface.trim(),
          target_entity_id: entity.entity_id,
          proposed_type: type,
          confidence: conf,
          evidence: { source: 'ops_console', note: note.trim() },
          proposed_by: 'console',
        },
        keys.writeKey,
      );
      setSurface('');
      setNote('');
      onSubmitted();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
      <h3 className="text-xs font-semibold">Add keyword</h3>
      <div className="flex flex-wrap items-end gap-2">
        <input
          className={inputClass}
          value={surface}
          onChange={(e) => setSurface(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          placeholder="surface form (e.g. 사씨카이아)"
          aria-label="surface form"
        />
        <select
          className={inputClass}
          value={type}
          onChange={(e) => setType(e.target.value as (typeof CURATED_ALIAS_TYPES)[number])}
          aria-label="alias type"
        >
          {CURATED_ALIAS_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          className={`${inputClass} w-20`}
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={confidence}
          onChange={(e) => setConfidence(e.target.value)}
          aria-label="confidence"
        />
        <input
          className={inputClass}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="evidence note"
          aria-label="evidence note"
        />
        <Button size="sm" onClick={() => void submit()} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null} Add
        </Button>
      </div>
      {err ? <p className="text-sm text-red-600">{err}</p> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Proposal queue with filters + approve/reject/publish                        */
/* -------------------------------------------------------------------------- */

const STATUS_FILTERS: readonly (ProposalStatus | 'all')[] = [
  'all',
  'pending',
  'approved',
  'rejected',
  'published',
];
const KIND_FILTERS: readonly (ProposalKind | 'all')[] = ['all', 'alias', 'ambiguity', 'suppression'];

function ProposalQueue({
  keys,
  revision,
  onChanged,
}: {
  keys: OpsKeys;
  revision: number;
  onChanged: () => void;
}) {
  const [proposals, setProposals] = useState<ProposalWire[]>([]);
  const [statusFilter, setStatusFilter] = useState<ProposalStatus | 'all'>('all');
  const [kindFilter, setKindFilter] = useState<ProposalKind | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (keys.debugKey.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.ops.listProposals(
        {
          limit: 100,
          ...(statusFilter === 'all' ? {} : { status: statusFilter }),
          ...(kindFilter === 'all' ? {} : { kind: kindFilter }),
        },
        keys.debugKey,
      );
      setProposals(res.proposals);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [keys.debugKey, statusFilter, kindFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  async function act(p: ProposalWire, action: 'approve' | 'reject' | 'publish') {
    if (keys.writeKey.length === 0) {
      setError('X-Ops-Write-Key required for writes');
      return;
    }
    setBusyId(p.proposal_id);
    setError(null);
    try {
      if (action === 'publish') {
        await api.ops.publishProposal(
          { kind: p.kind, proposal_id: p.proposal_id, reviewed_by: 'console' },
          keys.writeKey,
        );
      } else {
        await api.ops.reviewProposal(
          {
            kind: p.kind,
            proposal_id: p.proposal_id,
            decision: action,
            reviewed_by: 'console',
            decision_reason: `${action} via ops console`,
          },
          keys.writeKey,
        );
      }
      onChanged();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Proposal queue</h2>
        <div className="flex items-center gap-2">
          <select
            className={inputClass}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as ProposalStatus | 'all')}
            aria-label="filter by status"
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            className={inputClass}
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as ProposalKind | 'all')}
            aria-label="filter by kind"
          >
            {KIND_FILTERS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {proposals.length === 0 ? <p className="text-sm text-neutral-500">No proposals.</p> : null}
        {proposals.map((p) => (
          <div
            key={p.proposal_id}
            className="flex items-center justify-between gap-2 rounded-md border border-neutral-200 p-2 dark:border-neutral-800"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_VARIANT[p.status]}`}>
                  {p.status}
                </span>
                <Badge>{p.kind}</Badge>
              </div>
              <p className="truncate font-mono text-xs">{proposalSummary(p)}</p>
            </div>
            <div className="flex shrink-0 gap-1">
              {p.status === 'pending' ? (
                <>
                  <Button size="sm" onClick={() => void act(p, 'approve')} disabled={busyId === p.proposal_id}>
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void act(p, 'reject')}
                    disabled={busyId === p.proposal_id}
                  >
                    Reject
                  </Button>
                </>
              ) : null}
              {p.status === 'approved' ? (
                <Button size="sm" onClick={() => void act(p, 'publish')} disabled={busyId === p.proposal_id}>
                  Publish
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Advanced: ambiguity + suppression proposals                                 */
/* -------------------------------------------------------------------------- */

function AdvancedProposals({ keys, onChanged }: { keys: OpsKeys; onChanged: () => void }) {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold">Advanced proposals</h2>
        <p className="text-xs text-neutral-500">Ambiguity clusters and surface suppressions.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <AmbiguityForm keys={keys} onSubmitted={onChanged} />
        <SuppressionForm keys={keys} onSubmitted={onChanged} />
      </CardContent>
    </Card>
  );
}

function AmbiguityForm({ keys, onSubmitted }: { keys: OpsKeys; onSubmitted: () => void }) {
  const [form, setForm] = useState('');
  const [members, setMembers] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (keys.writeKey.length === 0) {
      setErr('X-Ops-Write-Key required');
      return;
    }
    const ids = members
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (form.trim() === '' || ids.length < 2) {
      setErr('Normalized form and at least 2 member entity ids are required');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const body: SubmitProposalRequest = {
        kind: 'ambiguity',
        normalized_form: form.trim(),
        member_entity_ids: ids,
        evidence: { source: 'ops_console', note: note.trim() },
        proposed_by: 'console',
      };
      await api.ops.submitProposal(body, keys.writeKey);
      setForm('');
      setMembers('');
      setNote('');
      onSubmitted();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold">Ambiguity cluster</h3>
      <div className="flex flex-wrap items-end gap-2">
        <input
          className={inputClass}
          value={form}
          onChange={(e) => setForm(e.target.value)}
          placeholder="normalized form"
          aria-label="normalized form"
        />
        <input
          className={`${inputClass} min-w-64 flex-1`}
          value={members}
          onChange={(e) => setMembers(e.target.value)}
          placeholder="member entity ids (comma separated, ≥2)"
          aria-label="member entity ids"
        />
        <input
          className={inputClass}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="evidence note"
          aria-label="ambiguity evidence note"
        />
        <Button size="sm" onClick={() => void submit()} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null} Submit
        </Button>
      </div>
      {err ? <p className="text-sm text-red-600">{err}</p> : null}
    </div>
  );
}

function SuppressionForm({ keys, onSubmitted }: { keys: OpsKeys; onSubmitted: () => void }) {
  const [surface, setSurface] = useState('');
  const [entity, setEntity] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (keys.writeKey.length === 0) {
      setErr('X-Ops-Write-Key required');
      return;
    }
    if (surface.trim() === '' || reason.trim() === '') {
      setErr('Surface form and reason are required');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const target = entity.trim();
      // exactOptionalPropertyTypes: omit target_entity_id rather than send undefined.
      const body: SubmitProposalRequest = {
        kind: 'suppression',
        surface_form: surface.trim(),
        reason: reason.trim(),
        evidence: { source: 'ops_console', note: note.trim() },
        proposed_by: 'console',
        ...(target.length > 0 ? { target_entity_id: target } : {}),
      };
      await api.ops.submitProposal(body, keys.writeKey);
      setSurface('');
      setEntity('');
      setReason('');
      setNote('');
      onSubmitted();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
      <h3 className="text-xs font-semibold">Suppression</h3>
      <div className="flex flex-wrap items-end gap-2">
        <input
          className={inputClass}
          value={surface}
          onChange={(e) => setSurface(e.target.value)}
          placeholder="surface form"
          aria-label="suppression surface form"
        />
        <input
          className={inputClass}
          value={entity}
          onChange={(e) => setEntity(e.target.value)}
          placeholder="target entity id (optional)"
          aria-label="suppression target entity id"
        />
        <input
          className={inputClass}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="reason"
          aria-label="suppression reason"
        />
        <input
          className={inputClass}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="evidence note"
          aria-label="suppression evidence note"
        />
        <Button size="sm" onClick={() => void submit()} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null} Submit
        </Button>
      </div>
      {err ? <p className="text-sm text-red-600">{err}</p> : null}
    </div>
  );
}

'use client';

/**
 * Operator decision-spine inspector (T-ELV2-07, DoD §6 — "operator가 query 하나로
 * admission/candidates/scores/decision을 trusted plane에서 본다"). One query →
 * the full V2 decision spine via `POST /v2/entity-lookup/ops/inspect`.
 */

import { useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { api, ApiError } from '@/shared/api/client';
import type { OpsInspectResponse } from '@/shared/api/ops-types';
import { Badge, Button, Card, CardContent, CardHeader } from '@/shared/ui';
import { OpsNav } from './ops-nav';
import { OpsKeysPanel, useOpsKeys } from './ops-keys';

export function OpsInspectView() {
  const keys = useOpsKeys();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<OpsInspectResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    if (query.trim().length === 0 || keys.debugKey.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await api.ops.inspect(query.trim(), keys.debugKey));
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status} ${e.code}: ${e.message}` : 'Request failed');
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <h1 className="text-xl font-bold">Entity Lookup V2 — Ops</h1>
      <OpsNav />
      <OpsKeysPanel keys={keys} />

      <Card>
        <CardContent className="flex gap-2 pt-4">
          <input
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
            placeholder="e.g. dom perignon, opu one, 까쇼"
          />
          <Button onClick={() => void run()} disabled={loading || keys.debugKey.length === 0}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            Inspect
          </Button>
        </CardContent>
      </Card>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {result ? (
        <Card>
          <CardHeader className="flex flex-wrap items-center gap-2">
            <Badge>{result.status}</Badge>
            <span className="text-sm text-neutral-600">{result.decision_reason}</span>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <section>
              <h3 className="mb-1 font-semibold">Evidence</h3>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs">
                <dt className="text-neutral-500">admission</dt><dd>{result.evidence_summary.admission_reason_code}</dd>
                <dt className="text-neutral-500">decision</dt><dd>{result.evidence_summary.decision_reason_code}</dd>
                <dt className="text-neutral-500">query_class</dt><dd>{result.evidence_summary.query_class}</dd>
                <dt className="text-neutral-500">top_confidence</dt><dd>{result.evidence_summary.top_confidence ?? '—'}</dd>
                <dt className="text-neutral-500">top1_top2_margin</dt><dd>{result.evidence_summary.top1_top2_margin ?? '—'}</dd>
                <dt className="text-neutral-500">calibration_trusted</dt><dd>{String(result.evidence_summary.calibration_trusted)}</dd>
                <dt className="text-neutral-500">pool_size</dt><dd>{result.evidence_summary.candidate_pool_size}</dd>
              </dl>
            </section>

            <section>
              <h3 className="mb-1 font-semibold">Channel coverage</h3>
              <table className="w-full text-left font-mono text-xs">
                <thead className="text-neutral-500">
                  <tr><th>channel</th><th>firing</th><th>hits</th><th>latency_ms</th></tr>
                </thead>
                <tbody>
                  {result.evidence_summary.channel_coverage.map((c) => (
                    <tr key={c.channel}>
                      <td>{c.channel}</td><td>{String(c.firing)}</td><td>{c.hit_count}</td><td>{c.latency_ms}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section>
              <h3 className="mb-1 font-semibold">Candidates</h3>
              <ol className="space-y-1">
                {result.candidates.map((c) => (
                  <li key={c.entity_id} className="flex justify-between font-mono text-xs">
                    <span>#{c.rank} {c.canonical_label}</span>
                    <span className="text-neutral-500">{c.calibrated_score.toFixed(3)} · {c.entity_id}</span>
                  </li>
                ))}
              </ol>
            </section>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

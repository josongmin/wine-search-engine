'use client';

/**
 * Reusable entity search/picker for the lookup-V2 ops console.
 *
 * Backs the curation workbench: an operator types a wine name (or a candidate
 * keyword) and the picker runs `POST /v2/entity-lookup/ops/inspect` to surface
 * the ranked candidates with their canonical entity ids — so the operator never
 * has to memorise a slug like `sassicaia-2018`. The inspect status + reason
 * doubles as a live "where does this currently route?" preview, which is the
 * exact signal an operator needs before adding or suppressing an alias.
 *
 * Read-only: uses the X-Debug-Key only.
 */

import { useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { api, ApiError } from '@/shared/api/client';
import type { OpsInspectResponse } from '@/shared/api/ops-types';
import { Button } from '@/shared/ui';

export interface EntityCandidate {
  entity_id: string;
  canonical_label: string;
  calibrated_score: number;
}

const pickerInput =
  'w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900';

export function EntityPicker({
  debugKey,
  onSelect,
  placeholder = 'wine name or keyword to look up',
}: {
  debugKey: string;
  onSelect: (candidate: EntityCandidate) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<OpsInspectResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled = loading || debugKey.length === 0;

  async function run() {
    const q = query.trim();
    if (q === '' || debugKey.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await api.ops.inspect(q, debugKey));
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status} ${e.code}: ${e.message}` : 'Request failed');
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          className={pickerInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run();
          }}
          placeholder={placeholder}
          aria-label="entity search query"
        />
        <Button size="sm" onClick={() => void run()} disabled={disabled}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
          Look up
        </Button>
      </div>

      {debugKey.length === 0 ? (
        <p className="text-xs text-neutral-500">Enter the X-Debug-Key above to search entities.</p>
      ) : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {result ? (
        <div className="space-y-1">
          <p className="text-xs text-neutral-500">
            current routing: <span className="font-mono">{result.status}</span> — {result.decision_reason}
          </p>
          {result.candidates.length === 0 ? (
            <p className="text-sm text-neutral-500">No candidates.</p>
          ) : (
            result.candidates.map((c) => (
              <button
                key={c.entity_id}
                type="button"
                onClick={() =>
                  onSelect({
                    entity_id: c.entity_id,
                    canonical_label: c.canonical_label,
                    calibrated_score: c.calibrated_score,
                  })
                }
                className="flex w-full items-center justify-between gap-2 rounded-md border border-neutral-200 p-2 text-left hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
              >
                <span className="min-w-0 truncate">
                  <span className="text-sm">{c.canonical_label}</span>
                  <span className="ml-2 font-mono text-xs text-neutral-500">{c.entity_id}</span>
                </span>
                <span className="shrink-0 font-mono text-xs text-neutral-500">
                  {c.calibrated_score.toFixed(2)}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

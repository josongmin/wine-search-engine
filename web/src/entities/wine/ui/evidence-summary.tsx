import { useMemo } from 'react';
import type { EvidenceItem } from '@/shared/api';
import { cn } from '@/shared/lib';

interface EvidenceSummaryProps {
  items: readonly EvidenceItem[];
  max?: number;
}

const strengthColor: Record<string, string> = {
  high: 'text-emerald-600',
  medium: 'text-amber-600',
  low: 'text-neutral-400',
};

const STRENGTH_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

export function EvidenceSummary({ items, max = 3 }: EvidenceSummaryProps) {
  // Memoize the sort so we don't allocate a new sorted array on every render.
  const sorted = useMemo(
    () =>
      [...items].sort(
        (a, b) => (STRENGTH_ORDER[a.strength] ?? 3) - (STRENGTH_ORDER[b.strength] ?? 3),
      ),
    [items],
  );

  const visible = sorted.slice(0, max);
  const remaining = sorted.length - max;

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
        Evidence
      </p>
      <ul className="space-y-0.5">
        {visible.map((ev, i) => (
          // Stable composite key so reconciliation doesn't reuse DOM nodes
          // for different evidence after a refetch shuffles the list.
          <li
            key={`${ev.source}:${ev.type}:${ev.provenance}:${i}`}
            className="flex items-center gap-1.5 text-xs"
          >
            <span className={cn('font-mono', strengthColor[ev.strength] ?? 'text-neutral-400')}>
              {ev.contribution}
            </span>
            <span className="text-neutral-600 truncate">{ev.provenance}</span>
          </li>
        ))}
      </ul>
      {remaining > 0 && (
        <p className="text-xs text-neutral-400">+{remaining} more</p>
      )}
    </div>
  );
}

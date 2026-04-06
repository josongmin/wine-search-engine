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

export function EvidenceSummary({ items, max = 3 }: EvidenceSummaryProps) {
  const sorted = [...items].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return (order[a.strength] ?? 3) - (order[b.strength] ?? 3);
  });

  const visible = sorted.slice(0, max);
  const remaining = sorted.length - max;

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
        Evidence
      </p>
      <ul className="space-y-0.5">
        {visible.map((ev, i) => (
          <li key={i} className="flex items-center gap-1.5 text-xs">
            <span className={cn('font-mono', strengthColor[ev.strength] ?? 'text-neutral-400')}>
              {ev.contribution}
            </span>
            <span className="text-neutral-600 truncate">{ev.provenance}</span>
          </li>
        ))}
      </ul>
      {remaining > 0 && (
        <p className="text-[10px] text-neutral-400">+{remaining} more</p>
      )}
    </div>
  );
}

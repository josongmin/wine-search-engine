import type { ResultItem } from '@/shared/api';
import { priceBand } from '@/shared/lib';
import { Badge } from '@/shared/ui';
import { TasteProfileBar } from '@/entities/wine';
import { DrinkingWindowBar } from '@/entities/wine';

interface ComparisonTableProps {
  items: readonly ResultItem[];
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-1">
        {label}
      </dt>
      <dd className="text-sm text-neutral-800">{children}</dd>
    </div>
  );
}

export function ComparisonTable({ items }: ComparisonTableProps) {
  if (items.length < 2) return null;
  const [a, b] = items;

  return (
    <div className="grid grid-cols-[1fr_auto_1fr] gap-4">
      {/* Left wine */}
      <div className="space-y-4 rounded-xl border border-neutral-200 bg-white p-5">
        <h3 className="text-lg font-semibold text-neutral-900 line-clamp-2">
          {a.entity.canonical_label}
        </h3>
        <dl className="space-y-3">
          <Field label="Region">{a.entity.region ?? '—'}</Field>
          <Field label="Producer">{a.entity.producer ?? '—'}</Field>
          <Field label="Grapes">{a.entity.grapes?.join(', ') ?? '—'}</Field>
          <Field label="Vintage">{a.entity.vintage ?? '—'}</Field>
          <Field label="Price">{priceBand(a.entity.price_range)}</Field>
        </dl>
        <TasteProfileBar scores={a.match.score_components} />
        {a.drinking_window && <DrinkingWindowBar window={a.drinking_window} />}
      </div>

      {/* VS divider */}
      <div className="flex items-center">
        <Badge variant="wine" className="text-base px-4 py-2 font-bold">
          VS
        </Badge>
      </div>

      {/* Right wine */}
      <div className="space-y-4 rounded-xl border border-neutral-200 bg-white p-5">
        <h3 className="text-lg font-semibold text-neutral-900 line-clamp-2">
          {b.entity.canonical_label}
        </h3>
        <dl className="space-y-3">
          <Field label="Region">{b.entity.region ?? '—'}</Field>
          <Field label="Producer">{b.entity.producer ?? '—'}</Field>
          <Field label="Grapes">{b.entity.grapes?.join(', ') ?? '—'}</Field>
          <Field label="Vintage">{b.entity.vintage ?? '—'}</Field>
          <Field label="Price">{priceBand(b.entity.price_range)}</Field>
        </dl>
        <TasteProfileBar scores={b.match.score_components} />
        {b.drinking_window && <DrinkingWindowBar window={b.drinking_window} />}
      </div>
    </div>
  );
}

import type { ResultItem } from '@/shared/api';
import { priceBand } from '@/shared/lib';
import { Badge } from '@/shared/ui';
import { TasteProfileBar, DrinkingWindowBar } from '@/entities/wine';

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

function WineColumn({ item }: { item: ResultItem }) {
  const { entity, match, drinking_window } = item;
  return (
    <div className="space-y-4 rounded-xl border border-neutral-200 bg-white p-5">
      <h3 className="text-lg font-semibold text-neutral-900 line-clamp-2">
        {entity.canonical_label}
      </h3>
      <dl className="space-y-3">
        <Field label="Region">{entity.region ?? '—'}</Field>
        <Field label="Producer">{entity.producer ?? '—'}</Field>
        <Field label="Grapes">{entity.grapes?.join(', ') ?? '—'}</Field>
        <Field label="Vintage">{entity.vintage ?? '—'}</Field>
        <Field label="Price">{priceBand(entity.price_range)}</Field>
      </dl>
      <TasteProfileBar scores={match.score_components} />
      {drinking_window && <DrinkingWindowBar window={drinking_window} />}
    </div>
  );
}

export function ComparisonTable({ items }: ComparisonTableProps) {
  if (items.length < 2) return null;
  const [a, b] = items;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_auto_1fr]" role="group" aria-label="와인 비교">
      <WineColumn item={a} />

      {/* VS divider — horizontal on mobile, vertical on desktop */}
      <div className="flex items-center justify-center md:flex-col">
        <Badge variant="wine" className="text-base px-4 py-2 font-bold">
          VS
        </Badge>
      </div>

      <WineColumn item={b} />
    </div>
  );
}

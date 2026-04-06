import { cn } from '@/shared/lib';

interface TasteProfileBarProps {
  scores: {
    lexical: number;
    semantic: number;
    attribute: number;
    popularity: number;
    preference_alignment: number;
  };
}

const BARS = [
  { key: 'lexical' as const, label: 'Lexical', color: 'bg-rose-500' },
  { key: 'semantic' as const, label: 'Semantic', color: 'bg-amber-500' },
  { key: 'attribute' as const, label: 'Attribute', color: 'bg-emerald-500' },
  { key: 'popularity' as const, label: 'Popularity', color: 'bg-blue-500' },
  { key: 'preference_alignment' as const, label: 'Preference', color: 'bg-violet-500' },
] as const;

export function TasteProfileBar({ scores }: TasteProfileBarProps) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
        Score Components
      </p>
      {BARS.map(({ key, label, color }) => {
        const value = scores[key];
        if (value <= 0) return null;
        const width = Math.min(value * 100, 100);
        return (
          <div key={key} className="flex items-center gap-2">
            <span className="w-20 text-xs text-neutral-500 shrink-0 text-right">
              {label}
            </span>
            <div className="h-2 flex-1 rounded-full bg-neutral-100">
              <div
                className={cn('h-2 rounded-full transition-all', color)}
                style={{ width: `${width}%` }}
              />
            </div>
            <span className="w-8 text-xs text-neutral-400 tabular-nums">
              {value.toFixed(2)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

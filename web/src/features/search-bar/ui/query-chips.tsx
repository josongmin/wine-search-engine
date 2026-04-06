'use client';

import { useRouter } from 'next/navigation';
import { searchUrl } from '@/shared/lib';
import { EXAMPLE_QUERIES } from '@/shared/config/constants';
import { cn } from '@/shared/lib';

const CHIP_ICONS = ['🥂', '🍷', '💰', '⚔️', '🌿', '🧀', '🥩', '🎁'] as const;

export function QueryChips() {
  const router = useRouter();

  return (
    <div className="flex flex-wrap justify-center gap-2" role="list" aria-label="예시 검색어">
      {EXAMPLE_QUERIES.map(({ label, query }, i) => (
        <button
          key={label}
          type="button"
          role="listitem"
          onClick={() => router.push(searchUrl(query))}
          className={cn(
            'group inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium',
            'border-border bg-surface text-muted-foreground shadow-sm',
            'transition-all duration-200 cursor-pointer',
            'hover:border-[color:var(--accent)]/40 hover:bg-[color:var(--accent)]/5 hover:text-[color:var(--accent)] hover:shadow-md hover:-translate-y-0.5',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]/40',
            'animate-fade-up',
          )}
          style={{ animationDelay: `${300 + i * 40}ms` }}
        >
          <span className="text-base leading-none">{CHIP_ICONS[i % CHIP_ICONS.length]}</span>
          {label}
        </button>
      ))}
    </div>
  );
}

'use client';

import { cn } from '@/shared/lib';

interface ChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export function Chip({ className, active, children, ...props }: ChipProps) {
  return (
    <button
      type="button"
      className={cn(
        'rounded-full border px-4 py-2 text-sm font-medium shadow-sm transition-all cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 focus-visible:ring-offset-2',
        active
          ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300'
          : 'border-border bg-surface text-muted-foreground hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 dark:hover:border-rose-800 dark:hover:bg-rose-950 dark:hover:text-rose-300',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

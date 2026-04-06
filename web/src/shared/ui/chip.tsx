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
          ? 'border-rose-300 bg-rose-50 text-rose-700'
          : 'border-neutral-200 bg-white text-neutral-600 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

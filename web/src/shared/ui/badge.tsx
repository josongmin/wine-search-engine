import { type VariantProps, cva } from 'class-variance-authority';
import { cn } from '@/shared/lib';

const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-neutral-100 text-neutral-800',
        success: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20',
        warning: 'bg-amber-50 text-amber-700 ring-1 ring-amber-600/20',
        danger: 'bg-red-50 text-red-700 ring-1 ring-red-600/20',
        info: 'bg-blue-50 text-blue-700 ring-1 ring-blue-600/20',
        wine: 'bg-rose-50 text-rose-700 ring-1 ring-rose-600/20',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

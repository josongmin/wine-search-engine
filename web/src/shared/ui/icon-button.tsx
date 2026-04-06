import { forwardRef } from 'react';
import { type VariantProps, cva } from 'class-variance-authority';
import { cn } from '@/shared/lib';

const iconButtonVariants = cva(
  'inline-flex items-center justify-center rounded-full transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
        positive: 'text-muted-foreground hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950 dark:hover:text-emerald-400',
        negative: 'text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400',
      },
      size: {
        sm: 'h-7 w-7',
        md: 'h-9 w-9',
      },
      active: {
        true: '',
        false: '',
      },
    },
    compoundVariants: [
      { variant: 'positive', active: true, className: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400' },
      { variant: 'negative', active: true, className: 'bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400' },
      { variant: 'ghost', active: true, className: 'bg-muted text-foreground' },
    ],
    defaultVariants: { variant: 'ghost', size: 'sm', active: false },
  },
);

interface IconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color'>,
    VariantProps<typeof iconButtonVariants> {}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant, size, active, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      className={cn(iconButtonVariants({ variant, size, active }), className)}
      {...props}
    />
  ),
);
IconButton.displayName = 'IconButton';

import { forwardRef } from 'react';
import { type VariantProps, cva } from 'class-variance-authority';
import { cn } from '@/shared/lib';

const iconButtonVariants = cva(
  'inline-flex items-center justify-center rounded-full transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        ghost: 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600',
        positive: 'text-neutral-400 hover:bg-emerald-50 hover:text-emerald-600',
        negative: 'text-neutral-400 hover:bg-red-50 hover:text-red-600',
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
      { variant: 'positive', active: true, className: 'bg-emerald-100 text-emerald-600' },
      { variant: 'negative', active: true, className: 'bg-red-100 text-red-600' },
      { variant: 'ghost', active: true, className: 'bg-neutral-200 text-neutral-800' },
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

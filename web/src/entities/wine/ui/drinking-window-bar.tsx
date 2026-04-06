import { cn } from '@/shared/lib';
import type { DrinkingWindowBlock } from '@/shared/api';
import { Badge } from '@/shared/ui';

interface DrinkingWindowBarProps {
  window: DrinkingWindowBlock;
}

export function DrinkingWindowBar({ window: dw }: DrinkingWindowBarProps) {
  const currentYear = new Date().getFullYear();
  const rangeStart = dw.drinking_window_start;
  const rangeEnd = dw.drinking_window_end;

  // Compute bar positions (0-100%)
  const timelineStart = Math.min(rangeStart, currentYear) - 2;
  const timelineEnd = Math.max(rangeEnd, currentYear) + 2;
  const span = timelineEnd - timelineStart;

  const barLeft = ((rangeStart - timelineStart) / span) * 100;
  const barWidth = ((rangeEnd - rangeStart) / span) * 100;
  const nowPos = ((currentYear - timelineStart) / span) * 100;
  const peakPos = dw.peak_year
    ? ((dw.peak_year - timelineStart) / span) * 100
    : undefined;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
          Drinking Window
        </p>
        <Badge variant={dw.currently_drinkable ? 'success' : 'warning'}>
          {dw.currently_drinkable ? '지금 마시기 좋은 시기' : '숙성 대기'}
        </Badge>
      </div>
      <div className="relative h-4 rounded-full bg-neutral-100">
        {/* Drinkable range */}
        <div
          className="absolute top-0 h-4 rounded-full bg-emerald-200"
          style={{ left: `${barLeft}%`, width: `${barWidth}%` }}
        />
        {/* Peak marker */}
        {peakPos !== undefined && (
          <div
            className="absolute top-0 h-4 w-0.5 bg-emerald-600"
            style={{ left: `${peakPos}%` }}
          />
        )}
        {/* Current year marker */}
        <div
          className={cn(
            'absolute -top-0.5 h-5 w-0.5',
            dw.currently_drinkable ? 'bg-neutral-800' : 'bg-amber-500',
          )}
          style={{ left: `${nowPos}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-neutral-400">
        <span>{rangeStart}</span>
        {dw.peak_year && <span className="text-emerald-600">peak {dw.peak_year}</span>}
        <span>{rangeEnd}</span>
      </div>
    </div>
  );
}

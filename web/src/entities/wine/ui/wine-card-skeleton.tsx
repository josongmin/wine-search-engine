import { Card, CardHeader, CardContent, Skeleton } from '@/shared/ui';
import { cn } from '@/shared/lib';

interface WineCardSkeletonProps {
  compact?: boolean;
}

export function WineCardSkeleton({ compact }: WineCardSkeletonProps) {
  if (compact) {
    return (
      <div className="rounded-2xl overflow-hidden border border-border bg-surface">
        <Skeleton className="w-full" style={{ aspectRatio: '4/3' }} />
        <div className="p-3 space-y-2">
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-3 w-3/5" />
          <Skeleton className="h-1.5 w-full rounded-full" />
        </div>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className={cn('space-y-2 flex-1')}>
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
          <Skeleton className="h-6 w-12 rounded-full" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-2 w-4/5" />
            <Skeleton className="h-2 w-3/5" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-4 w-full rounded-full" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

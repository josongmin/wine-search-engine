'use client';

import { useEntityResolve } from '@/entities/wine';
import { WineDetailPanel } from '@/widgets/wine-detail-panel';
import { Skeleton } from '@/shared/ui';
import { AlertTriangle } from 'lucide-react';

interface WineDetailViewProps {
  entityId: string;
}

export function WineDetailView({ entityId }: WineDetailViewProps) {
  const { data, isLoading, error } = useEntityResolve(entityId);

  if (isLoading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center" role="alert">
        <AlertTriangle className="h-10 w-10 text-red-400" aria-hidden="true" />
        <p className="text-sm text-red-600">
          와인 정보를 불러올 수 없습니다.
        </p>
      </div>
    );
  }

  return (
    <WineDetailPanel
      source={{ kind: 'entity', data }}
    />
  );
}

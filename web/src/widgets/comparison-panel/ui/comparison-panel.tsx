'use client';

import { useSearchParams } from 'next/navigation';
import { useSearch } from '@/features/search-bar';
import { ComparisonTable } from '@/features/comparison';
import { WineCardSkeleton } from '@/entities/wine';

export function ComparisonPanel() {
  const searchParams = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const { data, isLoading } = useSearch(query);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4">
        <WineCardSkeleton />
        <WineCardSkeleton />
      </div>
    );
  }

  if (!data || data.results.length < 2) return null;

  return <ComparisonTable items={data.results} />;
}

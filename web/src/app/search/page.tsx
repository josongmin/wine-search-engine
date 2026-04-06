import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SearchResultsView } from '@/widgets/search-results';
import { WineCardSkeleton } from '@/entities/wine';

export const metadata: Metadata = {
  title: '검색 결과',
};

function SearchFallback() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 3 }, (_, i) => (
        <WineCardSkeleton key={i} />
      ))}
    </div>
  );
}

export default function SearchPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Suspense fallback={<SearchFallback />}>
        <SearchResultsView />
      </Suspense>
    </div>
  );
}

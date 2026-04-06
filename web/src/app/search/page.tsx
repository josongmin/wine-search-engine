import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SearchResultsView } from '@/widgets/search-results';
import { WineCardSkeleton } from '@/entities/wine';

export const metadata: Metadata = {
  title: '검색 결과',
};

function SearchFallback() {
  return (
    <div className="masonry px-4 pt-4 pb-36">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="masonry-item">
          <WineCardSkeleton />
        </div>
      ))}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<SearchFallback />}>
      <SearchResultsView />
    </Suspense>
  );
}

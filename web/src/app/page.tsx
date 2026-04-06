import { Suspense } from 'react';
import { Wine } from 'lucide-react';
import { SearchInput, QueryChips } from '@/features/search-bar';
import { SITE_DESCRIPTION } from '@/shared/config/constants';

export default function HomePage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-24">
      <div className="w-full max-w-2xl space-y-8 text-center">
        {/* Hero */}
        <div className="space-y-3">
          <Wine className="mx-auto h-12 w-12 text-rose-500" />
          <h1 className="text-3xl font-bold tracking-tight text-neutral-900 sm:text-4xl">
            {SITE_DESCRIPTION}
          </h1>
          <p className="text-neutral-500">
            자연어로 검색하세요 — 비교, 페어링, 산지 탐색까지
          </p>
        </div>

        {/* Search */}
        <Suspense>
          <SearchInput size="lg" autoFocus />
        </Suspense>

        {/* Example chips */}
        <QueryChips />
      </div>
    </div>
  );
}

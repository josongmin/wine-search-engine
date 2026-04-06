'use client';

import { Suspense } from 'react';
import { SearchInput } from '@/features/search-bar';

export function FloatingSearchBar() {
  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50 pointer-events-none"
      style={{
        background: 'linear-gradient(to top, var(--background) 40%, transparent)',
        paddingTop: '3rem',
        paddingBottom: '1.25rem',
      }}
    >
      <div className="mx-auto flex w-full max-w-2xl items-center px-4 pointer-events-auto">
        <Suspense>
          <SearchInput size="floating" />
        </Suspense>
      </div>
    </div>
  );
}

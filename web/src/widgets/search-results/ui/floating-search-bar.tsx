'use client';

import { Suspense } from 'react';
import { SearchInput } from '@/features/search-bar';

export function FloatingSearchBar() {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 flex justify-center px-4 pb-6 pt-8 pointer-events-none"
      style={{
        background: 'linear-gradient(to top, var(--background) 50%, transparent)',
      }}
    >
      <div className="w-full max-w-xl pointer-events-auto animate-float-in">
        <Suspense>
          <SearchInput size="floating" />
        </Suspense>
      </div>
    </div>
  );
}

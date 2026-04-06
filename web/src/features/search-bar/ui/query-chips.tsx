'use client';

import { useRouter } from 'next/navigation';
import { searchUrl } from '@/shared/lib';
import { Chip } from '@/shared/ui';
import { EXAMPLE_QUERIES } from '@/shared/config/constants';

export function QueryChips() {
  const router = useRouter();

  return (
    <div className="flex flex-wrap justify-center gap-2" role="list" aria-label="예시 검색어">
      {EXAMPLE_QUERIES.map(({ label, query }) => (
        <Chip
          key={label}
          onClick={() => router.push(searchUrl(query))}
          role="listitem"
        >
          {label}
        </Chip>
      ))}
    </div>
  );
}

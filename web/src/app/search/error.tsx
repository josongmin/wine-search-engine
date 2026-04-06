'use client';

import { useEffect } from 'react';
import { AlertTriangle, Search } from 'lucide-react';
import { Button } from '@/shared/ui';

interface SearchErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function SearchErrorPage({ error, reset }: SearchErrorPageProps) {
  useEffect(() => {
    console.error('[SearchError]', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex flex-col items-center gap-4 py-16 text-center" role="alert">
        <AlertTriangle className="h-10 w-10 text-red-400" aria-hidden="true" />
        <h2 className="text-lg font-semibold text-foreground">
          검색 중 오류가 발생했습니다
        </h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          검색 엔진에 일시적인 문제가 있을 수 있습니다. 잠시 후 다시 시도해 주세요.
        </p>
        <div className="flex gap-3">
          <Button onClick={reset} variant="primary" size="sm">
            <Search className="h-4 w-4" aria-hidden="true" />
            다시 검색
          </Button>
        </div>
      </div>
    </div>
  );
}

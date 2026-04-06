'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/shared/ui';

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    console.error('[ErrorBoundary]', error);
  }, [error]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-24 text-center">
      <AlertTriangle className="h-12 w-12 text-red-400 mb-4" aria-hidden="true" />
      <h2 className="text-xl font-semibold text-foreground mb-2">
        문제가 발생했습니다
      </h2>
      <p className="text-sm text-muted-foreground mb-6 max-w-md">
        페이지를 불러오는 중 오류가 발생했습니다. 아래 버튼을 눌러 다시 시도해 주세요.
      </p>
      {error.digest && (
        <p className="text-xs text-muted-foreground mb-4 font-mono">
          Error ID: {error.digest}
        </p>
      )}
      <Button onClick={reset} variant="primary">
        다시 시도
      </Button>
    </div>
  );
}

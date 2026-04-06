'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/shared/ui';

interface WineErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function WineErrorPage({ error, reset }: WineErrorPageProps) {
  useEffect(() => {
    console.error('[WineDetailError]', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex flex-col items-center gap-4 py-16 text-center" role="alert">
        <AlertTriangle className="h-10 w-10 text-red-400" aria-hidden="true" />
        <h2 className="text-lg font-semibold text-foreground">
          와인 정보를 불러올 수 없습니다
        </h2>
        <p className="text-sm text-muted-foreground">
          요청하신 와인이 존재하지 않거나 일시적인 오류가 발생했습니다.
        </p>
        <div className="flex gap-3">
          <Button onClick={reset} variant="secondary" size="sm">
            다시 시도
          </Button>
          <Link href="/">
            <Button variant="primary" size="sm">
              홈으로
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, X, RefreshCw } from 'lucide-react';
import { api } from '@/shared/api';

type Status = 'unknown' | 'up' | 'down';

const POLL_INTERVAL_MS = 30_000;

export function HealthBanner() {
  const [status, setStatus] = useState<Status>('unknown');
  const [dismissed, setDismissed] = useState(false);

  async function check() {
    try {
      await api.health.check();
      setStatus('up');
      setDismissed(false); // auto-recover
    } catch {
      setStatus('down');
    }
  }

  useEffect(() => {
    check();
    const t = setInterval(check, POLL_INTERVAL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status !== 'down' || dismissed) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-50/80 dark:bg-amber-950/40 px-5 py-2.5 text-sm text-amber-800 dark:text-amber-300 backdrop-blur-sm"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>백엔드 서버에 연결할 수 없습니다. 검색이 동작하지 않을 수 있습니다.</span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={check}
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
          aria-label="연결 재시도"
        >
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
          재시도
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded-lg p-1 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
          aria-label="닫기"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

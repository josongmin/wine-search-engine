'use client';

import { Heart } from 'lucide-react';
import { Button } from '@/shared/ui';
import { useWatchlistCreate } from '@/features/watchlist';

interface WatchlistButtonProps {
  entityId: string;
}

export function WatchlistButton({ entityId }: WatchlistButtonProps) {
  const { mutate, isPending, isSuccess, isError } = useWatchlistCreate();

  const handleAdd = () => {
    mutate({
      entity_id: entityId,
      trigger_conditions: [{ type: 'new_vintage' }],
      callback_url: 'https://placeholder.example.com/webhook',
    });
  };

  if (isSuccess) {
    return (
      <Button variant="ghost" size="sm" disabled aria-label="워치리스트에 추가됨">
        <Heart className="h-4 w-4 fill-rose-500 text-rose-500" aria-hidden="true" />
        추가됨
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={handleAdd}
        disabled={isPending}
        aria-label="워치리스트에 추가"
      >
        <Heart className="h-4 w-4" aria-hidden="true" />
        워치리스트
      </Button>
      {isError && (
        <span className="text-xs text-red-500" role="alert">추가 실패</span>
      )}
    </div>
  );
}

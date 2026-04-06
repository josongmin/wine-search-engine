'use client';

import { Trash2, Bell } from 'lucide-react';
import { Card, CardContent, IconButton, Badge } from '@/shared/ui';
import { useWatchlist, useWatchlistDelete } from '../model/use-watchlist';

export function WatchlistList() {
  const { data, isLoading, error } = useWatchlist();
  const deleteMutation = useWatchlistDelete();

  if (isLoading) {
    return <p className="text-sm text-neutral-500">로딩 중...</p>;
  }

  if (error) {
    return (
      <div role="alert" className="text-center py-8">
        <p className="text-sm text-red-600">워치리스트를 불러올 수 없습니다.</p>
        <p className="text-xs text-neutral-400 mt-1">잠시 후 다시 시도해 주세요.</p>
      </div>
    );
  }

  if (!data || data.entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <Bell className="h-10 w-10 text-neutral-300" aria-hidden="true" />
        <p className="text-sm text-neutral-500">아직 워치리스트가 비어있습니다.</p>
        <p className="text-xs text-neutral-400">
          와인 상세 페이지에서 관심 와인을 추가해 보세요.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3" role="list" aria-label="워치리스트 항목">
      {data.entries.map((entry) => (
        <Card key={entry.watchlist_id} role="listitem">
          <CardContent className="flex items-center justify-between gap-4 py-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-neutral-900 truncate">
                {entry.entity_id}
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {entry.trigger_conditions.map((t, i) => (
                  <Badge key={i} variant="info">
                    {t.type.replace(/_/g, ' ')}
                  </Badge>
                ))}
              </div>
              <p className="mt-1 text-xs text-neutral-400">
                {new Date(entry.created_at).toLocaleDateString('ko-KR')}
              </p>
            </div>
            <IconButton
              variant="ghost"
              size="md"
              onClick={() => deleteMutation.mutate(entry.watchlist_id)}
              disabled={deleteMutation.isPending}
              aria-label={`${entry.entity_id} 워치리스트에서 삭제`}
            >
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

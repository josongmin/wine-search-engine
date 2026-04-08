'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/shared/api';
import type { WatchlistCreateRequest, WatchlistEntry, WatchlistListResponse } from '@/shared/api';
import { getSubjectId } from '@/shared/lib/subject';

// Subject ID is part of the cache key so a subject rotation (storage cleared,
// new ephemeral ID under SSR) cannot leak the previous user's entries to the
// next subject sharing the same browser instance.
function watchlistKey(): readonly unknown[] {
  if (typeof window === 'undefined') return ['watchlist', 'ssr'] as const;
  try {
    return ['watchlist', getSubjectId()] as const;
  } catch {
    return ['watchlist', 'unavailable'] as const;
  }
}

export function useWatchlist() {
  return useQuery({
    queryKey: watchlistKey(),
    queryFn: ({ signal }) => api.watchlist.list({ signal }),
    staleTime: 30_000,
  });
}

export function useWatchlistCreate() {
  const qc = useQueryClient();
  const key = watchlistKey();
  return useMutation({
    mutationFn: (body: WatchlistCreateRequest) => api.watchlist.create(body),
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useWatchlistDelete() {
  const qc = useQueryClient();
  const key = watchlistKey();
  return useMutation<void, Error, string, { previous: WatchlistListResponse | undefined }>({
    mutationFn: (id: string) => api.watchlist.delete(id),
    // Optimistic update: snapshot, write removed entry, rollback on error.
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<WatchlistListResponse>(key);
      if (previous) {
        qc.setQueryData<WatchlistListResponse>(key, {
          ...previous,
          entries: previous.entries.filter((e: WatchlistEntry) => e.watchlist_id !== id),
          total: Math.max(0, previous.total - 1),
        });
      }
      return { previous };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous !== undefined) {
        qc.setQueryData(key, ctx.previous);
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

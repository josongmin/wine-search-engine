'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/shared/api';
import type { WatchlistCreateRequest } from '@/shared/api';

const WATCHLIST_KEY = ['watchlist'] as const;

export function useWatchlist() {
  return useQuery({
    queryKey: WATCHLIST_KEY,
    queryFn: () => api.watchlist.list(),
    staleTime: 30_000,
  });
}

export function useWatchlistCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: WatchlistCreateRequest) => api.watchlist.create(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}

export function useWatchlistDelete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.watchlist.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}

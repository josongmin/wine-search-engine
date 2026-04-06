'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/shared/api';
import type { SearchRequest, SearchResponse } from '@/shared/api';
import { getSessionId } from '@/shared/lib';

export function useSearch(query: string, enabled = true) {
  return useQuery<SearchResponse>({
    queryKey: ['search', query],
    queryFn: () => {
      const body: SearchRequest = {
        query,
        options: { mode: 'auto', explain: true, clarification: true },
        session_context: { session_id: getSessionId() },
      };
      return api.search(body);
    },
    enabled: enabled && query.trim().length > 0,
    staleTime: 2 * 60 * 1000,
    retry: 1,
  });
}

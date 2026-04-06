'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/shared/api';

export function useEntityResolve(query: string, enabled = true) {
  return useQuery({
    queryKey: ['entity-resolve', query],
    queryFn: () => api.entityResolve({ query }),
    enabled: enabled && query.length > 0,
    staleTime: 5 * 60 * 1000,
  });
}

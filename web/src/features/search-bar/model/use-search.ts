'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/shared/api';
import type { SearchRequest, SearchResponse } from '@/shared/api';

const MAX_QUERY_LENGTH = 500;

/**
 * Sanitize a user-supplied query before it leaves the browser.
 * Strips control chars (log injection / header tricks) and clamps length
 * so a giant clipboard paste cannot blow up the request.
 */
function sanitizeQuery(input: string): string {
  return input
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

export function useSearch(query: string, enabled = true) {
  const safeQuery = sanitizeQuery(query);
  return useQuery<SearchResponse>({
    // Endpoint + mode are part of the cache key so /v1/search and
    // /v1/search/hybrid (or different option modes) can never share.
    queryKey: ['search', '/v1/search', 'auto', safeQuery],
    queryFn: ({ signal }) => {
      const body: SearchRequest = {
        query: safeQuery,
        options: { mode: 'auto', explain: true, clarification: true },
      };
      return api.search(body, { signal });
    },
    enabled: enabled && safeQuery.length >= 2,
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    retry: 1,
  });
}

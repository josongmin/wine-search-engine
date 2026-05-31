'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/shared/api';
import type { SearchRequest, SearchResponse } from '@/shared/api';

/**
 * SSoT: Must match server's MAX_QUERY_LENGTH (src/domain/shared/constants.ts).
 * QueryStringSchema.max(500) — the server rejects queries longer than this.
 */
const MAX_QUERY_LENGTH = 500;

/**
 * SSoT: Must match server's QueryStringSchema.min(1).
 * The server accepts queries as short as 1 character (single-char CJK characters
 * like "酒" are legitimate searches). Previous value of 2 silently blocked
 * valid 1-char queries at the client without a server rejection.
 */
const MIN_QUERY_LENGTH = 1;

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
    // Endpoint is part of the cache key so primitive routes never alias.
    queryKey: ['search', '/v1/search/hybrid', safeQuery],
    queryFn: ({ signal }) => {
      const body: SearchRequest = {
        query: safeQuery,
      };
      return api.search(body, { signal });
    },
    // T-E9-02: Query length gate matches server's QueryStringSchema.min(1).
    // Previously gated at >= 2, silently blocking valid 1-char queries.
    enabled: enabled && safeQuery.length >= MIN_QUERY_LENGTH,
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    retry: 1,
  });
}

// Exported for test parity assertions (T-E9-02).
export { MAX_QUERY_LENGTH, MIN_QUERY_LENGTH, sanitizeQuery };

/** Build search page URL — single source of truth for query parameter format. */
export function searchUrl(query: string): string {
  return `/search?q=${encodeURIComponent(query.trim())}`;
}

/** Build wine detail page URL. */
export function wineDetailUrl(entityId: string): string {
  return `/wine/${encodeURIComponent(entityId)}`;
}

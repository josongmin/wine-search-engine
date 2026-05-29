const GENERIC_WINE_NOUN_TOKENS = new Set([
  'wine',
  'wines',
  '와인',
]);

export function isGenericWineNounToken(token: string): boolean {
  return GENERIC_WINE_NOUN_TOKENS.has(token);
}

export function isShortEntityLikeSurface(normalizedQuery: string): boolean {
  const tokens = normalizedQuery
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens.length > 2) {
    return false;
  }
  return !tokens.some((token) => isGenericWineNounToken(token));
}

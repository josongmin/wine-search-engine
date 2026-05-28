import type { EnrichedSilverRecord } from '../etl/types.js';
import { containsHangul } from '../../src/domain/shared/utils/hangul.js';

const LATIN_SCRIPT_RE = /\p{Script=Latin}/u;
const VINTAGE_TOKEN_RE = /\b(?:19|20)\d{2}\b/u;

export function inferGoldenQueryLanguage(query: string): 'en' | 'ko' | 'mixed' {
  const hasHangul = containsHangul(query);
  const hasLatin = LATIN_SCRIPT_RE.test(query);
  if (hasHangul && hasLatin) return 'mixed';
  if (hasHangul) return 'ko';
  return 'en';
}

export function hasExactEntityVintageToken(query: string): boolean {
  return VINTAGE_TOKEN_RE.test(query);
}

export function selectExactEntityGoldenQuerySurface(
  record: Pick<EnrichedSilverRecord, 'canonicalLabel'>,
): string | null {
  const query = record.canonicalLabel.trim();
  if (!hasExactEntityVintageToken(query)) {
    return null;
  }
  return query;
}

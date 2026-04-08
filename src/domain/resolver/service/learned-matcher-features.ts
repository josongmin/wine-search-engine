/**
 * Feature extraction for learned entity matchers (Track E, Epic 18).
 *
 * Computes a feature vector from a raw query string and a candidate label,
 * for use as input signals to the learned matcher model (RFC-006 section 5.2).
 */

export interface MatcherFeatureVector {
  readonly charNgramOverlap: number;
  readonly tokenCoverage: number;
  readonly vintageConsistency: boolean;
  readonly scriptCompatibility: number;
  readonly provenanceStage: string;
  readonly queryCompactLength: number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const TRIGRAM_SIZE = 3;

/** Partial credit when scripts differ or either side is mixed-script. */
const SCRIPT_COMPATIBILITY_PARTIAL = 0.5;

/**
 * Extracts character n-grams (trigrams) from a lowercased string.
 */
function charNgrams(text: string, n: number): Set<string> {
  const lower = text.toLowerCase();
  const grams = new Set<string>();
  for (let i = 0; i <= lower.length - n; i++) {
    grams.add(lower.slice(i, i + n));
  }
  return grams;
}

/**
 * Jaccard similarity: |A & B| / |A | B|
 */
function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;

  let intersectionSize = 0;
  for (const item of a) {
    if (b.has(item)) {
      intersectionSize++;
    }
  }

  const unionSize = a.size + b.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/**
 * Simple whitespace tokenizer that lowercases and strips empty tokens.
 */
function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Extracts a 4-digit vintage year from a string, if present.
 */
function extractVintage(text: string): number | null {
  const match = /(?<!\p{L}\p{N})((?:19|20)\d{2})(?!\p{L}\p{N})/u.exec(text);
  if (match?.[1] === undefined) return null;
  return Number.parseInt(match[1], 10);
}

// Unicode block detection
const HANGUL_RANGE = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF\uD7B0-\uD7FF]/;
const LATIN_RANGE = /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/;

const enum ScriptKind {
  Latin = 'latin',
  Hangul = 'hangul',
  Other = 'other',
  Mixed = 'mixed',
}

function detectScript(text: string): ScriptKind {
  const hasLatin = LATIN_RANGE.test(text);
  const hasHangul = HANGUL_RANGE.test(text);

  if (hasLatin && hasHangul) return ScriptKind.Mixed;
  if (hasLatin) return ScriptKind.Latin;
  if (hasHangul) return ScriptKind.Hangul;
  return ScriptKind.Other;
}

/**
 * Compact form: strip whitespace and accents, lowercase.
 * Used for queryCompactLength.
 */
function compactForm(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Computes a feature vector for the learned matcher from a query and
 * candidate label pair.
 *
 * @param query - The raw user query.
 * @param candidateLabel - The canonical label of the candidate entity.
 * @param candidateVintage - The vintage year of the candidate, if known.
 * @returns A fully populated feature vector.
 */
export function computeMatcherFeatures(
  query: string,
  candidateLabel: string,
  candidateVintage?: number,
): MatcherFeatureVector {
  // Character trigram Jaccard overlap
  const queryGrams = charNgrams(query, TRIGRAM_SIZE);
  const candidateGrams = charNgrams(candidateLabel, TRIGRAM_SIZE);
  const charNgramOverlap = jaccardSimilarity(queryGrams, candidateGrams);

  // Token coverage: fraction of query tokens found in candidate label
  const queryTokens = tokenize(query);
  const candidateTokens = new Set(tokenize(candidateLabel));
  const matchedTokenCount = queryTokens.filter((t) => candidateTokens.has(t)).length;
  const tokenCoverage = queryTokens.length === 0 ? 0 : matchedTokenCount / queryTokens.length;

  // Vintage consistency
  const queryVintage = extractVintage(query);
  let vintageConsistency: boolean;
  if (queryVintage === null) {
    // No vintage in query means no conflict
    vintageConsistency = true;
  } else if (candidateVintage !== undefined) {
    vintageConsistency = queryVintage === candidateVintage;
  } else {
    // Try to extract vintage from candidate label
    const labelVintage = extractVintage(candidateLabel);
    vintageConsistency = labelVintage === null || queryVintage === labelVintage;
  }

  // Script compatibility
  const queryScript = detectScript(query);
  const candidateScript = detectScript(candidateLabel);
  let scriptCompatibility: number;
  if (queryScript === candidateScript) {
    scriptCompatibility = 1.0;
  } else if (queryScript === ScriptKind.Mixed || candidateScript === ScriptKind.Mixed) {
    scriptCompatibility = SCRIPT_COMPATIBILITY_PARTIAL;
  } else {
    scriptCompatibility = SCRIPT_COMPATIBILITY_PARTIAL;
  }

  // Provenance stage — determined later by the resolver; default to 'unknown'
  const provenanceStage = 'unknown';

  // Compact query length
  const queryCompactLength = compactForm(query).length;

  return {
    charNgramOverlap,
    tokenCoverage,
    vintageConsistency,
    scriptCompatibility,
    provenanceStage,
    queryCompactLength,
  };
}

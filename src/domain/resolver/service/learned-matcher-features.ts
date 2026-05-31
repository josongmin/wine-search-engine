/**
 * Feature extraction for learned entity matchers (Track E, Epic 18).
 *
 * Computes a feature vector from a raw query string and a candidate label,
 * for use as input signals to the learned matcher model (RFC-006 section 5.2).
 */

import { extractVintageYear } from '../../shared/utils/vintage.js';

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

/**
 * Partial credit when one side is mixed-script (e.g. "Sassicaia 사시카이아"
 * vs "Sassicaia"): some character-level script overlap exists, so the signal
 * is partial but non-trivial.
 */
const SCRIPT_COMPATIBILITY_PARTIAL = 0.5;

/**
 * Partial credit when the two sides use fully disjoint scripts and neither is
 * mixed — e.g. a pure-Hangul query ("사시카이아") against a pure-Latin canonical
 * label ("Sassicaia"). This is a legitimate transliteration match path in the
 * Korean wine domain, so it MUST stay strictly above zero (we still want such
 * candidates to surface).
 *
 * NOTE (train/serve skew): this value is intentionally kept EQUAL to
 * SCRIPT_COMPATIBILITY_PARTIAL (0.5). `scriptCompatibility` is shipped verbatim
 * as `script_compatibility` to the external learned-matcher model for inference
 * (see http-learned-matcher.ts ~L180). The deployed model was trained on the
 * distribution where mixed and disjoint both emit 0.5; lowering disjoint to a
 * weaker value (e.g. 0.25) without retraining introduces train/serve skew that
 * can suppress the core Korean→Latin transliteration recall (사시카이아→Sassicaia).
 * The named constant is retained so the disjoint branch stays semantically
 * distinct and can diverge from PARTIAL once (and only once) the model is
 * retrained on the new feature distribution.
 */
const SCRIPT_COMPATIBILITY_DISJOINT = 0.5;

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
 * Delegates to the SSoT vintage utility for the regex source.
 */
function extractVintage(text: string): number | null {
  return extractVintageYear(text);
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
    // One side carries multiple scripts → partial script overlap is possible.
    scriptCompatibility = SCRIPT_COMPATIBILITY_PARTIAL;
  } else {
    // Fully disjoint single scripts (e.g. Hangul query vs Latin label):
    // a non-zero transliteration signal. Currently equal to the mixed case to
    // match the deployed model's training distribution — see
    // SCRIPT_COMPATIBILITY_DISJOINT for the train/serve-skew rationale.
    scriptCompatibility = SCRIPT_COMPATIBILITY_DISJOINT;
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

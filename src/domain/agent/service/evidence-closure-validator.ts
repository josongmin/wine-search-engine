/**
 * ADR-009 Phase 0 follow-up: evidence-closure validator.
 *
 * Verifies that a synthesized answer is **closed** under the supporting
 * `ToolCallEvidenceFrame[]` — i.e. that entity claims in the answer are
 * traceable to at least one frame's structured output. This is the
 * mechanical safety net for "did the agent hallucinate an entity that
 * never appeared in any tool result?".
 *
 * Heuristic v1 (intentionally minimal):
 *   - Extract entity-shaped tokens from the answer (canonical entity IDs
 *     and proper-noun-ish runs of word characters / Hangul / accented
 *     Latin of length ≥ 2).
 *   - For each token, the validator passes iff the token (case-insensitive
 *     for Latin, exact for Hangul/CJK) appears in the concatenated
 *     `observationSnapshot` of any frame, OR in any structured field that
 *     can carry an entity name (`entityId`, `entity.canonicalLabel`,
 *     `entity.producer`).
 *   - Vacuous case: empty frames AND empty answer → closed=true.
 *   - Answers with no entity-shaped tokens → closed=true (no claims to
 *     close over).
 *
 * Future work (out of v1 scope, tracked in evidence-frames.yaml
 * known_limitations): semantic entailment via LLM, fuzzy alias matching,
 * Korean morphological normalization beyond exact substring.
 */

import type {
  ToolCallEvidenceFrame,
  ToolCallStructuredOutput,
} from '../model/tool-call-evidence-frame.js';

interface EvidenceClosureResult {
  readonly closed: boolean;
  readonly hallucinations?: readonly string[];
}

/** Minimum length for a token to be considered an entity-name candidate.
 *  1-character runs are below the noise floor (Korean particles, single
 *  Latin letters in punctuation). */
const ENTITY_TOKEN_MIN_LEN = 2;

/** Cap on extracted tokens per answer — prevents pathological
 *  long-answer cases from blowing up the validator. */
const MAX_TOKENS_CHECKED = 256;

/** Minimum digit-run length to treat as an entity-relevant numeric
 *  (vintage year). 1-3 digit numbers are too noisy (volumes, prices,
 *  star ratings). */
const ENTITY_DIGIT_RUN_MIN_LEN = 4;

/** Common English/Latin stop-words that look like word-runs but never
 *  carry entity meaning. Lowercase. We intentionally do NOT block
 *  domain-relevant terms like "wine", "red", "white" — those may be
 *  legitimate entity attributes. Keep the list tight and high-precision. */
const LATIN_STOPWORDS = new Set([
  'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'as',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their',
  'this', 'that', 'these', 'those',
  'do', 'does', 'did', 'have', 'has', 'had',
  'can', 'could', 'will', 'would', 'should', 'may', 'might', 'must',
  'not', 'no', 'yes',
  'so', 'if', 'than', 'then', 'because', 'while', 'when', 'where', 'how', 'why', 'what',
  'all', 'any', 'some', 'one', 'two', 'both', 'each', 'every',
  'great', 'good', 'best', 'better', 'nice', 'try', 'like', 'love',
  'recommend', 'suggest', 'pair', 'pairs', 'pairing',
  'wine', 'wines', 'bottle', 'glass', 'vintage', 'year',
]);

/** Korean particles/suffixes that can stick to entity names. We treat
 *  them as a strip-set so "오푸스" survives "오푸스를". */
const KOREAN_PARTICLES = [
  '으로', '이라', '에서', '에게', '한테',
  '은', '는', '이', '가', '을', '를', '의', '도', '만', '과', '와', '에', '로',
];

/** Korean verb / sentence endings — tokens ending in these are likely
 *  predicates, not entity names. Used to filter out "추천합니다",
 *  "좋아요", etc. from the entity-candidate list. */
const KOREAN_VERB_ENDINGS = [
  '습니다', '합니다', '됩니다', '입니다',
  '했어요', '해요', '예요', '이에요',
  '했다', '한다', '된다',
  '같다', '같아요', '같습니다',
];

/** Hangul (Korean) character range — used to detect non-ASCII tokens that
 *  may carry trailing particles. Uses Unicode script escape (CLAUDE.md
 *  rule 8: non-ASCII regex requires `/u`). */
function isHangulHeavy(s: string): boolean {
  return /\p{Script=Hangul}/u.test(s);
}

/** Strip a trailing Korean particle if present. Returns the original
 *  string when no particle is found or stripping would drop below
 *  `ENTITY_TOKEN_MIN_LEN`. */
function stripKoreanParticle(token: string): string {
  for (const particle of KOREAN_PARTICLES) {
    if (token.length > particle.length + 1 && token.endsWith(particle)) {
      return token.slice(0, -particle.length);
    }
  }
  return token;
}

/**
 * Extract entity-shaped tokens from a free-form string. Uses Unicode
 * property escapes so Hangul / accented Latin survive (CLAUDE.md rule 8:
 * `\b` is ASCII-only).
 *
 * Entity-shaped means one of:
 *   - starts with an uppercase letter (Latin proper noun heuristic), OR
 *   - contains any non-ASCII letter (Hangul/CJK/accented Latin — case
 *     distinction does not exist), OR
 *   - contains a hyphen or apostrophe (canonical IDs, "d'Avola"), OR
 *   - contains a digit (vintage years bound to a producer context;
 *     filtered to ≥4-digit numbers to avoid noise).
 *
 * Common English stop-words are filtered out (LATIN_STOPWORDS).
 */
function extractEntityTokens(text: string): readonly string[] {
  const tokenRegex = /[\p{L}\p{N}_'-]+/gu;
  const matches = text.match(tokenRegex) ?? [];
  const out: string[] = [];
  for (const raw of matches) {
    let token = raw;
    if (isHangulHeavy(token)) {
      token = stripKoreanParticle(token);
    }
    if (token.length < ENTITY_TOKEN_MIN_LEN) continue;

    // ASCII-only test: token contains no non-ASCII letters/digits.
    // Using a Unicode property negation avoids the no-control-regex lint
    // false positive that triggers on the literal `\x00-\x7F` range.
    const isAsciiOnly = !/[^\p{ASCII}]/u.test(token);
    const hasUpperStart = /^[A-Z]/.test(token);
    const hasHyphenOrApos = /[-']/.test(token);
    const isDigitRun = /^\d+$/.test(token);
    const isLongDigit = isDigitRun && token.length >= ENTITY_DIGIT_RUN_MIN_LEN;

    let entityShaped = false;
    if (!isAsciiOnly) {
      // Hangul / CJK / accented Latin — assume entity-relevant unless
      // the token clearly carries a Korean verb/predicate ending.
      const isKoreanVerb =
        isHangulHeavy(token) &&
        KOREAN_VERB_ENDINGS.some((suffix) => token.endsWith(suffix));
      entityShaped = !isKoreanVerb;
    } else if (hasUpperStart) {
      entityShaped = true;
    } else if (hasHyphenOrApos && !isDigitRun) {
      entityShaped = true;
    } else if (isLongDigit) {
      entityShaped = true;
    }
    if (!entityShaped) continue;

    if (isAsciiOnly && LATIN_STOPWORDS.has(token.toLowerCase())) continue;

    out.push(token);
    if (out.length >= MAX_TOKENS_CHECKED) break;
  }
  return out;
}

/** Build the case-folded haystack from a single frame's structured output
 *  and observation snapshot. */
function frameHaystack(frame: ToolCallEvidenceFrame): string {
  const parts: string[] = [frame.observationSnapshot];
  const so: ToolCallStructuredOutput = frame.structuredOutput;
  if (so.kind === 'search_result_set' || so.kind === 'food_pairing') {
    for (const item of so.resultSet) {
      // resultSet is `readonly ResultItem[]` at the type level, but the
      // runtime Zod schema accepts `z.array(z.unknown())` because the
      // ResultItem shape is owned by the response domain. Walk
      // defensively to tolerate non-canonical shapes (e.g. test fixtures,
      // schema drift caught by the validator's adjacent invariants).
      const candidate: unknown = item;
      if (candidate === null || typeof candidate !== 'object') continue;
      const entity = (candidate as { entity?: unknown }).entity;
      if (entity === null || typeof entity !== 'object') continue;
      for (const key of ['entityId', 'canonicalLabel', 'producer', 'region', 'appellation']) {
        const v = (entity as Record<string, unknown>)[key];
        if (typeof v === 'string') parts.push(v);
      }
    }
  } else if (so.kind === 'drinking_window') {
    parts.push(so.entityId);
  }
  return parts.join('\n').toLowerCase();
}

/**
 * Check that every entity-shaped token in `answer` appears in at least
 * one frame's haystack. Case-folded for Latin; exact for non-ASCII (the
 * `.toLowerCase()` call is a no-op on Hangul / CJK).
 */
export function validateEvidenceClosure(
  answer: string,
  frames: readonly ToolCallEvidenceFrame[],
): EvidenceClosureResult {
  // Vacuous: no answer to validate.
  if (answer.trim().length === 0) {
    return { closed: true };
  }

  const tokens = extractEntityTokens(answer);
  if (tokens.length === 0) {
    // No entity-shaped claims — trivially closed.
    return { closed: true };
  }

  if (frames.length === 0) {
    // Answer carries entity tokens but no frames support it.
    return { closed: false, hallucinations: tokens };
  }

  const haystacks = frames.map(frameHaystack);
  const hallucinations: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const needle = token.toLowerCase();
    if (seen.has(needle)) continue;
    seen.add(needle);
    let found = false;
    for (const h of haystacks) {
      if (h.includes(needle)) {
        found = true;
        break;
      }
    }
    if (!found) hallucinations.push(token);
  }

  if (hallucinations.length === 0) {
    return { closed: true };
  }
  return { closed: false, hallucinations };
}

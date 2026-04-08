/**
 * Tracks remaining budget (steps, time) for an agent run.
 * Immutable — each check returns a new state.
 */

import { createHash } from 'node:crypto';
import type { AgentConfig } from '../model/agent-config.js';
import type { AgentTerminationReason } from '../model/agent-step.js';
import { canonicalJsonStringify } from '../../shared/utils/canonical-json.js';

export interface BudgetCheck {
  readonly allowed: boolean;
  readonly reason?: AgentTerminationReason | undefined;
}

/** Minimum per-tool invocation cap. Adaptive formula scales with maxSteps:
 *  max(MIN_PER_TOOL_CALL_CAP, ceil(maxSteps * PER_TOOL_CALL_CAP_RATIO)).
 *  With maxSteps=8: cap=5; maxSteps=6: cap=4; maxSteps=5: cap=3; maxSteps=3: cap=3.
 *  Prevents runaway thrashing while allowing nested_condition scenarios that
 *  legitimately need 4+ search calls (initial + constraint relaxation iterations). */
const MIN_PER_TOOL_CALL_CAP = 3;
/** Fraction of maxSteps used to compute the adaptive per-tool cap. Set at 0.6
 *  so that at maxSteps=8 the cap is 5 (enough for initial + 4 relaxation passes)
 *  while keeping a meaningful guard against runaway reformulation. */
const PER_TOOL_CALL_CAP_RATIO = 0.6;

/** Trigram Jaccard threshold for near-duplicate query detection. Adaptive:
 *  0.6 for short strings (< 15 chars) where n-gram overlap is naturally
 *  lower, 0.7 for longer strings. Catches "Opus One 2018" / "Opus One wine"
 *  without false-positiving semantically distinct queries. */
const NEAR_DUPLICATE_JACCARD_SHORT = 0.6;
const NEAR_DUPLICATE_JACCARD_LONG = 0.7;
/** Strings shorter than this use bigrams and a lower Jaccard threshold.
 *  Tuned at 10 after calibration: "2018 one opus" (13 chars) must use
 *  trigrams so vintage-distinct queries aren't false-positived, while
 *  short Korean queries like "와인 추천" (5 chars) benefit from bigrams. */
const SHORT_STRING_THRESHOLD = 10;

/** Max recursion depth for manual canonicalization before hashing subtree. */
const MANUAL_CANONICALIZE_MAX_DEPTH = 32;
/** Hex prefix length of SHA-256 digest in depth-limit sentinel (collision resistance vs size). */
const MANUAL_CANONICALIZE_DEPTH_HASH_PREFIX_CHARS = 16;
/** Treat string as Hangul-dominant when this fraction of chars are Hangul/Jamo. */
const HANGUL_DOMINANCE_RATIO = 0.5;
/** Unicode: first Hangul syllable (가). */
const UNICODE_HANGUL_SYLLABLE_FIRST = 0xAC00;
/** Unicode: last Hangul syllable (힣). */
const UNICODE_HANGUL_SYLLABLE_LAST = 0xD7A3;
/** Unicode: Hangul Jamo block start. */
const UNICODE_HANGUL_JAMO_FIRST = 0x1100;
/** Unicode: Hangul Jamo block end. */
const UNICODE_HANGUL_JAMO_LAST = 0x11FF;
/** Unicode: Hangul compatibility Jamo start. */
const UNICODE_HANGUL_COMPAT_JAMO_FIRST = 0x3130;
/** Unicode: Hangul compatibility Jamo end. */
const UNICODE_HANGUL_COMPAT_JAMO_LAST = 0x318F;

/**
 * Tool-input keys that contribute to loop-detection normalization. Limiting
 * the surface to a known allowlist prevents adversarial padding attacks
 * (e.g. `{query: "x", _pad: "alpha beta gamma..."}`) that would otherwise
 * dilute the trigram set and bypass near-duplicate detection.
 */
const QUERY_BEARING_KEYS: ReadonlySet<string> = new Set([
  'query',
  'query_a',
  'query_b',
  'food',
  'color',
  'entity_id',
]);

export class StepBudget {
  private readonly startTime: number;
  private stepCount = 0;
  /** Tracks tool+input pairs to detect exact-match infinite loops. */
  private readonly seenActions = new Set<string>();
  /** Per-tool invocation counter (regardless of input). */
  private readonly perToolCallCounts = new Map<string, number>();
  /** Per-tool history of normalized query strings for near-duplicate check.
   *  Bounded to perToolCallCap entries — older history is subsumed. */
  private readonly perToolNormalizedQueries = new Map<string, string[]>();
  /** Adaptive per-tool call cap: max(MIN_PER_TOOL_CALL_CAP, ceil(maxSteps * 0.6)). */
  private readonly perToolCallCap: number;

  constructor(private readonly config: AgentConfig) {
    this.startTime = Date.now();
    this.perToolCallCap = Math.max(MIN_PER_TOOL_CALL_CAP, Math.ceil(this.config.maxSteps * PER_TOOL_CALL_CAP_RATIO));
  }

  /** Check if another step is allowed. */
  canProceed(): BudgetCheck {
    if (this.stepCount >= this.config.maxSteps) {
      return { allowed: false, reason: 'max_steps' };
    }
    if (Date.now() - this.startTime > this.config.agentTimeoutMs) {
      return { allowed: false, reason: 'timeout' };
    }
    return { allowed: true };
  }

  /**
   * Record a step and check for loops.
   *
   * DRY-RUN PATTERN: every check runs against current state without mutation.
   * State (stepCount, seenActions, perToolCallCounts, perToolNormalizedQueries)
   * is updated only when the call is allowed. Rejected calls do NOT advance
   * step counters or pollute history — this fixes the off-by-one where blocked
   * steps consumed the agent's budget early and made later identical calls
   * misclassify as "exact loop" when they were really "per-tool cap exceeded".
   */
  recordStep(tool: string, input: Record<string, unknown>): BudgetCheck {
    // Canonical serialization for exact-key dedup.
    const sortedInput = canonicalizeForLoopKey(input);
    const key = `${tool}:${sortedInput}`;
    if (this.seenActions.has(key)) {
      return { allowed: false, reason: 'loop_detected' };
    }

    // Per-tool call cap — catches reformulation thrashing that exact-key
    // dedup misses (e.g. search_wines("Opus One"), search_wines("Opus 2018"),
    // search_wines("Opus One wine") all distinct under canonical key).
    const projectedPerToolCount = (this.perToolCallCounts.get(tool) ?? 0) + 1;
    if (projectedPerToolCount > this.perToolCallCap) {
      return { allowed: false, reason: 'loop_detected' };
    }

    // Near-duplicate check: trigram Jaccard ≥ 0.7 against any prior call to
    // the same tool, restricted to query-bearing keys (anti-padding).
    const normalizedQuery = normalizeQueryForLoopDetection(input);
    if (normalizedQuery.length > 0) {
      const priorQueries = this.perToolNormalizedQueries.get(tool) ?? [];
      const threshold = normalizedQuery.length < SHORT_STRING_THRESHOLD
        ? NEAR_DUPLICATE_JACCARD_SHORT
        : NEAR_DUPLICATE_JACCARD_LONG;
      for (const prior of priorQueries) {
        const similarity = trigramJaccard(normalizedQuery, prior);
        if (similarity >= threshold) {
          return { allowed: false, reason: 'loop_detected' };
        }
      }
    }

    // ALL CHECKS PASSED — now mutate state.
    this.stepCount++;
    this.seenActions.add(key);
    this.perToolCallCounts.set(tool, projectedPerToolCount);
    if (normalizedQuery.length > 0) {
      const priorQueries = this.perToolNormalizedQueries.get(tool) ?? [];
      priorQueries.push(normalizedQuery);
      // Bound history to perToolCallCap entries — older entries can never
      // affect a future allow/deny decision because the cap fires first.
      while (priorQueries.length > this.perToolCallCap) {
        priorQueries.shift();
      }
      this.perToolNormalizedQueries.set(tool, priorQueries);
    }

    return { allowed: true };
  }

  getElapsedMs(): number {
    return Date.now() - this.startTime;
  }

  getStepCount(): number {
    return this.stepCount;
  }
}

/**
 * Always-deterministic key generator for loop detection. Prefers
 * canonicalJsonStringify (deep key sort, throws on non-POJO/NaN/Infinity).
 * On failure, falls back to a manual deep-sorted serialization that survives
 * non-POJO inputs (Date, Map) WITHOUT order-sensitivity — the previous
 * JSON.stringify fallback was order-dependent, defeating loop detection
 * for exactly the adversarial inputs the fix was meant to address.
 */
function canonicalizeForLoopKey(value: unknown): string {
  try {
    return canonicalJsonStringify(value);
  } catch {
    return manualCanonicalize(value);
  }
}

function manualCanonicalize(value: unknown, depth = 0): string {
  if (depth > MANUAL_CANONICALIZE_MAX_DEPTH) {
    // Distinct subtrees beyond depth 32 must NOT all collapse to one sentinel,
    // or an adversarial LLM could evade loop detection by burying differences
    // beneath a sufficiently nested wrapper. Hash with SHA-256 (collision-
    // resistant against adversarial input — FNV-1a was crackable in ~65k tries).
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      // Circular reference: include identity hint so distinct circular
      // subtrees don't all collapse to the same key.
      if (value !== null && typeof value === 'object') {
        serialized = `circular:${value.constructor.name}:${Object.keys(value).sort().join(',')}`;
      } else {
        serialized = `unserializable:${typeof value}`;
      }
    }
    const h = createHash('sha256').update(serialized).digest('hex').slice(0, MANUAL_CANONICALIZE_DEPTH_HASH_PREFIX_CHARS);
    return `"[depth-limit:${h}]"`;
  }
  if (value === null) return 'null';
  if (value === undefined) return '"[undefined]"';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `"[${String(value)}]"`;
    return String(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return `[${value.map((v) => manualCanonicalize(v, depth + 1)).join(',')}]`;
  }
  if (typeof value === 'object') {
    if (value instanceof Date) return `"[Date:${value.toISOString()}]"`;
    if (value instanceof Map) {
      const entries = Array.from(value.entries())
        .map(([k, v]) => `${manualCanonicalize(k, depth + 1)}:${manualCanonicalize(v, depth + 1)}`)
        .sort();
      return `"[Map:${entries.join(',')}]"`;
    }
    if (value instanceof Set) {
      const items = Array.from(value.values())
        .map((v) => manualCanonicalize(v, depth + 1))
        .sort();
      return `"[Set:${items.join(',')}]"`;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${manualCanonicalize(obj[k], depth + 1)}`).join(',')}}`;
  }
  return `"[${typeof value}]"`;
}

/**
 * Extract a normalized query string from the tool input for near-duplicate
 * loop detection. Restricted to QUERY_BEARING_KEYS so an adversarial LLM
 * cannot dilute the trigram set with throwaway keys (anti-padding):
 *
 *   { query: string }            — direct query
 *   { query_a, query_b }         — comparison pair (joined)
 *   { food, color }              — pairing tool
 *   { entity_id }                — drinking-window check
 *
 * Unknown / non-allowlisted keys are ignored. Numeric query values (e.g.
 * vintage years inside a query field) are still collected; non-allowlisted
 * keys (limit, max_price, etc.) are not.
 *
 * Normalization: NFKC, lowercase, strip non-letter/digit, collapse whitespace,
 * tokenize, sort tokens. Word reordering can't dodge the check.
 */
function normalizeQueryForLoopDetection(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === 'string') parts.push(v);
    else if (typeof v === 'number') parts.push(String(v));
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v !== null && typeof v === 'object') {
      for (const val of Object.values(v as Record<string, unknown>)) collect(val);
    }
  };
  for (const [key, value] of Object.entries(input)) {
    if (QUERY_BEARING_KEYS.has(key)) collect(value);
  }
  const joined = parts.join(' ');
  if (joined.length === 0) return '';
  // NFKC + lowercase + strip non-alphanumeric (keep Korean syllables via \p{L}/\p{N}).
  const normalized = joined
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((tok) => tok.length > 0)
    .sort()
    .join(' ');
  return normalized;
}

/**
 * Trigram Jaccard similarity in [0, 1]. 1 = identical, 0 = no shared trigrams.
 * Used for near-duplicate query detection in loop guard.
 *
 * Trigrams are sliding 3-character windows. Strings shorter than 3 chars
 * fall back to character-set Jaccard.
 */
function trigramJaccard(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const triA = trigramSet(a);
  const triB = trigramSet(b);
  if (triA.size === 0 || triB.size === 0) return 0;
  let intersection = 0;
  for (const t of triA) {
    if (triB.has(t)) intersection++;
  }
  const union = triA.size + triB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function trigramSet(s: string): Set<string> {
  const set = new Set<string>();
  if (s.length < 2) {
    for (const ch of s) set.add(ch);
    return set;
  }
  // Adaptive n-gram size:
  //   - Hangul-dominant (>50%) or short strings (<15 chars): bigrams (n=2)
  //     because Korean syllables are information-dense and trigrams of 3
  //     Hangul chars give too few overlapping n-grams to detect near-dupes.
  //   - Longer ASCII-dominant: trigrams (n=3) for standard behaviour.
  const isHangulDominant = countHangulChars(s) > s.length * HANGUL_DOMINANCE_RATIO;
  const isShort = s.length < SHORT_STRING_THRESHOLD; // 10 chars
  const n = (isHangulDominant || isShort) ? 2 : 3;
  for (let i = 0; i <= s.length - n; i++) {
    set.add(s.slice(i, i + n));
  }
  return set;
}

function countHangulChars(s: string): number {
  let count = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    // Hangul syllables U+AC00–U+D7A3, Jamo U+1100–U+11FF, Compatibility Jamo U+3130–U+318F
    if (
      (code >= UNICODE_HANGUL_SYLLABLE_FIRST && code <= UNICODE_HANGUL_SYLLABLE_LAST)
      || (code >= UNICODE_HANGUL_JAMO_FIRST && code <= UNICODE_HANGUL_JAMO_LAST)
      || (code >= UNICODE_HANGUL_COMPAT_JAMO_FIRST && code <= UNICODE_HANGUL_COMPAT_JAMO_LAST)
    ) {
      count++;
    }
  }
  return count;
}

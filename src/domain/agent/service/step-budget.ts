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

/** Per-tool maximum invocation count — prevents runaway thrashing even when
 *  the LLM reformulates the query each time. Tuned conservatively at 3 to
 *  allow legitimate "search → drill-in → refine" but block "search × N". */
const PER_TOOL_CALL_CAP = 3;

/** Trigram Jaccard threshold for near-duplicate query detection. 0.7 catches
 *  "Opus One 2018" / "Opus One" / "Opus One wine" without false-positiving
 *  semantically distinct queries that share a few tokens. */
const NEAR_DUPLICATE_JACCARD = 0.7;

export class StepBudget {
  private readonly startTime: number;
  private stepCount = 0;
  /** Tracks tool+input pairs to detect exact-match infinite loops. */
  private readonly seenActions = new Set<string>();
  /** Per-tool invocation counter (regardless of input). */
  private readonly perToolCallCounts = new Map<string, number>();
  /** Per-tool history of normalized query strings for near-duplicate check. */
  private readonly perToolNormalizedQueries = new Map<string, string[]>();

  constructor(private readonly config: AgentConfig) {
    this.startTime = Date.now();
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

  /** Record a step and check for loops. Returns false if loop detected. */
  recordStep(tool: string, input: Record<string, unknown>): BudgetCheck {
    this.stepCount++;
    // Canonical serialization: sort keys recursively (including nested objects).
    // Both the primary path (canonicalJsonStringify) and the fallback
    // (manualCanonicalize for non-POJO/NaN/Infinity) are deep-key-sorted, so
    // an adversarial LLM cannot evade loop detection by reordering keys or
    // by injecting Date/Map/Set into tool input.
    const sortedInput = canonicalizeForLoopKey(input);
    const key = `${tool}:${sortedInput}`;
    if (this.seenActions.has(key)) {
      return { allowed: false, reason: 'loop_detected' };
    }
    this.seenActions.add(key);

    // Per-tool call cap — catches reformulation thrashing that exact-key
    // dedup misses (e.g. search_wines("Opus One"), search_wines("Opus 2018"),
    // search_wines("Opus One wine") all distinct under canonical key).
    const perToolCount = (this.perToolCallCounts.get(tool) ?? 0) + 1;
    this.perToolCallCounts.set(tool, perToolCount);
    if (perToolCount > PER_TOOL_CALL_CAP) {
      return { allowed: false, reason: 'loop_detected' };
    }

    // Near-duplicate check: trigram Jaccard ≥ 0.7 against any prior call to
    // the same tool. The agent prompt allows ONE broaden-and-retry; the third
    // semantically-equivalent attempt is a thrash.
    const normalizedQuery = normalizeQueryForLoopDetection(input);
    if (normalizedQuery.length > 0) {
      const priorQueries = this.perToolNormalizedQueries.get(tool) ?? [];
      for (const prior of priorQueries) {
        const similarity = trigramJaccard(normalizedQuery, prior);
        if (similarity >= NEAR_DUPLICATE_JACCARD) {
          return { allowed: false, reason: 'loop_detected' };
        }
      }
      priorQueries.push(normalizedQuery);
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
  if (depth > 32) {
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
    const h = createHash('sha256').update(serialized).digest('hex').slice(0, 16);
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
 * loop detection. Handles the most common shapes:
 *   { query: string }            — direct query
 *   { query_a, query_b }         — comparison pair (joined)
 *   { food, color, max_price }   — pairing tool
 *   { entity_id }                — drinking-window check
 *
 * Normalization: NFKC, lowercase, strip non-letter/digit, collapse whitespace,
 * and tokenize. Tokens sorted so word reordering doesn't dodge the check.
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
  collect(input);
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
  if (s.length < 3) {
    for (const ch of s) set.add(ch);
    return set;
  }
  // Korean has high information density per syllable — trigrams of 3 Hangul
  // syllables represent ~12 chars worth of meaning, giving very few overlapping
  // n-grams between near-duplicates. Use bigrams for Hangul-dominated strings
  // to keep similarity comparable to Latin trigrams.
  const isHangulDominant = countHangulChars(s) > s.length * 0.5;
  const n = isHangulDominant ? 2 : 3;
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
      (code >= 0xAC00 && code <= 0xD7A3)
      || (code >= 0x1100 && code <= 0x11FF)
      || (code >= 0x3130 && code <= 0x318F)
    ) {
      count++;
    }
  }
  return count;
}

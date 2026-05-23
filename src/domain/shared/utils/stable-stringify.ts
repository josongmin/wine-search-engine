/**
 * Deterministic JSON stringify — SSoT.
 *
 * Produces a canonical JSON string for hashing / cache-key construction.
 * Object keys are sorted lexicographically at every depth; arrays preserve
 * their order; primitives serialize as `JSON.stringify` would. `undefined`
 * properties are dropped (matching `JSON.stringify`'s own behavior);
 * circular references throw — they are a programming error.
 *
 * This MUST be deterministic across processes and platforms — callers use
 * the output to compute content-addressed cache keys (tool result cache).
 * A bug that produces collisions for distinct inputs would mix up cached
 * results across queries.
 *
 * Why not `JSON.stringify`? `{a:1,b:2}` and `{b:2,a:1}` serialize to
 * different strings under the default stringify because key insertion order
 * is preserved. We need order-independence.
 *
 * Why a leaf module under `domain/shared/utils/`? Used by the tool-result
 * cache (application layer) AND the Redis adapter (infrastructure layer) —
 * CLAUDE.md rule 30 (cross-module constants/utilities live in shared SSoT).
 */

export function stableStringify(value: unknown): string {
  return stringifyInner(value, new Set<object>());
}

function stringifyInner(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null'; // align with JSON.stringify
  const t = typeof value;
  if (t === 'number') {
    const n = value as number;
    return Number.isFinite(n) ? JSON.stringify(n) : 'null';
  }
  if (t === 'boolean') return value === true ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (t === 'bigint') return JSON.stringify((value as bigint).toString());

  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('stableStringify: circular reference');
    seen.add(value);
    const parts = value.map((v) => stringifyInner(v, seen));
    seen.delete(value);
    return `[${parts.join(',')}]`;
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) throw new Error('stableStringify: circular reference');
    seen.add(obj);
    // Lexicographic key order. Default Array.sort with no comparator is
    // unsafe in general, but for the strings emitted by `Object.keys` (no
    // negative numbers, no NaN, no surrogate hazards beyond a single shard)
    // the lexicographic default IS the intent. We pass an explicit
    // comparator anyway to satisfy `require-array-sort-compare`.
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue; // mirror JSON.stringify: drop undefined props
      parts.push(`${JSON.stringify(k)}:${stringifyInner(v, seen)}`);
    }
    seen.delete(obj);
    return `{${parts.join(',')}}`;
  }

  // Functions, symbols → treat as missing (JSON.stringify drops them too).
  return 'null';
}

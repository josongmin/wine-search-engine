/**
 * T04-2: Silent-skip observability counters.
 *
 * Pipeline code paths that swallow errors or filter out malformed inputs
 * with `continue` / early return have historically been invisible to ops:
 * the request returns a partial result and no metric ever fires. This
 * module provides a lightweight in-process counter that each such site
 * increments, turning silent skips into observable signals.
 *
 * Usage:
 *   import { globalSilentSkipCounter } from '@observability/silent-skip-counters.js';
 *   globalSilentSkipCounter.increment('embedding_dim_mismatch', { expected, got });
 *
 * The counter is module-scoped mutable state — intentional: a single
 * process-wide tally is the point. Tests should call `reset()` between
 * cases via `createSilentSkipCounter()` for isolation or the global's
 * `reset()` in `beforeEach`.
 */
import { bootstrapLogger } from '../config/bootstrap-logger.js';

export type SilentSkipKind =
  | 'embedding_dim_mismatch'
  | 'embedding_empty_vector'
  | 'cache_write_failure'
  | 'cache_read_failure'
  | 'unknown_channel_fallback'
  | 'json_parse_failure';

/** All known kinds — used for snapshot initialization and validation. */
const SILENT_SKIP_KINDS: readonly SilentSkipKind[] = [
  'embedding_dim_mismatch',
  'embedding_empty_vector',
  'cache_write_failure',
  'cache_read_failure',
  'unknown_channel_fallback',
  'json_parse_failure',
] as const;

const SILENT_SKIP_KIND_SET: ReadonlySet<string> = new Set(SILENT_SKIP_KINDS);

export interface SilentSkipCounter {
  increment(
    kind: SilentSkipKind,
    context?: Readonly<Record<string, string | number>>,
  ): void;
  snapshot(): Readonly<Record<SilentSkipKind, number>>;
  reset(): void;
}

function createZeroedCounts(): Record<SilentSkipKind, number> {
  const counts = {} as Record<SilentSkipKind, number>;
  for (const kind of SILENT_SKIP_KINDS) {
    counts[kind] = 0;
  }
  return counts;
}

export function createSilentSkipCounter(): SilentSkipCounter {
  const counts = new Map<SilentSkipKind, number>(
    SILENT_SKIP_KINDS.map((kind) => [kind, 0] as const),
  );

  return {
    increment(kind, context) {
      // Runtime guard: protects against stringly-typed callers at JS boundaries.
      if (!SILENT_SKIP_KIND_SET.has(kind)) {
        throw new Error(`Unknown SilentSkipKind: ${kind as string}`);
      }
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      if (context !== undefined) {
        bootstrapLogger.debug(
          { silentSkipKind: kind, ...context },
          '[silent-skip] increment',
        );
      }
    },
    snapshot() {
      const out = createZeroedCounts();
      for (const kind of SILENT_SKIP_KINDS) {
        out[kind] = counts.get(kind) ?? 0;
      }
      return Object.freeze(out);
    },
    reset() {
      for (const kind of SILENT_SKIP_KINDS) {
        counts.set(kind, 0);
      }
    },
  };
}

/**
 * Process-wide shared instance. Production code should import this directly;
 * tests that need isolation should call `createSilentSkipCounter()` or
 * `globalSilentSkipCounter.reset()` in setup.
 */
export const globalSilentSkipCounter: SilentSkipCounter = createSilentSkipCounter();

/**
 * Zod runtime validation schemas for Vespa HTTP/JSON Search API responses.
 *
 * Rationale: the Vespa client previously relied on an `as unknown as VespaQueryResponse`
 * cast after a handful of manual structural checks (root exists, children is an array).
 * That cast silently trusted Vespa to emit `source` / `fields` on every hit — a claim the
 * audit (Epic 06, T06-1, P1) found unverified. Any Vespa schema drift (field renames,
 * ingest regressions) would therefore produce downstream NaN / undefined corruption with
 * no actionable error.
 *
 * These schemas are intentionally permissive via `.passthrough()` — Vespa's response
 * envelope carries metadata (tracing, profiling, bolt-on fields) we do not model, and
 * rejecting unknown keys would be brittle. We enforce only the fields the search pipeline
 * depends on.
 *
 * All numeric fields use `.finite()` per the CLAUDE.md schema quality bar: NaN / Infinity
 * from a broken Vespa response must never reach the ranker.
 */

import { z } from 'zod';

/**
 * Upper bound for Vespa children array.
 * Our largest query uses `limit 200`; 10_000 is a conservative safety cap
 * that catches catastrophically broken responses without rejecting valid ones.
 */
const MAX_VESPA_HITS = 10_000;

/** A single hit returned by the Vespa query API. */
export const VespaHitSchema = z
  .object({
    id: z.string().optional(),
    // Vespa always emits `relevance` for ranked hits; default(0) guards against
    // pathological empty-ranking-profile responses and prevents the downstream
    // cast to VespaHit (relevance: number) from silently converting undefined → NaN.
    relevance: z.number().finite().default(0),
    source: z.string(),
    // `fields` can be absent on metadata-only hits (e.g. grouping result nodes).
    // Default to empty record so extractMatchedFields / extractHitSummary callers
    // never receive undefined — they iterate over the object, which is always safe.
    fields: z.record(z.unknown()).default({}),
  })
  .passthrough();

/** Coverage block reported by Vespa (how much of the corpus was scanned). */
const VespaCoverageSchema = z
  .object({
    coverage: z.number().finite().optional(),
    documents: z.number().int().nonnegative().optional(),
    full: z.boolean().optional(),
    nodes: z.number().int().nonnegative().optional(),
    results: z.number().int().nonnegative().optional(),
    resultsFull: z.number().int().nonnegative().optional(),
  })
  .passthrough();

/** Timing block reported by Vespa (optional, only when tracing is enabled). */
const VespaTimingSchema = z
  .object({
    querytime: z.number().finite().optional(),
    summaryfetchtime: z.number().finite().optional(),
    searchtime: z.number().finite().optional(),
  })
  .passthrough();

/** Top-level `root` element of a Vespa query response. */
const VespaRootSchema = z
  .object({
    id: z.string().optional(),
    relevance: z.number().finite().optional(),
    fields: z.record(z.unknown()).optional(),
    coverage: VespaCoverageSchema.optional(),
    children: z.array(VespaHitSchema).max(MAX_VESPA_HITS).optional(),
  })
  .passthrough();

/** Full Vespa query response envelope. */
export const VespaQueryResponseSchema = z
  .object({
    root: VespaRootSchema,
    timing: VespaTimingSchema.optional(),
  })
  .passthrough();

/**
 * LLM-output parser for the abbreviation-alias ETL.
 *
 * Separated from the ETL CLI so it can be unit-tested in isolation
 * (`abbreviation-llm-parser.test.ts`) without standing up the OpenAI
 * client or filesystem fixtures.
 *
 * The parser obeys the CLAUDE.md LLM-output rules:
 *   - Cast `JSON.parse(...)` result to `unknown` first, then validate
 *     via Zod (rule 12).
 *   - Accept BOTH `number` and `string` for numeric fields (the
 *     LLM-JSON rule in the CLAUDE.md schema quality bar) — LLMs routinely
 *     emit `"0.75"` instead of `0.75`.
 *   - Do NOT chain `.strict()` (rule 10 exception) — LLMs add extra
 *     reasoning / confidence / metadata fields and `.strict()` would
 *     reject the entire response.
 *   - Reject surface forms that contain characters outside the
 *     canonical wine vocabulary (letters / digits / a small set of
 *     punctuation: space, hyphen, apostrophe, period, comma). Anything
 *     else (control chars, emoji, CJK punctuation, currency symbols)
 *     is treated as a fabrication and dropped.
 */

import { z } from 'zod';

/**
 * Hard cap on emitted abbreviation surface length. Anything longer than
 * this is almost certainly an LLM hallucination — wine community
 * shorthand is by definition compact. Matches the operational bound in
 * the ETL CLI.
 */
export const MAX_ABBREVIATION_SURFACE_LENGTH = 40;

/**
 * Hard cap on the number of abbreviation candidates accepted per entity
 * from a single LLM response. Beyond this the LLM is padding output and
 * we silently truncate.
 */
export const MAX_CANDIDATES_PER_ENTITY = 5;

/**
 * Whitelist of characters allowed in an LLM-proposed abbreviation
 * surface. Any other character (emoji, CJK punctuation, control
 * codepoints, currency symbols, mathematical operators) flags the
 * surface as a fabrication and drops it.
 *
 * Rationale: wine community shorthand is overwhelmingly letters (Latin
 * + diacritic Latin + Hangul + CJK ideographs for Korean/Chinese
 * markets), digits, and the small punctuation set listed below. The
 * whitelist is conservative on purpose — false negatives (dropping a
 * legitimate exotic surface) cost recall; false positives
 * (accepting a hallucinated emoji-bearing surface) cost precision and
 * pollute the alias table. We optimize for precision.
 *
 * Uses Unicode property escapes (`\p{L}\p{N}`) with the `/u` flag (CLAUDE.md
 * rule 24: bracketed character class, NOT sequence).
 */
const CANONICAL_VOCABULARY_RE = /^[\p{L}\p{N} \-'’.,]+$/u;

/**
 * Lower bound on alias surface length. Single-character abbreviations
 * collide with everything ("C" matches Cabernet, Caymus, Cloudy Bay,
 * …). Matches `MIN_ALIAS_LENGTH` enforced in `alias-filter.ts`.
 */
const MIN_SURFACE_LENGTH = 2;

/**
 * Tolerant numeric field parser. Accepts:
 *   - `number` (the canonical case)
 *   - `string` numeric (LLMs frequently emit `"0.65"`)
 *
 * Always validates `Number.isFinite()` after coercion (CLAUDE.md
 * schema quality bar — `parseFloat` on external input must be guarded).
 */
const TolerantNumberSchema = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const parsed = typeof value === 'string' ? Number.parseFloat(value) : value;
    if (!Number.isFinite(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected finite number, got ${JSON.stringify(value)}`,
      });
      return z.NEVER;
    }
    return parsed;
  });

/**
 * Single proposed abbreviation entry. Intentionally NOT `.strict()`
 * (CLAUDE.md rule 10 exception for LLM-output): LLMs routinely emit
 * extra reasoning / metadata fields like `"explanation"`, `"source"`,
 * `"confidence_reason"`. `.strict()` would fail the whole batch on
 * those keys.
 */
const ProposedAbbreviationSchema = z.object({
  surface: z.string().min(MIN_SURFACE_LENGTH).max(MAX_ABBREVIATION_SURFACE_LENGTH),
  confidence: TolerantNumberSchema.optional(),
  rationale: z.string().optional(),
});

/**
 * Per-entity response shape. The LLM returns one object whose
 * `abbreviations` is an array, plus optional metadata fields.
 */
const PerEntityResponseSchema = z.object({
  entityId: z.string(),
  abbreviations: z.array(ProposedAbbreviationSchema).max(MAX_CANDIDATES_PER_ENTITY),
});

/**
 * Batch response shape used when the ETL asks for multiple entities in
 * a single LLM call.
 */
const BatchResponseSchema = z.object({
  results: z.array(PerEntityResponseSchema),
});

export type ProposedAbbreviation = z.infer<typeof ProposedAbbreviationSchema>;
export type PerEntityResponse = z.infer<typeof PerEntityResponseSchema>;
export type BatchResponse = z.infer<typeof BatchResponseSchema>;

export interface ParseLlmOutputResult {
  /** Successfully parsed and validated entries. */
  readonly accepted: readonly PerEntityResponse[];
  /** Reasons each rejected surface was dropped — for ETL audit logs. */
  readonly rejected: readonly {
    readonly entityId: string;
    readonly surface: string;
    readonly reason: string;
  }[];
}

/**
 * Locates the outermost `{...}` JSON object in a string. LLMs often
 * wrap their JSON output in prose ("Here's the JSON: {…} I hope this
 * helps!") and a strict `JSON.parse(rawText)` would fail. Mirrors the
 * approach in `generate-korean-aliases.ts` (`parseAliasMatrix`).
 *
 * Returns `null` when no balanced object is found.
 */
function extractJsonObject(text: string): string | null {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Parses an LLM response and returns a structured `accepted` /
 * `rejected` partition. Never throws on malformed input — instead
 * returns an empty `accepted` list with a single explanatory rejection
 * entry so the caller can log and move on. The ETL loop is allowed to
 * proceed past per-entity failures (lossy batch).
 */
export function parseLlmAbbreviationOutput(rawText: string): ParseLlmOutputResult {
  const jsonSlice = extractJsonObject(rawText);
  if (jsonSlice === null) {
    return {
      accepted: [],
      rejected: [
        {
          entityId: '<unknown>',
          surface: '',
          reason: 'LLM response did not contain a balanced JSON object',
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    // Cast to `unknown` per CLAUDE.md rule 12 — never `as T` directly
    // on JSON.parse output.
    parsed = JSON.parse(jsonSlice) as unknown;
  } catch (err) {
    return {
      accepted: [],
      rejected: [
        {
          entityId: '<unknown>',
          surface: '',
          reason: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  const result = BatchResponseSchema.safeParse(parsed);
  if (!result.success) {
    return {
      accepted: [],
      rejected: [
        {
          entityId: '<unknown>',
          surface: '',
          reason: `Zod validation failed: ${result.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
        },
      ],
    };
  }

  const accepted: PerEntityResponse[] = [];
  const rejected: ParseLlmOutputResult['rejected'][number][] = [];

  for (const entityResponse of result.data.results) {
    const okAbbreviations: ProposedAbbreviation[] = [];
    for (const abbr of entityResponse.abbreviations) {
      const trimmed = abbr.surface.trim();
      if (trimmed.length < MIN_SURFACE_LENGTH) {
        rejected.push({
          entityId: entityResponse.entityId,
          surface: abbr.surface,
          reason: `Surface shorter than MIN_SURFACE_LENGTH=${String(MIN_SURFACE_LENGTH)}`,
        });
        continue;
      }
      if (trimmed.length > MAX_ABBREVIATION_SURFACE_LENGTH) {
        rejected.push({
          entityId: entityResponse.entityId,
          surface: abbr.surface,
          reason: `Surface longer than MAX_ABBREVIATION_SURFACE_LENGTH=${String(MAX_ABBREVIATION_SURFACE_LENGTH)}`,
        });
        continue;
      }
      if (!CANONICAL_VOCABULARY_RE.test(trimmed)) {
        rejected.push({
          entityId: entityResponse.entityId,
          surface: abbr.surface,
          reason: 'Surface contains characters outside the canonical wine vocabulary',
        });
        continue;
      }
      okAbbreviations.push({
        ...abbr,
        surface: trimmed,
      });
    }
    if (okAbbreviations.length > 0) {
      accepted.push({
        entityId: entityResponse.entityId,
        abbreviations: okAbbreviations,
      });
    }
  }

  return { accepted, rejected };
}

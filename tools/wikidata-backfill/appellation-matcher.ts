/**
 * Appellation gazetteer loader + matcher.
 *
 * Resolves a wine record's `appellation` field from one of three signals:
 *  1. Compound `region` breadcrumb (Vivino style — "France / Bordeaux / Médoc / Pomerol").
 *     The LEAF segment is most specific; we walk right-to-left and take the
 *     first segment that hits the gazetteer AND agrees with the row's country.
 *  2. `displayName` (canonical label) substring scan against gazetteer keys,
 *     used when the region breadcrumb is empty or unstructured (e.g. for
 *     wines like "2018 Tenuta San Guido Bolgheri").
 *  3. Country-only fallback is INTENTIONALLY not supported — appellations are
 *     local concepts and matching by country alone would invent precision
 *     that does not exist.
 *
 * The matcher is pure: no I/O per call, no shared mutable state. The
 * gazetteer is loaded once and cached at module scope.
 *
 * Used by `tools/wikidata-backfill/appellation-backfill.ts` to materialise
 * Vespa's `appellation` field for silver records whose Vivino payload
 * omitted one. After full backfill the workaround
 * `applyAppellationDataAvailabilityDemotion`
 * (`src/application/search/search-usecase-pre-route-phase.ts`) can be removed.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const GazetteerEntrySchema = z
  .object({
    appellation: z.string().min(1),
    country: z.string().min(1),
    region: z.string().min(1),
    subregion: z.string().min(1).optional(),
    aliases: z.array(z.string().min(1)).max(20).optional(),
    tier: z.string().min(1).optional(),
    wikidata_qid: z.string().min(1).optional(),
  })
  .strict();

const GazetteerSchema = z
  .object({
    version: z.literal(1),
    rationale: z.string().min(1),
    entries: z.array(GazetteerEntrySchema).min(1).max(5000),
  })
  .strict();

export type GazetteerEntry = z.infer<typeof GazetteerEntrySchema>;
export type AppellationGazetteer = z.infer<typeof GazetteerSchema>;

// ---------------------------------------------------------------------------
// Loader (cached at module scope)
// ---------------------------------------------------------------------------

const THIS_DIR = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_GAZETTEER_PATH = resolve(THIS_DIR, 'appellation-gazetteer.json');

interface CompiledGazetteer {
  readonly data: AppellationGazetteer;
  /** Lowercased appellation OR alias → canonical appellation name. */
  readonly nameToCanonical: ReadonlyMap<string, string>;
  /** Canonical appellation name → full entry. */
  readonly byCanonical: ReadonlyMap<string, GazetteerEntry>;
  /** All matchable names (canonical + aliases) sorted longest-first for
   *  display-name substring scan (so "Brunello di Montalcino" wins over
   *  "Montalcino" when both would match). */
  readonly searchKeysLongestFirst: readonly string[];
}

let cachedGazetteer: { path: string; compiled: CompiledGazetteer } | undefined;

/**
 * Compile a parsed gazetteer into lookup structures. Pure — exported for tests.
 */
export function compileGazetteer(data: AppellationGazetteer): CompiledGazetteer {
  const nameToCanonical = new Map<string, string>();
  const byCanonical = new Map<string, GazetteerEntry>();
  const allNames = new Set<string>();
  for (const entry of data.entries) {
    byCanonical.set(entry.appellation, entry);
    const key = entry.appellation.toLowerCase();
    nameToCanonical.set(key, entry.appellation);
    allNames.add(entry.appellation);
    for (const alias of entry.aliases ?? []) {
      nameToCanonical.set(alias.toLowerCase(), entry.appellation);
      allNames.add(alias);
    }
  }
  const searchKeysLongestFirst = [...allNames].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );
  return { data, nameToCanonical, byCanonical, searchKeysLongestFirst };
}

/**
 * Load + Zod-validate the gazetteer from disk. Result is cached per path so
 * repeated calls in the same process do not re-read the file.
 *
 * Throws if the JSON is malformed or fails schema validation — silent
 * fallback would mask gazetteer regressions.
 */
export function loadAppellationGazetteer(path?: string): CompiledGazetteer {
  const resolvedPath = path ?? DEFAULT_GAZETTEER_PATH;
  if (cachedGazetteer !== undefined && cachedGazetteer.path === resolvedPath) {
    return cachedGazetteer.compiled;
  }
  const raw = readFileSync(resolvedPath, 'utf-8');
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[appellation-matcher] invalid JSON in ${resolvedPath}: ${msg}`);
  }
  const parsed = GazetteerSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      `[appellation-matcher] gazetteer schema validation failed in ${resolvedPath}: `
        + parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; '),
    );
  }
  const seen = new Set<string>();
  for (const entry of parsed.data.entries) {
    if (seen.has(entry.appellation)) {
      throw new Error(
        `[appellation-matcher] duplicate appellation entry "${entry.appellation}" in ${resolvedPath}`,
      );
    }
    seen.add(entry.appellation);
  }
  const compiled = compileGazetteer(parsed.data);
  cachedGazetteer = { path: resolvedPath, compiled };
  return compiled;
}

/** Test-only: reset the module-scope cache so a test can swap fixtures. */
export function __resetGazetteerCacheForTests(): void {
  cachedGazetteer = undefined;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export type AppellationMatchSource =
  | 'region_breadcrumb_leaf'
  | 'region_breadcrumb_scan'
  | 'display_name_scan';

export interface AppellationMatch {
  readonly appellation: string;
  readonly entry: GazetteerEntry;
  readonly source: AppellationMatchSource;
}

const BREADCRUMB_SEPARATOR = /\s*[/>›]\s*/u;

/**
 * Country-name normalisation: silver records emit "United States", Wikipedia
 * uses "USA" — we equate the obvious synonyms so country-consistency checks
 * don't reject valid matches.
 *
 * Maps any input to a stable canonical key. Lowercased + diacritic-stripped.
 */
function normaliseCountry(input: string | null | undefined): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}+/gu, '');
  const aliases: Record<string, string> = {
    usa: 'united states',
    us: 'united states',
    'u.s.': 'united states',
    'u.s.a.': 'united states',
    'united states of america': 'united states',
    uk: 'united kingdom',
    'great britain': 'united kingdom',
    deutschland: 'germany',
    espana: 'spain',
    italia: 'italy',
    'sudafrica': 'south africa',
    'south afrika': 'south africa',
  };
  return aliases[lower] ?? lower;
}

/**
 * "Word-boundary"-style match used by display-name substring scan. We can't
 * use `\b` because gazetteer keys contain non-ASCII characters (Médoc,
 * Châteauneuf, Sankt-Émilion) and `\b` is silently ASCII-only — this would
 * miss every accented appellation.
 *
 * Anchors the key with either string-edge or a non-letter-non-digit character
 * on both sides, in Unicode mode.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function matchesWordBounded(haystack: string, needle: string): boolean {
  const re = new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}(?=$|[^\\p{L}\\p{N}])`,
    'iu',
  );
  return re.test(haystack);
}

interface MatchContext {
  readonly regionBreadcrumb: string;
  readonly country: string | null;
  readonly displayName: string;
}

/**
 * Resolve `appellation` for a wine record. Returns the gazetteer entry +
 * the signal that produced it, or null on no match.
 *
 * Match precedence (most precise → least):
 *   1. region breadcrumb LEAF (e.g. "France / Bordeaux / Médoc / Pomerol" → "Pomerol")
 *   2. region breadcrumb non-leaf scan (right-to-left, skipping already-checked leaf)
 *   3. display-name word-bounded substring scan (longest gazetteer key first)
 *
 * Country safety: when the row's `country` is non-empty, ANY candidate
 * appellation whose gazetteer entry has a different country is rejected —
 * silently accepting a cross-country match would corrupt the field. When the
 * row's country is empty/null, the country check is skipped (we trust the
 * region/name signal alone in that case).
 */
export function matchAppellation(
  regionBreadcrumb: string,
  country: string | null,
  displayName: string,
  gazetteer?: CompiledGazetteer,
): AppellationMatch | null {
  const g = gazetteer ?? loadAppellationGazetteer();
  const ctx: MatchContext = {
    regionBreadcrumb: regionBreadcrumb ?? '',
    country,
    displayName: displayName ?? '',
  };

  // 1 & 2. Breadcrumb scan.
  const segments = ctx.regionBreadcrumb
    .split(BREADCRUMB_SEPARATOR)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Walk right-to-left (most specific first).
  for (let idx = segments.length - 1; idx >= 0; idx -= 1) {
    const segment = segments[idx];
    if (segment === undefined) continue;
    const canonical = g.nameToCanonical.get(segment.toLowerCase());
    if (canonical === undefined) continue;
    const entry = g.byCanonical.get(canonical);
    if (entry === undefined) continue;
    if (!isCountryConsistent(ctx.country, entry.country)) continue;
    return {
      appellation: entry.appellation,
      entry,
      source: idx === segments.length - 1
        ? 'region_breadcrumb_leaf'
        : 'region_breadcrumb_scan',
    };
  }

  // 3. Display-name word-bounded substring scan (longest key first).
  if (ctx.displayName.length > 0) {
    for (const key of g.searchKeysLongestFirst) {
      if (!matchesWordBounded(ctx.displayName, key)) continue;
      const canonical = g.nameToCanonical.get(key.toLowerCase());
      if (canonical === undefined) continue;
      const entry = g.byCanonical.get(canonical);
      if (entry === undefined) continue;
      if (!isCountryConsistent(ctx.country, entry.country)) continue;
      return { appellation: entry.appellation, entry, source: 'display_name_scan' };
    }
  }

  return null;
}

function isCountryConsistent(
  rowCountry: string | null,
  entryCountry: string,
): boolean {
  const a = normaliseCountry(rowCountry);
  const b = normaliseCountry(entryCountry);
  if (a === null) return true; // row has no country signal → trust region/name
  if (b === null) return true; // gazetteer always sets country, but be safe
  return a === b;
}

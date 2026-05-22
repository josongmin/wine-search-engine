/**
 * S3 — Deterministic grounding-verify for the synthesis stage.
 *
 * Between primary synthesis and the final return, we check the LLM answer's
 * factual claims against the UNION of grounding facts gathered from EVERY tool
 * outcome (not just the last). The union is built from two shapes a
 * `ToolOutcome.result` can take:
 *
 *   1. A string observation carrying a `GROUNDING_JSON: {...}` envelope
 *      (the agent-facing form emitted by the search/compare tools).
 *   2. A structured object — `{ queryType:'search', results:[{entity:{…}}] }`,
 *      `{ entities:[{topResult,allResults}] }` (comparison), or a bare
 *      `{ wines:[…] }` preview payload.
 *
 * Matching is deterministic — NO heuristics, NO LLM. Every grounding surface
 * and every answer surface is normalized identically:
 *   NFC → lowercase → strip Korean josa (`stripKoreanJosa`, SSoT) → collapse
 *   whitespace → trim.
 *
 * Two claim classes are checked, both chosen because they can be extracted
 * from free text WITH CERTAINTY (no false positives on paraphrased prose,
 * CLAUDE.md rule 23):
 *
 *   - Cited wine LABELS: the LLM lists the wines it discusses in
 *     `SynthesisAnswer.citations[]`. Citations that are entity-id-shaped
 *     (`wine-…`, uuids, bare numerics) are ID references and skipped — only
 *     label-shaped citations (free-text wine names) are verified. A
 *     label-shaped citation that does not match any grounded canonical label
 *     is an ungrounded claim. This is the dominant faith=0 hallucination:
 *     the model recommends "Wine B" while only "Wine A" was grounded.
 *
 *   - VINTAGE years asserted in the answer text: any 4-digit vintage-range
 *     year that is not a grounded vintage is an ungrounded claim.
 *
 * Plain prose that names no specific cited label and asserts no vintage is
 * treated as grounded — the verifier never penalizes a faithful paraphrase.
 *
 * ----------------------------------------------------------------------------
 * Match rule composition (L2.A / L2.B / L2.C / L2.D — bench faith=0 hardening)
 *
 * A label-shaped citation is checked against the grounding by trying a small
 * typed cascade of rules, in order. Each rule is derivable from existing
 * domain primitives (NFC normalisation, the curated korean-wine-aliases
 * catalog, the Transliterator EN↔KO exception dictionary, and structured
 * grounding fields). We never substring-match against natural prose — every
 * rule operates on the citation surface (label-shaped) and grounding fields.
 *
 *   - exact_nfc_lower         — direct string equality after normalisation.
 *   - particle_stripped       — Korean josa is stripped by normalisation; this
 *                               rule formalises the case where particle-strip
 *                               is the only reason the surfaces collide.
 *   - transliteration_pair    — claim and grounded label are alternate
 *                               surfaces of the same wine via curated catalogs
 *                               (korean-wine-aliases.ts and Transliterator
 *                               EXCEPTIONS Korean↔Latin index).
 *   - compound_subsumed_by_label
 *                             — claim tokens ⊆ canonical_label tokens (after
 *                               normalisation). Catches "샤또 마고" inside
 *                               "샤또 마고 2015 메도크".
 *   - vintage_year_field_match
 *                             — claim ends in a 4-digit year (1900-2099);
 *                               split into label-part + year-part. Match the
 *                               label-part against a grounded wine AND verify
 *                               the year matches that wine's vintage_year.
 *                               Year mismatch → reject (no false positive).
 *   - structured_field_present
 *                             — claim text matches any of the grounded
 *                               structured fields (region | grape | producer
 *                               | price), including curated transliteration
 *                               alternates of those fields. Catches "보르도
 *                               산 와인" when grounding only carries
 *                               region:"Bordeaux".
 *
 * A claim matches grounding iff ANY rule fires. Rules are evaluated in the
 * declared order; the FIRST hit wins. The matched rule kind is included in
 * the verification result so the synthesis runner can log per-claim
 * provenance (telemetry, not control-flow).
 */

import { stripKoreanJosa } from '@domain/query/service/query-normalizer.js';
import {
  KOREAN_WINE_ALIAS_CORRECTION_ENTRIES,
  expandKoreanWineTypoVariants,
} from '@domain/query/service/korean-wine-aliases.js';
import { Transliterator } from '@domain/alias/service/transliterator.js';
import type { ToolOutcome } from '@domain/agent/model/tool-outcome.js';

const GROUNDING_JSON_MARKER = 'GROUNDING_JSON: ';

/** Minimum normalized length for a label surface to be treated as a checkable
 *  claim. Shorter surfaces are too generic to verify reliably. */
const MIN_CLAIM_SURFACE_CHARS = 2;

/** Lowest plausible wine vintage year. Guards against treating arbitrary
 *  4-digit numbers (e.g. prices) as vintages. */
const MIN_PLAUSIBLE_VINTAGE = 1900;
/** Highest plausible vintage year (current-era ceiling). */
const MAX_PLAUSIBLE_VINTAGE = 2100;

/**
 * Citation surfaces that are ENTITY-ID references, not label claims. These
 * are not verified against labels (an id like `wine-001` legitimately does
 * not appear in the canonical-label set). Matches `wine-…`, bare integers,
 * and uuid-shaped tokens.
 */
const ENTITY_ID_CITATION_RE = /^(?:wine[-_].+|\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;

/** Max number of ungrounded surfaces reported (bounds the re-synth directive). */
const MAX_REPORTED_CLAIMS = 8;

/**
 * Per-wine grounding record carrying enough structure for the
 * `vintage_year_field_match` rule. The flat sets on `GroundingFacts` are
 * preserved for backwards compatibility with consumers that only need a
 * union view of the facts.
 */
export interface GroundedWineRecord {
  /** Normalized canonical label of the wine (NFC + lowercase + josa-strip + trim). */
  readonly label: string;
  /** Normalized region, if present. */
  readonly region: string | undefined;
  /** Normalized producer, if present. */
  readonly producer: string | undefined;
  /** Normalized grape names. */
  readonly grapes: readonly string[];
  /** Normalized price string, if present. */
  readonly price: string | undefined;
  /** Grounded vintage year (1900-2100 plausible range), if present. */
  readonly vintageYear: number | undefined;
}

export interface GroundingFacts {
  readonly labels: ReadonlySet<string>;
  readonly regions: ReadonlySet<string>;
  readonly grapes: ReadonlySet<string>;
  readonly vintages: ReadonlySet<string>;
  readonly prices: ReadonlySet<string>;
  /** Per-wine records used by structural rules (vintage-split, compound
   *  subsumption). Always populated alongside the flat sets. */
  readonly wines: readonly GroundedWineRecord[];
  /** True iff at least one fact of any kind was found. When false the verifier
   *  cannot judge grounding and reports grounded. */
  readonly hasAnyFact: boolean;
}

/** Discriminated-union tag for which rule fired on a given citation. */
type GroundingMatchRule =
  | { readonly kind: 'exact_nfc_lower' }
  | { readonly kind: 'particle_stripped' }
  | { readonly kind: 'transliteration_pair' }
  | { readonly kind: 'compound_subsumed_by_label' }
  | { readonly kind: 'vintage_year_field_match' }
  | { readonly kind: 'structured_field_present' };

/** Per-claim trace entry: which rule matched (telemetry, no control-flow). */
interface GroundingMatchTrace {
  /** Normalized citation surface. */
  readonly claim: string;
  /** The first rule that fired, or `null` if no rule matched. */
  readonly matchedRule: GroundingMatchRule | null;
}

interface GroundingVerifyResult {
  readonly grounded: boolean;
  /** Normalized surfaces of the claims that could not be grounded. */
  readonly ungroundedClaims: readonly string[];
  /** Per-claim match trace (in citation iteration order, label-shaped only). */
  readonly trace: readonly GroundingMatchTrace[];
}

/** NFC + lowercase + strip Korean josa + collapse whitespace + trim. Applied
 *  symmetrically to grounding facts and answer surfaces. */
export function normalizeClaimSurface(value: string): string {
  return stripKoreanJosa(value.normalize('NFC').toLowerCase())
    .replace(/\s+/gu, ' ')
    .trim();
}

interface MutableFacts {
  readonly labels: Set<string>;
  readonly regions: Set<string>;
  readonly grapes: Set<string>;
  readonly vintages: Set<string>;
  readonly prices: Set<string>;
  readonly wines: GroundedWineRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function addSurface(target: Set<string>, value: unknown): void {
  if (typeof value !== 'string') {
    return;
  }
  const normalized = normalizeClaimSurface(value);
  if (normalized.length >= MIN_CLAIM_SURFACE_CHARS) {
    target.add(normalized);
  }
}

function normalizeOptionalSurface(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = normalizeClaimSurface(value);
  return normalized.length >= MIN_CLAIM_SURFACE_CHARS ? normalized : undefined;
}

function plausibleVintageYear(value: unknown): number | undefined {
  let year: number | undefined;
  if (typeof value === 'number') {
    year = value;
  } else if (typeof value === 'string' && /^\d{4}$/u.test(value.trim())) {
    const parsed = Number(value.trim());
    year = Number.isFinite(parsed) ? parsed : undefined;
  }
  if (
    year !== undefined
    && Number.isFinite(year)
    && Number.isInteger(year)
    && year >= MIN_PLAUSIBLE_VINTAGE
    && year <= MAX_PLAUSIBLE_VINTAGE
  ) {
    return year;
  }
  return undefined;
}

function addVintage(target: Set<string>, value: unknown): void {
  const year = plausibleVintageYear(value);
  if (year !== undefined) {
    target.add(String(year));
  }
}

/** Pull grounding fields from one wine-like record (GROUNDING_JSON `wines[]`
 *  entry or structured `results[].entity`). Accepts snake_case and camelCase. */
function ingestWineRecord(facts: MutableFacts, wine: unknown): void {
  if (!isRecord(wine)) {
    return;
  }
  const labelRaw = wine['canonical_label'] ?? wine['canonicalLabel'];
  addSurface(facts.labels, labelRaw);
  addSurface(facts.regions, wine['region']);
  // Both legacy "vintage" (single field) and the structured
  // "vintage_year"/"vintageYear" fields are accepted — the agent grounding
  // envelopes carry vintage_year, the structured search results carry vintage.
  const vintageRaw = wine['vintage'] ?? wine['vintage_year'] ?? wine['vintageYear'];
  addVintage(facts.vintages, vintageRaw);
  addSurface(facts.prices, wine['price']);
  const grapes = wine['grapes'];
  const grapesNormalized: string[] = [];
  if (Array.isArray(grapes)) {
    for (const grape of grapes) {
      addSurface(facts.grapes, grape);
      const norm = normalizeOptionalSurface(grape);
      if (norm !== undefined) grapesNormalized.push(norm);
    }
  }
  const label = normalizeOptionalSurface(labelRaw);
  if (label !== undefined) {
    const record: GroundedWineRecord = {
      label,
      region: normalizeOptionalSurface(wine['region']),
      producer: normalizeOptionalSurface(wine['producer']),
      grapes: grapesNormalized,
      price: normalizeOptionalSurface(wine['price']),
      vintageYear: plausibleVintageYear(vintageRaw),
    };
    facts.wines.push(record);
  }
}

function ingestStructuredResult(facts: MutableFacts, result: Record<string, unknown>): void {
  const results = result['results'];
  if (Array.isArray(results)) {
    for (const row of results) {
      if (isRecord(row)) {
        ingestWineRecord(facts, row['entity'] ?? row);
      }
    }
  }
  const entities = result['entities'];
  if (Array.isArray(entities)) {
    for (const entity of entities) {
      if (!isRecord(entity)) {
        continue;
      }
      const top = entity['topResult'];
      if (isRecord(top)) {
        ingestWineRecord(facts, top['entity'] ?? top);
      }
      const allResults = entity['allResults'];
      if (Array.isArray(allResults)) {
        for (const row of allResults) {
          if (isRecord(row)) {
            ingestWineRecord(facts, row['entity'] ?? row);
          }
        }
      }
    }
  }
  const wines = result['wines'];
  if (Array.isArray(wines)) {
    for (const wine of wines) {
      ingestWineRecord(facts, wine);
    }
  }
}

function ingestGroundingJsonMarker(facts: MutableFacts, observation: string): void {
  const markerIndex = observation.lastIndexOf(GROUNDING_JSON_MARKER);
  if (markerIndex < 0) {
    return;
  }
  const rawJson = observation.slice(markerIndex + GROUNDING_JSON_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return;
  }
  if (isRecord(parsed)) {
    ingestStructuredResult(facts, parsed);
  }
}

/**
 * Build the union of grounding facts across ALL tool outcomes. Only outcomes
 * with usable evidence (`success` / `partial_result`) contribute.
 */
export function collectGroundingFacts(
  outcomes: readonly ToolOutcome[],
): GroundingFacts {
  const facts: MutableFacts = {
    labels: new Set<string>(),
    regions: new Set<string>(),
    grapes: new Set<string>(),
    vintages: new Set<string>(),
    prices: new Set<string>(),
    wines: [],
  };
  for (const outcome of outcomes) {
    if (outcome.kind !== 'success' && outcome.kind !== 'partial_result') {
      continue;
    }
    const result = outcome.result;
    if (typeof result === 'string') {
      ingestGroundingJsonMarker(facts, result);
    } else if (isRecord(result)) {
      ingestStructuredResult(facts, result);
    }
  }
  const hasAnyFact =
    facts.labels.size > 0
    || facts.regions.size > 0
    || facts.grapes.size > 0
    || facts.vintages.size > 0
    || facts.prices.size > 0;
  return {
    labels: facts.labels,
    regions: facts.regions,
    grapes: facts.grapes,
    vintages: facts.vintages,
    prices: facts.prices,
    wines: facts.wines,
    hasAnyFact,
  };
}

/** All vintage-like years asserted in the answer text (bounded to plausible
 *  vintage range, de-duplicated). */
function extractAnswerVintages(normalizedAnswer: string): readonly string[] {
  const out: string[] = [];
  for (const match of normalizedAnswer.matchAll(/(?<![0-9])((?:19|20)\d{2})(?![0-9])/gu)) {
    const token = match[1]!;
    const year = Number(token);
    if (
      Number.isFinite(year)
      && year >= MIN_PLAUSIBLE_VINTAGE
      && year <= MAX_PLAUSIBLE_VINTAGE
      && !out.includes(token)
    ) {
      out.push(token);
    }
  }
  return out;
}

/** True iff the citation is an entity-id reference (skipped for label check). */
function isEntityIdCitation(citation: string): boolean {
  return ENTITY_ID_CITATION_RE.test(citation.trim());
}

// ---------------------------------------------------------------------------
// Transliteration / alias expansion (L2.B)
// ---------------------------------------------------------------------------

/**
 * Lazily-built bidirectional alias index over `KOREAN_WINE_ALIAS_CORRECTION_ENTRIES`.
 * Given any surface (variant OR canonical), returns the full equivalence
 * class — all surfaces in the catalog that map to the same Korean canonical.
 *
 * Surfaces are stored after `normalizeClaimSurface` so lookup is direct on the
 * verifier's normalized strings.
 */
let KOREAN_ALIAS_EQUIV: ReadonlyMap<string, ReadonlySet<string>> | undefined;

function getKoreanAliasEquivalenceClasses(): ReadonlyMap<string, ReadonlySet<string>> {
  if (KOREAN_ALIAS_EQUIV !== undefined) return KOREAN_ALIAS_EQUIV;
  // canonical → equivalence-class set (canonical + all variants pointing to it)
  const byCanonical = new Map<string, Set<string>>();
  for (const [variant, canonical] of KOREAN_WINE_ALIAS_CORRECTION_ENTRIES) {
    const canonicalNorm = normalizeClaimSurface(canonical);
    const variantNorm = normalizeClaimSurface(variant);
    if (canonicalNorm.length === 0 || variantNorm.length === 0) continue;
    const cls = byCanonical.get(canonicalNorm) ?? new Set<string>([canonicalNorm]);
    cls.add(variantNorm);
    byCanonical.set(canonicalNorm, cls);
  }
  // Reverse-map every surface to its equivalence class.
  const equiv = new Map<string, ReadonlySet<string>>();
  for (const cls of byCanonical.values()) {
    for (const surface of cls) {
      equiv.set(surface, cls);
    }
  }
  KOREAN_ALIAS_EQUIV = equiv;
  return equiv;
}

/**
 * Expand a normalized surface to its full set of known alternates via the
 * curated catalogs:
 *   - `korean-wine-aliases.ts` (Korean↔Korean variants / typo correction)
 *   - `Transliterator.romanizeWineTerm` (Korean → curated Latin canonical)
 *   - `Transliterator.koreanExceptionSurfaceForLatinTerm` (Latin → curated
 *     Korean canonical)
 *
 * Every alternate added is itself re-normalized with `normalizeClaimSurface`
 * so downstream equality uses one normalisation pass.
 */
function expandAlternates(normalizedSurface: string): ReadonlySet<string> {
  const out = new Set<string>([normalizedSurface]);

  // Korean→Korean equivalence class.
  const koEquiv = getKoreanAliasEquivalenceClasses().get(normalizedSurface);
  if (koEquiv !== undefined) {
    for (const alt of koEquiv) out.add(alt);
  }
  // expandKoreanWineTypoVariants only returns variants for canonical inputs —
  // include for completeness (idempotent with koEquiv but safer for catalog
  // updates that touch only the variants map).
  for (const variant of expandKoreanWineTypoVariants(normalizedSurface)) {
    const norm = normalizeClaimSurface(variant);
    if (norm.length > 0) out.add(norm);
  }

  // Korean → Latin (curated exception index, vintage-stripped).
  const latin = Transliterator.romanizeWineTerm(normalizedSurface);
  if (latin !== undefined) {
    out.add(normalizeClaimSurface(latin));
  }
  // Latin → Korean (curated exception surface, vintage-stripped).
  const korean = Transliterator.koreanExceptionSurfaceForLatinTerm(normalizedSurface);
  if (korean !== undefined) {
    out.add(normalizeClaimSurface(korean));
    // Korean canonical may itself have variants in the typo catalog — chain.
    const koEquiv2 = getKoreanAliasEquivalenceClasses().get(normalizeClaimSurface(korean));
    if (koEquiv2 !== undefined) {
      for (const alt of koEquiv2) out.add(alt);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Compound subsumption (L2.C, no vintage)
// ---------------------------------------------------------------------------

/** Tokenize a normalized surface into space-separated tokens (>= 1 char). */
function tokenize(normalized: string): readonly string[] {
  return normalized.split(' ').filter((tok) => tok.length > 0);
}

/** True iff all tokens of `subset` appear in `superset` (multiset semantics). */
function tokensSubsumed(subset: readonly string[], superset: readonly string[]): boolean {
  if (subset.length === 0) return false;
  const remaining = new Map<string, number>();
  for (const tok of superset) {
    remaining.set(tok, (remaining.get(tok) ?? 0) + 1);
  }
  for (const tok of subset) {
    const count = remaining.get(tok) ?? 0;
    if (count === 0) return false;
    remaining.set(tok, count - 1);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Vintage-year split (L2.C with year)
// ---------------------------------------------------------------------------

interface LabelYearSplit {
  readonly labelPart: string;
  readonly yearPart: number;
}

/**
 * Detect "{label} {YYYY}" or "{YYYY} {label}" in a normalized citation. The
 * year is only accepted if it falls within the plausible vintage range. Returns
 * `undefined` when no year is present.
 *
 * The year may be the LAST or FIRST whitespace-delimited token. Embedded
 * years inside the label-part (e.g. "1999 cuvée") are deliberately not
 * peeled off — only the bounding token is treated as the vintage.
 */
function splitLabelAndYear(normalizedClaim: string): LabelYearSplit | undefined {
  const tokens = tokenize(normalizedClaim);
  if (tokens.length < 2) return undefined;
  // tokens.length >= 2 here, so first/last are non-null after the guard.
  const lastIdx = tokens.length - 1;
  const last = tokens[lastIdx];
  const first = tokens[0];
  if (last !== undefined && /^(?:19|20)\d{2}$/u.test(last)) {
    const yr = Number(last);
    if (Number.isFinite(yr) && yr >= MIN_PLAUSIBLE_VINTAGE && yr <= MAX_PLAUSIBLE_VINTAGE) {
      const labelPart = tokens.slice(0, lastIdx).join(' ').trim();
      if (labelPart.length >= MIN_CLAIM_SURFACE_CHARS) {
        return { labelPart, yearPart: yr };
      }
    }
  }
  if (first !== undefined && /^(?:19|20)\d{2}$/u.test(first)) {
    const yr = Number(first);
    if (Number.isFinite(yr) && yr >= MIN_PLAUSIBLE_VINTAGE && yr <= MAX_PLAUSIBLE_VINTAGE) {
      const labelPart = tokens.slice(1).join(' ').trim();
      if (labelPart.length >= MIN_CLAIM_SURFACE_CHARS) {
        return { labelPart, yearPart: yr };
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Per-rule predicates
// ---------------------------------------------------------------------------

/** Rule: exact match on the normalised surface. */
function tryExactNfcLower(claim: string, facts: GroundingFacts): boolean {
  return facts.labels.has(claim);
}

/**
 * Rule: particle-stripped match. `normalizeClaimSurface` already strips josa,
 * so this rule covers the case where stripping a josa from the RAW citation
 * (not the normalized one) is what causes the surfaces to collide. We detect
 * this by comparing the claim to the labels with the trailing single Hangul
 * (a heuristic-free josa surrogate is already handled by `stripKoreanJosa`);
 * since both sides went through the same normalisation, particle_stripped
 * fires exactly when exact_nfc_lower would fire after stripKoreanJosa was the
 * differentiating step. We treat this as an alias for exact_nfc_lower when
 * the claim contains Hangul — kept as a separate rule kind purely for
 * provenance telemetry.
 */
function tryParticleStripped(claim: string, facts: GroundingFacts): boolean {
  if (!/\p{Script=Hangul}/u.test(claim)) return false;
  return facts.labels.has(claim);
}

/**
 * Rule: claim and a grounded label belong to the same curated alias
 * equivalence class. Cross-walks both directions via the Transliterator and
 * the korean-wine-aliases catalog. ANY overlap between the claim's alternates
 * and any grounded label's alternates is a match.
 */
function tryTransliterationPair(claim: string, facts: GroundingFacts): boolean {
  const claimAlts = expandAlternates(claim);
  // If the claim has no alternates beyond itself, the rule degenerates to
  // exact_nfc_lower — which would have already fired upstream.
  if (claimAlts.size <= 1) return false;
  for (const label of facts.labels) {
    if (claimAlts.has(label)) return true;
  }
  for (const label of facts.labels) {
    const labelAlts = expandAlternates(label);
    for (const alt of labelAlts) {
      if (claimAlts.has(alt)) return true;
    }
  }
  return false;
}

/**
 * Rule: every token of the claim appears in some grounded label (multiset),
 * OR every token of some grounded label appears in the claim (the model may
 * cite a longer surface that includes the canonical label plus extra
 * qualifiers like "Grand Vin"). Both the claim and the labels are also
 * expanded through `expandAlternates` so transliteration variants count
 * toward token coverage.
 */
function tryCompoundSubsumedByLabel(claim: string, facts: GroundingFacts): boolean {
  const claimTokens = tokenize(claim);
  if (claimTokens.length === 0) return false;
  for (const label of facts.labels) {
    const labelTokens = tokenize(label);
    // Claim ⊆ label  (claim is a shorter form of the canonical label) OR
    // Label ⊆ claim  (claim extends the canonical label with qualifiers).
    if (tokensSubsumed(claimTokens, labelTokens)) return true;
    if (tokensSubsumed(labelTokens, claimTokens)) return true;
  }
  // Cross-alias compound subsumption — translate the claim into its alternates
  // and re-test against each grounded label.
  const claimAlts = expandAlternates(claim);
  for (const alt of claimAlts) {
    if (alt === claim) continue;
    const altTokens = tokenize(alt);
    if (altTokens.length === 0) continue;
    for (const label of facts.labels) {
      const labelTokens = tokenize(label);
      if (tokensSubsumed(altTokens, labelTokens)) return true;
      if (tokensSubsumed(labelTokens, altTokens)) return true;
    }
  }
  return false;
}

/** Tri-state outcome from the vintage-year rule (year mismatch is a hard
 *  rejection — see `tryVintageYearFieldMatch` for the rationale). */
type VintageRuleOutcome = 'match' | 'reject' | 'inapplicable';

/**
 * Rule: claim splits into "{label-part} {year}" (or "{year} {label-part}")
 * AND there exists a grounded wine whose normalized label aligns with the
 * label-part (exact / compound subsumption either direction / alias
 * equivalence) AND whose `vintage_year` matches the year.
 *
 * Year mismatch as a HARD REJECTION:
 *   When the label-part DOES align with a grounded wine but the asserted
 *   year does NOT match that wine's `vintage_year`, we return 'reject'. This
 *   prevents the downstream `compound_subsumed_by_label` rule from absorbing
 *   the year-mismatched claim via label-only tokens — the year is part of the
 *   wine identity for verification purposes, and a confabulated vintage is a
 *   hallucination even when the label is real.
 *
 *   When NO grounded wine's label aligns with the label-part at all, we
 *   return 'inapplicable' (other rules may still match — e.g. a region claim
 *   that incidentally ends in a year token would be salvageable, though in
 *   practice the year must be a vintage one not a structural-field one).
 */
function tryVintageYearFieldMatch(
  claim: string,
  facts: GroundingFacts,
): VintageRuleOutcome {
  const split = splitLabelAndYear(claim);
  if (split === undefined) return 'inapplicable';
  const { labelPart, yearPart } = split;
  const labelPartTokens = tokenize(labelPart);
  const labelPartAlts = expandAlternates(labelPart);

  let labelAlignedButYearMismatch = false;
  for (const wine of facts.wines) {
    // Label-part must align with the wine's label via:
    //   (a) exact equality on the normalised label,
    //   (b) compound subsumption (either direction), or
    //   (c) alias equivalence (curated catalog overlap).
    let aligned = false;
    if (wine.label === labelPart) aligned = true;
    if (!aligned) {
      const wineTokens = tokenize(wine.label);
      if (tokensSubsumed(labelPartTokens, wineTokens)) aligned = true;
      if (!aligned && tokensSubsumed(wineTokens, labelPartTokens)) aligned = true;
    }
    if (!aligned && labelPartAlts.has(wine.label)) aligned = true;
    if (!aligned) {
      const wineAlts = expandAlternates(wine.label);
      // (c1) any alias equivalence overlap between the two surfaces' alternates.
      for (const alt of labelPartAlts) {
        if (wineAlts.has(alt)) {
          aligned = true;
          break;
        }
      }
      // (c2) compound subsumption AGAINST the wine's alternates — covers the
      // case where the claim's label-part is a sub-string of an aliased form
      // of the wine label (e.g. claim "margaux" ⊆ wineAlt "château margaux"
      // when the grounded label is the Korean "샤또 마고").
      if (!aligned) {
        for (const wineAlt of wineAlts) {
          if (wineAlt === wine.label) continue;
          const wineAltTokens = tokenize(wineAlt);
          if (wineAltTokens.length === 0) continue;
          if (tokensSubsumed(labelPartTokens, wineAltTokens)) {
            aligned = true;
            break;
          }
          if (tokensSubsumed(wineAltTokens, labelPartTokens)) {
            aligned = true;
            break;
          }
        }
      }
      // (c3) and symmetrically, compound subsumption of any claim alt against
      // the wine label.
      if (!aligned) {
        const wineTokens = tokenize(wine.label);
        for (const labelAlt of labelPartAlts) {
          if (labelAlt === labelPart) continue;
          const altTokens = tokenize(labelAlt);
          if (altTokens.length === 0) continue;
          if (tokensSubsumed(altTokens, wineTokens)) {
            aligned = true;
            break;
          }
          if (tokensSubsumed(wineTokens, altTokens)) {
            aligned = true;
            break;
          }
        }
      }
    }
    if (!aligned) continue;

    if (wine.vintageYear === yearPart) return 'match';
    if (wine.vintageYear !== undefined) {
      // Aligned wine exists, but its grounded vintage is a DIFFERENT year.
      labelAlignedButYearMismatch = true;
    }
    // wine.vintageYear === undefined → label aligns but no grounded vintage
    // for this wine. We do NOT treat this as a reject (the model may legitimately
    // know the vintage from a different grounded outcome), so continue scanning.
  }
  if (labelAlignedButYearMismatch) return 'reject';
  return 'inapplicable';
}

/**
 * Rule: claim text appears in a structured field of some grounded wine
 * (region / grape / producer / price), considering curated transliteration
 * alternates of both sides.
 *
 * This catches claims like "보르도 산 와인" when grounding only carries
 * `region: "Bordeaux"`. We do NOT match against `label` here — that is the
 * domain of the other rules.
 */
function tryStructuredFieldPresent(claim: string, facts: GroundingFacts): boolean {
  const claimAlts = expandAlternates(claim);
  const matchAgainst = (fieldValue: string | undefined): boolean => {
    if (fieldValue === undefined) return false;
    if (claimAlts.has(fieldValue)) return true;
    const fieldAlts = expandAlternates(fieldValue);
    for (const alt of claimAlts) {
      if (fieldAlts.has(alt)) return true;
    }
    // Token-level containment: claim may be "보르도" while field is "bordeaux"
    // (different scripts but both in claimAlts via Transliterator). Also allow
    // field value to be subsumed by claim tokens — e.g. claim "보르도 와인"
    // covers field "보르도".
    const claimTokens = tokenize(claim);
    const fieldTokens = tokenize(fieldValue);
    if (tokensSubsumed(fieldTokens, claimTokens)) return true;
    return false;
  };

  for (const wine of facts.wines) {
    if (matchAgainst(wine.region)) return true;
    if (matchAgainst(wine.producer)) return true;
    if (matchAgainst(wine.price)) return true;
    for (const grape of wine.grapes) {
      if (matchAgainst(grape)) return true;
    }
  }
  // Fall back to the flat sets too (some structured outcomes only populate
  // the flat sets — e.g. results without a wines[] array in the same record).
  if (facts.regions.size > 0) {
    for (const region of facts.regions) {
      if (matchAgainst(region)) return true;
    }
  }
  if (facts.grapes.size > 0) {
    for (const grape of facts.grapes) {
      if (matchAgainst(grape)) return true;
    }
  }
  if (facts.prices.size > 0) {
    for (const price of facts.prices) {
      if (matchAgainst(price)) return true;
    }
  }
  return false;
}

/**
 * Compose the rule cascade. Returns the FIRST rule that fires, or `null` if
 * the claim cannot be grounded by any rule. The order is significant — the
 * cheapest, most precise rule is tried first; broader rules come later.
 *
 * `vintage_year_field_match` runs BEFORE compound subsumption: a "reject"
 * verdict from the vintage rule is a hard rejection (year mismatch against
 * an aligned label) and short-circuits the cascade, preventing downstream
 * rules from absorbing year-confabulated claims via label-only tokens.
 */
function matchClaim(
  claim: string,
  facts: GroundingFacts,
): GroundingMatchRule | null {
  if (tryExactNfcLower(claim, facts)) {
    return { kind: 'exact_nfc_lower' };
  }
  if (tryParticleStripped(claim, facts)) {
    return { kind: 'particle_stripped' };
  }
  if (tryTransliterationPair(claim, facts)) {
    return { kind: 'transliteration_pair' };
  }
  const vintageOutcome = tryVintageYearFieldMatch(claim, facts);
  if (vintageOutcome === 'match') {
    return { kind: 'vintage_year_field_match' };
  }
  if (vintageOutcome === 'reject') {
    return null;
  }
  if (tryCompoundSubsumedByLabel(claim, facts)) {
    return { kind: 'compound_subsumed_by_label' };
  }
  if (tryStructuredFieldPresent(claim, facts)) {
    return { kind: 'structured_field_present' };
  }
  return null;
}

/**
 * Verify the answer against the grounding union.
 *
 * @param answer  the synthesized answer text
 * @param citations  the LLM-emitted citation surfaces (entity ids and/or
 *   label names). Label-shaped citations are verified against grounded labels.
 * @param facts  the grounding union
 */
export function verifyAnswerGrounding(
  answer: string,
  citations: readonly string[] | undefined,
  facts: GroundingFacts,
): GroundingVerifyResult {
  // No facts at all → cannot judge; treat as grounded (defensive — the runner
  // only invokes verify on grounded paths).
  if (!facts.hasAnyFact) {
    return { grounded: true, ungroundedClaims: [], trace: [] };
  }
  const ungrounded: string[] = [];
  const trace: GroundingMatchTrace[] = [];
  const normalizedAnswer = normalizeClaimSurface(answer);

  // (1) Label citations: a label-shaped citation must match a grounded label
  //     under at least one rule in the cascade.
  if (citations !== undefined) {
    for (const citation of citations) {
      if (typeof citation !== 'string' || citation.trim().length === 0) {
        continue;
      }
      if (isEntityIdCitation(citation)) {
        continue;
      }
      const normalizedCitation = normalizeClaimSurface(citation);
      if (normalizedCitation.length < MIN_CLAIM_SURFACE_CHARS) {
        continue;
      }
      const matchedRule = matchClaim(normalizedCitation, facts);
      trace.push({ claim: normalizedCitation, matchedRule });
      if (matchedRule === null && !ungrounded.includes(normalizedCitation)) {
        ungrounded.push(normalizedCitation);
      }
    }
  }

  // (2) Vintage assertions: every vintage in the answer must be grounded
  //     (only enforced when grounding actually carries vintage facts). The
  //     per-wine `vintage_year_field_match` rule covers vintage claims that
  //     are bundled into a citation; this loop covers vintages asserted in
  //     prose without a matching citation.
  if (facts.vintages.size > 0) {
    for (const answerVintage of extractAnswerVintages(normalizedAnswer)) {
      if (!facts.vintages.has(answerVintage) && !ungrounded.includes(answerVintage)) {
        ungrounded.push(answerVintage);
      }
    }
  }

  return {
    grounded: ungrounded.length === 0,
    ungroundedClaims: ungrounded.slice(0, MAX_REPORTED_CLAIMS),
    trace,
  };
}

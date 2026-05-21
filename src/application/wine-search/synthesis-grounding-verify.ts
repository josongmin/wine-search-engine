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
 */

import { stripKoreanJosa } from '@domain/query/service/query-normalizer.js';
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

export interface GroundingFacts {
  readonly labels: ReadonlySet<string>;
  readonly regions: ReadonlySet<string>;
  readonly grapes: ReadonlySet<string>;
  readonly vintages: ReadonlySet<string>;
  readonly prices: ReadonlySet<string>;
  /** True iff at least one fact of any kind was found. When false the verifier
   *  cannot judge grounding and reports grounded. */
  readonly hasAnyFact: boolean;
}

export interface GroundingVerifyResult {
  readonly grounded: boolean;
  /** Normalized surfaces of the claims that could not be grounded. */
  readonly ungroundedClaims: readonly string[];
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

function addVintage(target: Set<string>, value: unknown): void {
  const year = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d{4}$/u.test(value.trim())
      ? Number(value.trim())
      : undefined;
  if (
    year !== undefined
    && Number.isInteger(year)
    && year >= MIN_PLAUSIBLE_VINTAGE
    && year <= MAX_PLAUSIBLE_VINTAGE
  ) {
    target.add(String(year));
  }
}

/** Pull grounding fields from one wine-like record (GROUNDING_JSON `wines[]`
 *  entry or structured `results[].entity`). Accepts snake_case and camelCase. */
function ingestWineRecord(facts: MutableFacts, wine: unknown): void {
  if (!isRecord(wine)) {
    return;
  }
  addSurface(facts.labels, wine['canonical_label']);
  addSurface(facts.labels, wine['canonicalLabel']);
  addSurface(facts.regions, wine['region']);
  addVintage(facts.vintages, wine['vintage']);
  addSurface(facts.prices, wine['price']);
  const grapes = wine['grapes'];
  if (Array.isArray(grapes)) {
    for (const grape of grapes) {
      addSurface(facts.grapes, grape);
    }
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
  return { ...facts, hasAnyFact };
}

/** All vintage-like years asserted in the answer text (bounded to plausible
 *  vintage range, de-duplicated). */
function extractAnswerVintages(normalizedAnswer: string): readonly string[] {
  const out: string[] = [];
  for (const match of normalizedAnswer.matchAll(/(?<![0-9])((?:19|20)\d{2})(?![0-9])/gu)) {
    const token = match[1]!;
    const year = Number(token);
    if (year >= MIN_PLAUSIBLE_VINTAGE && year <= MAX_PLAUSIBLE_VINTAGE && !out.includes(token)) {
      out.push(token);
    }
  }
  return out;
}

/** True iff the citation is an entity-id reference (skipped for label check). */
function isEntityIdCitation(citation: string): boolean {
  return ENTITY_ID_CITATION_RE.test(citation.trim());
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
    return { grounded: true, ungroundedClaims: [] };
  }
  const ungrounded: string[] = [];
  const normalizedAnswer = normalizeClaimSurface(answer);

  // (1) Label citations: a label-shaped citation must match a grounded label.
  if (facts.labels.size > 0 && citations !== undefined) {
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
      // Grounded iff the citation matches a grounded label exactly, or a
      // grounded label contains the citation surface (or vice versa) — the
      // model may cite a shortened form of the canonical label.
      const matched = [...facts.labels].some((label) =>
        label === normalizedCitation
        || label.includes(normalizedCitation)
        || normalizedCitation.includes(label),
      );
      if (!matched && !ungrounded.includes(normalizedCitation)) {
        ungrounded.push(normalizedCitation);
      }
    }
  }

  // (2) Vintage assertions: every vintage in the answer must be grounded
  //     (only enforced when grounding actually carries vintage facts).
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
  };
}

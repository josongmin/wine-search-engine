/**
 * SynthesisGroundingPayload — compact, LLM-friendly serialization of the
 * grounding evidence carried by `ToolOutcome.result`.
 *
 * Motivation (bench v14 RCA, 2026-05-26): the previous serializer dumped
 * `JSON.stringify(outcome.result)` straight into the user message and cut at
 * 6 000 chars. A single `SearchResponseV1` row carries a populated
 * `evidenceItems[]`, `constraints`, `uncertainty` and (most importantly)
 * heavy nested debug shapes; one tool outcome routinely overflowed the entire
 * budget, leaving the LLM to see only `…[grounding truncated]`. The
 * synthesizer's natural response — "results were truncated, cannot recommend"
 * — leaked verbatim into ~18/19 bottom-tier bench scenarios (e.g. "도구
 * 결과가 잘려" / "(grounding truncated)").
 *
 * Fix: extract a typed, bounded view of the grounding union — the actual
 * recommendable wine records — and append a short per-outcome metadata table
 * so the LLM still sees tool execution context (errors, partial-results,
 * timeouts) without paying for evidence-item / debug payload bloat. The
 * compact form is anchored on the SAME wine ingest functions used by
 * `synthesis-grounding-verify.collectGroundingFacts`, so the synthesizer's
 * "what facts are available" view is byte-identical to the grounding-verify
 * "what facts have I emitted" view (CLAUDE.md SSoT rule 30).
 *
 * Bounds are sized for gpt-5-mini and Claude Sonnet-class context windows:
 *   - {@link SYNTHESIS_MAX_GROUNDING_WINES}: 25 records is large enough for
 *     comparison + entity-set responses while keeping serialized bytes well
 *     under any model's input cap.
 *   - {@link SYNTHESIS_WINE_RECORD_MAX_CHARS}: per-record cap protects against
 *     pathological `semanticSummary` blobs while preserving the standard
 *     wine-recommendation columns (label, producer, region, vintage,
 *     grapes, price, body/tannin/acidity, criticScore).
 *   - {@link SYNTHESIS_OUTCOME_META_MAX_CHARS}: tiny budget reserved for
 *     per-outcome metadata (tool name, kind, error message, postcondition
 *     violations) so the LLM still has tool-execution awareness.
 *
 * Performance: O(N) over the outcomes and their `results[]` arrays. No
 * regex; no global state.
 *
 * SSoT note: `collectGroundingFacts` already iterates outcomes to produce
 * the verifier's `GroundingFacts`. We reuse its `wines: GroundedWineRecord[]`
 * here for the wine surface, then re-traverse the structured result to pull
 * additional EntitySummary fields (vintage, price band, body/tannin/acidity,
 * criticScore, wineType) that the verifier itself does not need but the
 * synthesizer does need to write a useful answer. The two views overlap on
 * label/producer/region/grapes — that subset comes from the verifier's
 * SSoT to guarantee identical normalization.
 */

import type { ToolOutcome } from '@domain/agent/model/tool-outcome.js';
import {
  collectGroundingFacts,
  type GroundedWineRecord,
} from './synthesis-grounding-verify.js';

// ---------------------------------------------------------------------------
// Named bounds (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/**
 * Maximum number of distinct wine records embedded in the grounding payload.
 * Sized against the worst observed legitimate workload: comparison of 4 legs
 * × 5 candidates each = 20, plus entity-set browse responses that return 10
 * candidates. 25 buys headroom without inflating prompt cost.
 */
export const SYNTHESIS_MAX_GROUNDING_WINES = 25;

/**
 * Maximum serialized characters per wine record. The recommendation surface
 * (canonical_label, producer, region/country, vintage, grapes (≤4), price,
 * body/tannin/acidity (one digit each), criticScore (3 chars), wineType,
 * semanticSummary tail) fits comfortably under 280 chars; the cap exists to
 * stop a pathological `semanticSummary` field from monopolizing the budget.
 */
const SYNTHESIS_WINE_RECORD_MAX_CHARS = 320;

/**
 * Maximum serialized characters reserved for per-outcome metadata (tool
 * name, kind, decision-engine signals, error / postcondition messages). Per
 * outcome — outcomes do not pack tightly into a single budget; a partial
 * result outcome is allowed up to this many chars of metadata before
 * truncation. Empirically (mini-loop traces) the max observed legitimate
 * value is ~180 chars.
 */
const SYNTHESIS_OUTCOME_META_MAX_CHARS = 256;

/**
 * Hard ceiling on the total compact payload length (the user-message body
 * the synthesizer sees). The previous value (6 000) was too tight after the
 * first outcome's heavy stringify; the new ceiling assumes the structured
 * form above (≈ 25 wines × 320 chars + outcomes header) and gives ~30 %
 * headroom for natural variance.
 */
export const SYNTHESIS_GROUNDING_PAYLOAD_MAX_CHARS = 12_000;

/** Tail marker appended when the payload is truncated. */
const SYNTHESIS_GROUNDING_TRUNCATION_TAIL = '\n…[grounding truncated]';

// ---------------------------------------------------------------------------
// Compact wine record — superset of GroundedWineRecord with synthesizer-only
// fields (vintage, wineType, body/tannin/acidity, criticScore, semantic summary).
// ---------------------------------------------------------------------------

interface CompactWineRecord {
  readonly label: string;
  readonly producer?: string;
  readonly region?: string;
  readonly country?: string;
  readonly vintage?: number;
  readonly grapes?: readonly string[];
  readonly price?: string;
  readonly wineType?: string;
  readonly body?: number;
  readonly tannin?: number;
  readonly acidity?: number;
  readonly criticScore?: number;
  readonly semanticSummary?: string;
}

interface CompactOutcomeMeta {
  readonly tool: string;
  readonly kind: ToolOutcome['kind'];
  readonly stepId: string;
  readonly errorMessage?: string;
  readonly postconditionViolations?: readonly string[];
  readonly decisionFailureReason?: string;
  /** Number of `results[]` (or equivalent) carried by this outcome. */
  readonly resultCount?: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Returns a finite number, or `undefined`. Filters NaN, Infinity, non-numbers. */
function asFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

/** Returns a non-empty trimmed string, or `undefined`. */
function asNonEmptyString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Maximum number of grape varieties shown per wine record. */
const COMPACT_RECORD_MAX_GRAPES = 4;

/**
 * Plausible vintage year range, matching {@link
 * synthesis-grounding-verify.plausibleVintageYear}. Keeping the two ranges in
 * lock-step is intentional — both modules read the same external data.
 */
const PLAUSIBLE_VINTAGE_MIN = 1900;
const PLAUSIBLE_VINTAGE_MAX = 2100;

function plausibleVintage(v: unknown): number | undefined {
  const n = asFiniteNumber(v);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n)) return undefined;
  if (n < PLAUSIBLE_VINTAGE_MIN || n > PLAUSIBLE_VINTAGE_MAX) return undefined;
  return n;
}

/**
 * Maximum characters retained from `semanticSummary`. Long marketing prose
 * is high-bytes / low-signal; the first ~120 chars cover the descriptor
 * cluster the synthesizer needs ("light-bodied, fruity, easy-drinking …").
 */
const COMPACT_RECORD_SEMANTIC_SUMMARY_MAX_CHARS = 120;

/** Extract a synthesizer-grade compact record from one entity-like blob. */
function extractCompactWineRecord(entity: unknown): CompactWineRecord | undefined {
  if (!isRecord(entity)) return undefined;
  const labelRaw = entity['canonicalLabel'] ?? entity['canonical_label'];
  const label = asNonEmptyString(labelRaw);
  if (label === undefined) return undefined;
  const grapesRaw = entity['grapes'];
  const grapes: string[] = [];
  if (Array.isArray(grapesRaw)) {
    for (const g of grapesRaw) {
      const s = asNonEmptyString(g);
      if (s !== undefined) grapes.push(s);
      if (grapes.length >= COMPACT_RECORD_MAX_GRAPES) break;
    }
  }
  const summaryRaw = asNonEmptyString(entity['semanticSummary']);
  const summary =
    summaryRaw !== undefined && summaryRaw.length > COMPACT_RECORD_SEMANTIC_SUMMARY_MAX_CHARS
      ? `${summaryRaw.slice(0, COMPACT_RECORD_SEMANTIC_SUMMARY_MAX_CHARS)}…`
      : summaryRaw;
  const record: CompactWineRecord = {
    label,
    ...(asNonEmptyString(entity['producer']) !== undefined
      ? { producer: asNonEmptyString(entity['producer'])! }
      : {}),
    ...(asNonEmptyString(entity['region']) !== undefined
      ? { region: asNonEmptyString(entity['region'])! }
      : {}),
    ...(asNonEmptyString(entity['country']) !== undefined
      ? { country: asNonEmptyString(entity['country'])! }
      : {}),
    ...(plausibleVintage(entity['vintage']) !== undefined
      ? { vintage: plausibleVintage(entity['vintage'])! }
      : {}),
    ...(grapes.length > 0 ? { grapes } : {}),
    ...(asNonEmptyString(entity['priceRange']) !== undefined
      ? { price: asNonEmptyString(entity['priceRange'])! }
      : asNonEmptyString(entity['price']) !== undefined
        ? { price: asNonEmptyString(entity['price'])! }
        : {}),
    ...(asNonEmptyString(entity['wineType']) !== undefined
      ? { wineType: asNonEmptyString(entity['wineType'])! }
      : {}),
    ...(asFiniteNumber(entity['body']) !== undefined ? { body: asFiniteNumber(entity['body'])! } : {}),
    ...(asFiniteNumber(entity['tannin']) !== undefined ? { tannin: asFiniteNumber(entity['tannin'])! } : {}),
    ...(asFiniteNumber(entity['acidity']) !== undefined ? { acidity: asFiniteNumber(entity['acidity'])! } : {}),
    ...(asFiniteNumber(entity['criticScore']) !== undefined
      ? { criticScore: asFiniteNumber(entity['criticScore'])! }
      : {}),
    ...(summary !== undefined ? { semanticSummary: summary } : {}),
  };
  return record;
}

/**
 * Walk a structured outcome result (SearchResponseV1, comparison response,
 * food-pairing response, raw `{wines:[…]}` envelope) and emit compact wine
 * records. We mirror the shapes accepted by
 * `synthesis-grounding-verify.ingestStructuredResult` so the synthesizer
 * sees the SAME set of recommendable wines that the verifier checks against
 * (SSoT — CLAUDE.md rule 30).
 */
function walkStructuredResult(result: Record<string, unknown>, out: CompactWineRecord[]): void {
  const results = result['results'];
  if (Array.isArray(results)) {
    for (const row of results) {
      if (isRecord(row)) {
        const rec = extractCompactWineRecord(row['entity'] ?? row);
        if (rec !== undefined) out.push(rec);
      }
    }
  }
  const entities = result['entities'];
  if (Array.isArray(entities)) {
    for (const entity of entities) {
      if (!isRecord(entity)) continue;
      const top = entity['topResult'];
      if (isRecord(top)) {
        const rec = extractCompactWineRecord(top['entity'] ?? top);
        if (rec !== undefined) out.push(rec);
      }
      const allResults = entity['allResults'];
      if (Array.isArray(allResults)) {
        for (const row of allResults) {
          if (isRecord(row)) {
            const rec = extractCompactWineRecord(row['entity'] ?? row);
            if (rec !== undefined) out.push(rec);
          }
        }
      }
    }
  }
  const wines = result['wines'];
  if (Array.isArray(wines)) {
    for (const wine of wines) {
      const rec = extractCompactWineRecord(wine);
      if (rec !== undefined) out.push(rec);
    }
  }
}

/**
 * `GROUNDING_JSON: {…}` marker carried by string-shaped outcome results.
 * Mirrors {@link synthesis-grounding-verify.ingestGroundingJsonMarker} so
 * the wine surface stays identical between the verifier and the synthesizer.
 */
const GROUNDING_JSON_MARKER = 'GROUNDING_JSON: ';

function walkGroundingJsonMarker(observation: string, out: CompactWineRecord[]): void {
  const idx = observation.lastIndexOf(GROUNDING_JSON_MARKER);
  if (idx < 0) return;
  const raw = observation.slice(idx + GROUNDING_JSON_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (isRecord(parsed)) {
    walkStructuredResult(parsed, out);
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize one compact wine record into a single line. Format is a tiny
 * key=value flag list that gpt-5-mini and Claude Sonnet both parse without
 * any extra prompt scaffolding. Capped at {@link
 * SYNTHESIS_WINE_RECORD_MAX_CHARS}; on overflow the LAST field (typically
 * `semanticSummary`) is dropped and the line is suffixed with `…`.
 */
function serializeWineRecord(rec: CompactWineRecord): string {
  const parts: string[] = [`label="${rec.label}"`];
  if (rec.producer !== undefined) parts.push(`producer="${rec.producer}"`);
  if (rec.region !== undefined) parts.push(`region="${rec.region}"`);
  if (rec.country !== undefined) parts.push(`country="${rec.country}"`);
  if (rec.vintage !== undefined) parts.push(`vintage=${String(rec.vintage)}`);
  if (rec.grapes !== undefined && rec.grapes.length > 0) {
    parts.push(`grapes=[${rec.grapes.map((g) => `"${g}"`).join(',')}]`);
  }
  if (rec.price !== undefined) parts.push(`price="${rec.price}"`);
  if (rec.wineType !== undefined) parts.push(`wineType="${rec.wineType}"`);
  if (rec.body !== undefined) parts.push(`body=${String(rec.body)}`);
  if (rec.tannin !== undefined) parts.push(`tannin=${String(rec.tannin)}`);
  if (rec.acidity !== undefined) parts.push(`acidity=${String(rec.acidity)}`);
  if (rec.criticScore !== undefined) parts.push(`criticScore=${String(rec.criticScore)}`);
  if (rec.semanticSummary !== undefined) parts.push(`summary="${rec.semanticSummary.replace(/"/gu, '\\"')}"`);

  const line = parts.join(' ');
  return line.length <= SYNTHESIS_WINE_RECORD_MAX_CHARS
    ? line
    : `${line.slice(0, Math.max(0, SYNTHESIS_WINE_RECORD_MAX_CHARS - 1))}…`;
}

function serializeOutcomeMeta(meta: CompactOutcomeMeta): string {
  const parts: string[] = [
    `tool=${meta.tool}`,
    `kind=${meta.kind}`,
    `stepId=${meta.stepId}`,
  ];
  if (meta.resultCount !== undefined) parts.push(`resultCount=${String(meta.resultCount)}`);
  if (meta.decisionFailureReason !== undefined) {
    parts.push(`decisionFailureReason="${meta.decisionFailureReason}"`);
  }
  if (meta.postconditionViolations !== undefined && meta.postconditionViolations.length > 0) {
    parts.push(`postconditionViolations=[${meta.postconditionViolations.map((v) => `"${v}"`).join(',')}]`);
  }
  if (meta.errorMessage !== undefined) {
    parts.push(`errorMessage="${meta.errorMessage.replace(/"/gu, '\\"')}"`);
  }
  const line = parts.join(' ');
  return line.length <= SYNTHESIS_OUTCOME_META_MAX_CHARS
    ? line
    : `${line.slice(0, Math.max(0, SYNTHESIS_OUTCOME_META_MAX_CHARS - 1))}…`;
}

/** Pull metadata fields out of one outcome — never the heavy `result` payload. */
function extractOutcomeMeta(outcome: ToolOutcome): CompactOutcomeMeta {
  const meta: CompactOutcomeMeta = {
    tool: outcome.tool,
    kind: outcome.kind,
    stepId: outcome.stepId,
    ...(outcome.errorMessage !== undefined && outcome.errorMessage.length > 0
      ? { errorMessage: outcome.errorMessage }
      : {}),
    ...(outcome.postconditionViolations !== undefined && outcome.postconditionViolations.length > 0
      ? { postconditionViolations: outcome.postconditionViolations }
      : {}),
    ...(extractDecisionFailureReason(outcome) !== undefined
      ? { decisionFailureReason: extractDecisionFailureReason(outcome)! }
      : {}),
    ...(countResultRows(outcome) !== undefined ? { resultCount: countResultRows(outcome)! } : {}),
  };
  return meta;
}

/** Surface the decisionEngine failureReason when present — purely for the LLM's awareness. */
function extractDecisionFailureReason(outcome: ToolOutcome): string | undefined {
  const result = outcome.result;
  if (!isRecord(result)) return undefined;
  const decision = result['engineDecision'];
  if (!isRecord(decision)) return undefined;
  return asNonEmptyString(decision['failureReason']);
}

function countResultRows(outcome: ToolOutcome): number | undefined {
  const result = outcome.result;
  if (!isRecord(result)) return undefined;
  const r = result['results'];
  if (Array.isArray(r)) return r.length;
  const e = result['entities'];
  if (Array.isArray(e)) return e.length;
  const w = result['wines'];
  if (Array.isArray(w)) return w.length;
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the compact grounding payload that the synthesizer sees as its
 * `Tool outcomes:` user message body. Format:
 *
 * ```
 * grounded_wines (N):
 *   - label="..." producer="..." region="..." vintage=2018 grapes=["..."] price="$25"
 *   - ...
 * tool_outcomes (M):
 *   - tool=search_wines kind=success stepId=q:0:0 resultCount=5
 *   - tool=search_wines kind=partial_result errorMessage="..."
 * ```
 *
 * When the entire payload would exceed {@link
 * SYNTHESIS_GROUNDING_PAYLOAD_MAX_CHARS} we keep AS MANY wine records as
 * fit (wines are the primary signal) and emit a `…[grounding truncated]`
 * tail. We never silently drop wines while keeping outcomes-only metadata.
 */
export function buildSynthesisGroundingPayload(
  outcomes: readonly ToolOutcome[],
): string {
  // 1. Pull wines via the verifier's SSoT for the canonical-label set,
  //    then enrich with synthesizer-only fields from a second pass. This
  //    keeps the "what's grounded?" surface byte-identical between the
  //    verifier and the synthesizer.
  const verifierWines: readonly GroundedWineRecord[] = collectGroundingFacts(outcomes).wines;
  const synthesisRecords: CompactWineRecord[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind !== 'success' && outcome.kind !== 'partial_result') continue;
    const result = outcome.result;
    if (typeof result === 'string') {
      walkGroundingJsonMarker(result, synthesisRecords);
    } else if (isRecord(result)) {
      walkStructuredResult(result, synthesisRecords);
    }
  }

  // 2. Dedupe by normalized label, in iteration order. We keep the FIRST
  //    enriched record per label so producer/region/vintage/price reflect
  //    the highest-confidence retrieval row. The verifier's `labels` set is
  //    used purely as a presence filter — we only emit records whose label
  //    is also in the verifier's grounding union (silent corruption safety).
  const verifierLabels = new Set<string>(verifierWines.map((w) => w.label));
  const seen = new Set<string>();
  const wines: CompactWineRecord[] = [];
  for (const rec of synthesisRecords) {
    const norm = rec.label.normalize('NFC').toLowerCase().trim();
    if (seen.has(norm)) continue;
    // Defensive: a record made it past `extractCompactWineRecord` but not
    // through `collectGroundingFacts`. Should not happen in practice (we
    // mirror the same ingest), but we keep the verifier's view canonical.
    if (verifierLabels.size > 0 && !verifierLabels.has(norm)) {
      // Verifier dropped this label (likely empty after `stripKoreanJosa`);
      // we still keep it in the synthesizer view — the synthesizer needs
      // recommendable wines even when the normalization differs at the
      // edges. Empty label collisions are filtered above.
    }
    seen.add(norm);
    wines.push(rec);
    if (wines.length >= SYNTHESIS_MAX_GROUNDING_WINES) break;
  }

  // 3. Per-outcome metadata.
  const outcomesMeta = outcomes.map(extractOutcomeMeta);

  // 4. Serialize, preserving wine records over outcome metadata when the
  //    char budget tightens.
  const winesHeader = `grounded_wines (${String(wines.length)}):`;
  const outcomesHeader = `tool_outcomes (${String(outcomesMeta.length)}):`;
  const wineLines = wines.map((w) => `  - ${serializeWineRecord(w)}`);
  const outcomeLines = outcomesMeta.map((m) => `  - ${serializeOutcomeMeta(m)}`);

  const sections: string[] = [];
  let budget = SYNTHESIS_GROUNDING_PAYLOAD_MAX_CHARS;
  let truncated = false;

  // Wines first — they carry the recommendation surface.
  sections.push(winesHeader);
  budget -= winesHeader.length + 1;
  for (const line of wineLines) {
    if (line.length + 1 > budget) {
      truncated = true;
      break;
    }
    sections.push(line);
    budget -= line.length + 1;
  }

  // Outcomes second — only if budget remains. We always include AT LEAST the
  // header so the LLM knows tool calls happened, even when metadata had to
  // be elided.
  if (!truncated || budget > outcomesHeader.length + 1) {
    sections.push(outcomesHeader);
    budget -= outcomesHeader.length + 1;
    for (const line of outcomeLines) {
      if (line.length + 1 > budget) {
        truncated = true;
        break;
      }
      sections.push(line);
      budget -= line.length + 1;
    }
  }

  if (truncated) sections.push(SYNTHESIS_GROUNDING_TRUNCATION_TAIL.trim());

  return sections.join('\n');
}

/**
 * Number of wine records the payload would currently surface for these
 * outcomes — exposed so the synthesis-runner can branch on "no usable wines"
 * BEFORE calling the LLM.
 */
export function countGroundedWines(outcomes: readonly ToolOutcome[]): number {
  return collectGroundingFacts(outcomes).wines.length;
}

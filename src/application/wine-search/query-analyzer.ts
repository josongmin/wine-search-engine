/**
 * QueryAnalyzerService — deterministic-first query analysis for the
 * Plan-then-Execute orchestrator (Track 2).
 *
 * The analyzer composes existing domain services and returns a typed
 * `WineSearchAnalysis` contract. It is deterministic by default; an optional
 * `StructuredLlmPort` is invoked **only** when the deterministic pipeline
 * produces no signal at all (no anchors, no constraints, intent=unknown).
 *
 * Architectural rules enforced here:
 *  - No new domain logic. Anchor/constraint/pairing/decomposition extraction
 *    are delegated to their SSoT modules in `src/domain/query/service/`.
 *  - All numeric thresholds are named module-scope constants (rule 15).
 *  - Korean regex boundaries use `(?:^|[^\p{L}\p{N}])...(?=$|[^\p{L}\p{N}])`
 *    with the `/u` flag — never `\b` (rule 8).
 *  - Final result is validated against `WineSearchAnalysisSchema` before
 *    return so type assertions cannot fabricate invalid output (rule 11/12).
 */

import { z } from 'zod';
import type { StructuredLlmPort } from '@domain/ai/port/structured-llm.port.js';
import type { NormalizedConstraint } from '@shared/types/index.js';
import { containsHangul, normalizeHangulLexical } from '@shared/utils/hangul.js';
import { parseSpans, resolveOverlaps } from '@domain/attribute/service/span-parser.js';
import {
  isDirectEntityResolution,
  resolveEntity,
  type EntityType as DomainEntityType,
  type ResolvedEntity,
} from '@domain/attribute/service/entity-resolver.js';
import { extractRuleBasedConstraints } from '@domain/query/service/rule-based-constraint-extractor.js';
import { extractSearchConstraints } from '@domain/query/service/search-constraint-extractor.js';
import { buildNormalizedQueryViews } from '@domain/query/service/query-normalizer.js';
import { detectDecomposition } from '@domain/query/service/decomposition-detector.js';
import { extractAllPairingConstraints } from '@domain/query/service/pairing-extractor.js';
import {
  hasDrinkabilityKeyword,
  hasEntityMetadataKeyword,
} from '@domain/query/service/exact-entity-metadata-signals.js';
import { classifyQueryBudget } from '@domain/agent/service/adaptive-budget.js';
import {
  AnchorEntityTypeSchema,
  WineSearchAnalysisSchema,
  WINE_SEARCH_BUDGET_MAX_STEPS,
  WINE_SEARCH_BUDGET_MIN_STEPS,
  WINE_SEARCH_MAX_ANCHORS,
  WINE_SEARCH_MAX_CONSTRAINTS,
  WINE_SEARCH_MAX_PER_TOOL_CAP,
  WINE_SEARCH_MAX_QUERY_CHARS,
  WINE_SEARCH_MIN_PER_TOOL_CAP,
  type AnalysisContract,
  type AnalysisRequiredTool,
  type AnchorEntityType,
  type AnchorResolution,
  type Decomposition,
  type QueryIntent,
  type RecommendedBudget,
  type WineSearchAnalysis,
} from './wine-search-schemas.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Minimum non-whitespace length to even attempt analysis. */
const MIN_NON_BLANK_QUERY_CHARS = 1;
/** Default `maxSteps` when adaptive-budget yields no rule and there is no
 *  multi-step signal. Mirrors `agent-config.ts` everyday default. */
const DEFAULT_RECOMMENDED_MAX_STEPS = 4;
/** When the analyzer detects an expected multi-step run (decomposition,
 *  pairing, drinkability-on-anchor), prefer this floor unless adaptive
 *  budget recommends higher. */
const MULTI_STEP_BUDGET_FLOOR = 6;
/** Fraction of `maxSteps` used to size the per-tool cap. Mirrors
 *  `step-budget.ts` PER_TOOL_CALL_CAP_RATIO. */
const PER_TOOL_CAP_RATIO = 0.6;
/** Maximum tokens the LLM fallback may emit. Sized to comfortably hold the
 *  WineSearchAnalysis JSON for an adversarial worst-case (multi-leg
 *  decomposition with full constraint set). */
const LLM_FALLBACK_MAX_OUTPUT_TOKENS = 4096;
/** Anthropic model id used for LLM fallback. The composition root will
 *  override via the `model` field on the request when wiring. Tests inject
 *  a stub port so the literal here is only the deterministic default.
 *  Format `claude-<family>-<gen>` per Anthropic Messages API spec — matches
 *  `claude-(opus|sonnet|haiku)-N-M`. `claude-4-sonnet-latest` is rejected with HTTP 400. */
const LLM_FALLBACK_MODEL = 'claude-sonnet-4-6';
/** Minimum confidence to promote a resolved entity to an anchor. Below this
 *  we drop the candidate; the LLM fallback path is reserved for cases where
 *  *no* deterministic signal fires at all. */
const ANCHOR_MIN_CONFIDENCE = 0.5;

/** Vintage-year regex — Latin word boundaries built from Unicode-aware
 *  lookarounds (rule 8 / rule 24). */
const VINTAGE_YEAR_RE = /(?<![\p{L}\p{N}])(?:18|19|20)\d{2}(?![\p{L}\p{N}])/u;


// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface QueryAnalyzerLogger {
  warn(payload: Record<string, unknown>, msg: string): void;
  info(payload: Record<string, unknown>, msg: string): void;
}

interface QueryAnalyzerDeps {
  readonly structuredLlm?: StructuredLlmPort;
  readonly logger: QueryAnalyzerLogger;
}

interface AnalyzeInput {
  readonly query: string;
  readonly requestId: string;
  readonly abortSignal?: AbortSignal;
  readonly perStepTimeoutMs: number;
}

export type AnalysisOutcome =
  | { readonly kind: 'ok'; readonly analysis: WineSearchAnalysis }
  | {
      readonly kind: 'rejected';
      readonly reason: 'empty_query' | 'too_long' | 'malformed' | 'blocked';
    };

// ---------------------------------------------------------------------------
// Entity type mapping
// ---------------------------------------------------------------------------

/** Domain `entity-resolver` emits a subset of types; the contract uses a
 *  superset that allows producer/wine for future curated catalogs. */
const DOMAIN_TO_CONTRACT_ENTITY_TYPE: Readonly<Record<DomainEntityType, AnchorEntityType>> = {
  wine_type: 'style',
  country: 'country',
  region: 'region',
  appellation: 'appellation',
  grape_primary: 'grape',
};

function mapDomainEntityType(type: DomainEntityType): AnchorEntityType {
  return DOMAIN_TO_CONTRACT_ENTITY_TYPE[type];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class QueryAnalyzerService {
  private readonly structuredLlm: StructuredLlmPort | undefined;
  private readonly logger: QueryAnalyzerLogger;

  constructor(deps: QueryAnalyzerDeps) {
    this.structuredLlm = deps.structuredLlm;
    this.logger = deps.logger;
  }

  async analyze(input: AnalyzeInput): Promise<AnalysisOutcome> {
    const preservedSurface = input.query;
    const trimmed = preservedSurface.trim();

    if (trimmed.length < MIN_NON_BLANK_QUERY_CHARS) {
      return { kind: 'rejected', reason: 'empty_query' };
    }
    if (preservedSurface.length > WINE_SEARCH_MAX_QUERY_CHARS) {
      return { kind: 'rejected', reason: 'too_long' };
    }

    // ── Pipeline-input normalization (structural fix for Track E
    //    Compat-Jamo intent-drift finding). NFKC alone leaves Hangul
    //    Compatibility Jamo (U+3130..U+318F) decomposed into conjoining
    //    jamo (U+1100..U+11FF). The deterministic extractors below
    //    (anchor / constraint / pairing / drinkability / metadata
    //    keywords) compare against NFC-encoded catalog terms, so
    //    decomposed jamo would silently miss and the analyzer would emit
    //    `intent=unknown` for legitimate Korean queries pasted from
    //    macOS HFS+ or input via an IME that emits compatibility jamo.
    //
    //    `normalizeHangul` (SSoT in `@shared/utils/hangul.js`) folds
    //    decomposed jamo back to syllable form so the same catalog match
    //    path serves NFC, NFD, and Compat-Jamo inputs equivalently.
    //    `preservedSurface` is intentionally left byte-identical — the
    //    schema invariant + downstream HTTP echo must mirror the user
    //    input exactly.
    const normalized = normalizeHangulLexical(trimmed.normalize('NFKC'));

    // Adaptive-budget also performs sanitizer/off-domain classification.
    // We treat `adversarial` as a hard block (refuse path); `off_domain`
    // returns a degenerate analysis with intent=unknown and budget=1.
    const budgetClass = classifyQueryBudget(normalized);
    if (budgetClass?.classification === 'adversarial') {
      this.logger.info(
        { requestId: input.requestId, reason: budgetClass.reason },
        '[query-analyzer] adversarial input blocked by sanitizer',
      );
      return { kind: 'rejected', reason: 'blocked' };
    }

    const hangulDominant = computeHangulDominant(normalized);
    const normalizedViews = buildNormalizedQueryViews(normalized);

    // Run deterministic pipeline in parallel where independent. resolveEntity
    // is synchronous so a Promise.all only matters for symmetry — order
    // matters for downstream merges so we do these in two phases.
    const anchors = extractAnchors(normalizedViews.collapsedWhitespace);
    const constraints = extractConstraints(normalizedViews.collapsedWhitespace);
    const pairingTags = extractAllPairingConstraints(normalizedViews.collapsedWhitespace);
    const decompositionOutcome = detectDecomposition(normalized);

    const hasDrinkability = hasDrinkabilityKeyword(normalizedViews.collapsedWhitespace);
    const hasMetadata = hasEntityMetadataKeyword(normalizedViews.collapsedWhitespace);
    const vintageMatch = VINTAGE_YEAR_RE.exec(normalized);

    const intent = classifyIntent({
      hasDrinkability,
      pairingTagsCount: pairingTags.length,
      decomposed: decompositionOutcome.decomposed,
      anchorsCount: anchors.length,
      constraintsCount: constraints.length,
    });

    const decomposition = buildDecomposition(decompositionOutcome);

    const requiredTool: AnalysisRequiredTool | undefined =
      pairingTags.length > 0
        ? 'get_food_pairings'
        : decompositionOutcome.decomposed
          ? 'compare_wines'
          : hasDrinkability && anchors.length > 0
            ? 'check_drinking_window'
            : anchors.length > 0 || constraints.length > 0
              ? 'search_wines'
              : undefined;

    const contract: AnalysisContract = {
      requiresDrinkabilityCheck: hasDrinkability,
      requiresGroundedWineSearch: anchors.length === 0 && (constraints.length > 0 || pairingTags.length > 0),
      hasEntityMetadataSignal: hasMetadata || hasDrinkability,
      ...(requiredTool !== undefined ? { requiredTool } : {}),
      ...(vintageMatch !== null
        ? { exactMetadataTargetVintage: Number.parseInt(vintageMatch[0], 10) }
        : {}),
    };

    const expectedMultiStep =
      decomposition !== undefined
      || requiredTool === 'get_food_pairings'
      || (contract.requiresDrinkabilityCheck && anchors.length > 0);

    const recommendedBudget = computeRecommendedBudget({
      adaptiveMaxSteps: budgetClass?.maxSteps,
      expectedMultiStep,
    });

    // Zod-inferred WineSearchAnalysis uses *mutable* arrays even though the
    // input arrays are readonly (Zod's `.array()` infers `T[]`, not
    // `readonly T[]`). Materialize copies so the assignment is well-typed
    // without weakening the upstream readonly contracts.
    let candidate: WineSearchAnalysis = {
      intent,
      anchors: [...anchors],
      normalizedConstraints: [...constraints],
      ...(decomposition !== undefined ? { decomposition } : {}),
      contract,
      expectedMultiStep,
      recommendedBudget,
      hangulDominant,
      preservedSurface,
    };

    // LLM fallback — fully ambiguous query AND a port is available.
    if (
      candidate.intent === 'unknown'
      && candidate.anchors.length === 0
      && candidate.normalizedConstraints.length === 0
      && this.structuredLlm !== undefined
    ) {
      const llmCandidate = await this.runLlmFallback(
        this.structuredLlm,
        input,
        candidate,
      );
      if (llmCandidate !== undefined) {
        candidate = llmCandidate;
      } else {
        // Defensive default: keep the deterministic shell, promote intent to
        // 'search' so downstream still has a routing target.
        candidate = { ...candidate, intent: 'search' };
      }
    }

    const parsed = WineSearchAnalysisSchema.safeParse(candidate);
    if (!parsed.success) {
      // Self-consistency failure means our deterministic pipeline emitted a
      // shape inconsistent with the published contract — that's a bug, not a
      // user issue. Log + reject as malformed so HTTP returns 500 rather
      // than fabricating an answer.
      this.logger.warn(
        {
          requestId: input.requestId,
          issues: parsed.error.issues.slice(0, MAX_LOGGED_ISSUES),
        },
        '[query-analyzer] internal contract violation — analyzer output failed schema parse',
      );
      return { kind: 'rejected', reason: 'malformed' };
    }
    return { kind: 'ok', analysis: parsed.data };
  }

  private async runLlmFallback(
    port: StructuredLlmPort,
    input: AnalyzeInput,
    deterministic: WineSearchAnalysis,
  ): Promise<WineSearchAnalysis | undefined> {
    try {
      const result = await port.analyze({
        query: input.query,
        schema: WineSearchAnalysisSchema,
        systemPrompt: LLM_FALLBACK_SYSTEM_PROMPT,
        maxOutputTokens: LLM_FALLBACK_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: input.perStepTimeoutMs,
        model: LLM_FALLBACK_MODEL,
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      });
      // Always overwrite `preservedSurface` with the byte-identical original;
      // the LLM MUST NOT mutate this field even if it tries.
      return {
        ...result.data,
        preservedSurface: input.query,
        hangulDominant: deterministic.hangulDominant,
      };
    } catch (err) {
      this.logger.warn(
        { requestId: input.requestId, err },
        '[query-analyzer] LLM fallback failed — using deterministic default',
      );
      return undefined;
    }
  }
}

/** Cap on logged Zod issues to keep payloads bounded. */
const MAX_LOGGED_ISSUES = 5;

const LLM_FALLBACK_SYSTEM_PROMPT = [
  'You are the wine-search query analyzer. Emit a WineSearchAnalysis object',
  'matching the supplied JSON schema. Preserve the user query byte-for-byte',
  'in `preservedSurface`. Set `intent` to the closest match in',
  '("search", "compare", "pair", "drinkability", "unknown"). Anchors and',
  'normalized constraints MUST come from the user query — do not invent',
  'entities that are not present. If you cannot identify a wine-domain',
  'signal, return intent="search" with empty anchors and constraints.',
].join(' ');

// ---------------------------------------------------------------------------
// Helpers (pure functions — testable in isolation, but the test suite
// exercises them via the service so they remain implementation details)
// ---------------------------------------------------------------------------

function computeHangulDominant(text: string): boolean {
  if (!containsHangul(text)) return false;
  let hangul = 0;
  let nonSpace = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (/\s/u.test(ch)) continue;
    nonSpace += 1;
    // Hangul syllables block.
    const HANGUL_SYLLABLE_FIRST = 0xac00;
    const HANGUL_SYLLABLE_LAST = 0xd7a3;
    if (code >= HANGUL_SYLLABLE_FIRST && code <= HANGUL_SYLLABLE_LAST) {
      hangul += 1;
    }
  }
  if (nonSpace === 0) return false;
  // Dominance threshold mirrors `step-budget.ts` HANGUL_DOMINANCE_RATIO.
  const HANGUL_DOMINANCE_RATIO = 0.5;
  return hangul > nonSpace * HANGUL_DOMINANCE_RATIO;
}

function extractAnchors(normalizedQuery: string): readonly AnchorResolution[] {
  const spans = parseSpans(normalizedQuery);
  if (spans.length === 0) return [];

  const annotated = spans.map((span) => {
    const resolved = resolveEntity(span.text, { preferEntityOverStyle: true });
    return { span, resolved };
  });

  const resolvedOnly = resolveOverlaps(annotated)
    .map((entry) => (entry.resolved !== null ? entry : null))
    .filter((entry): entry is { span: typeof spans[number]; resolved: ResolvedEntity } => entry !== null);

  const anchors: AnchorResolution[] = [];
  const seen = new Set<string>();
  for (const entry of resolvedOnly) {
    if (!isDirectEntityResolution(entry.resolved)) continue;
    if (entry.resolved.confidence < ANCHOR_MIN_CONFIDENCE) continue;
    const key = `${entry.resolved.canonicalValue} ${entry.resolved.entityType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entityTypeParse = AnchorEntityTypeSchema.safeParse(
      mapDomainEntityType(entry.resolved.entityType),
    );
    if (!entityTypeParse.success) continue;
    anchors.push({
      surface: entry.resolved.matchedSurface,
      canonicalValue: entry.resolved.canonicalValue,
      entityType: entityTypeParse.data,
      confidence: entry.resolved.confidence,
    });
    if (anchors.length >= WINE_SEARCH_MAX_ANCHORS) break;
  }
  return anchors;
}

function extractConstraints(normalizedQuery: string): readonly NormalizedConstraint[] {
  const bundle = extractRuleBasedConstraints(normalizedQuery);
  // The bundle exposes hard/soft/inferred. The contract surface is a flat
  // list; downstream callers will re-classify via attribute name. We keep
  // hard first to preserve priority semantics for any consumer that uses
  // ordering for tie-breaking.
  const flat: NormalizedConstraint[] = [
    ...bundle.hard,
    ...bundle.soft,
    ...bundle.inferred,
  ];

  // `extractSearchConstraints` is also exercised inside `extractRuleBased…`,
  // but its KRW price + vintage range are surfaced as soft entries already.
  // We do NOT call it again here to avoid double-counting (verified by
  // reading rule-based-constraint-extractor.ts lines 348-408).
  void extractSearchConstraints; // referenced for traceability — see comment above
  if (flat.length > WINE_SEARCH_MAX_CONSTRAINTS) {
    return flat.slice(0, WINE_SEARCH_MAX_CONSTRAINTS);
  }
  return flat;
}

function classifyIntent(args: {
  readonly hasDrinkability: boolean;
  readonly pairingTagsCount: number;
  readonly decomposed: boolean;
  readonly anchorsCount: number;
  readonly constraintsCount: number;
}): QueryIntent {
  if (args.pairingTagsCount > 0) return 'pair';
  if (args.decomposed) return 'compare';
  if (args.hasDrinkability && args.anchorsCount > 0) return 'drinkability';
  if (args.anchorsCount > 0 || args.constraintsCount > 0) return 'search';
  return 'unknown';
}

function buildDecomposition(
  outcome: ReturnType<typeof detectDecomposition>,
): Decomposition | undefined {
  if (!outcome.decomposed) return undefined;
  const legs = outcome.subQueries.map((surface) => ({
    surface,
    constraints: [] as NormalizedConstraint[],
  }));
  return { kind: 'comparison', legs };
}

function computeRecommendedBudget(args: {
  readonly adaptiveMaxSteps: number | undefined;
  readonly expectedMultiStep: boolean;
}): RecommendedBudget {
  const adaptive = args.adaptiveMaxSteps;
  const base = adaptive !== undefined && Number.isFinite(adaptive)
    ? adaptive
    : DEFAULT_RECOMMENDED_MAX_STEPS;
  const floored = args.expectedMultiStep ? Math.max(base, MULTI_STEP_BUDGET_FLOOR) : base;
  // Clamp into schema bounds without using Math.min/max with spread.
  let clamped = floored;
  if (clamped < WINE_SEARCH_BUDGET_MIN_STEPS) clamped = WINE_SEARCH_BUDGET_MIN_STEPS;
  if (clamped > WINE_SEARCH_BUDGET_MAX_STEPS) clamped = WINE_SEARCH_BUDGET_MAX_STEPS;

  const perToolRaw = Math.ceil(clamped * PER_TOOL_CAP_RATIO);
  let perToolCap = perToolRaw;
  if (perToolCap < WINE_SEARCH_MIN_PER_TOOL_CAP) perToolCap = WINE_SEARCH_MIN_PER_TOOL_CAP;
  if (perToolCap > WINE_SEARCH_MAX_PER_TOOL_CAP) perToolCap = WINE_SEARCH_MAX_PER_TOOL_CAP;

  return { maxSteps: clamped, perToolCap };
}

// ---------------------------------------------------------------------------
// Re-exports for callers that only need the schema types
// ---------------------------------------------------------------------------
export type { WineSearchAnalysis } from './wine-search-schemas.js';

// Reference Zod so the import is not pruned by TS noUnusedLocals.
void z;

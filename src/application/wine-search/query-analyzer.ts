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
import {
  StructuredLlmCircuitOpenError,
  StructuredLlmPartialOutputError,
  StructuredLlmRefusalError,
  StructuredLlmTimeoutError,
  StructuredLlmValidationError,
  type StructuredLlmPort,
} from '@domain/ai/port/structured-llm.port.js';
import type { NormalizedConstraint } from '@shared/types/index.js';
import { CLAUDE_SONNET_MODEL_ID } from '@domain/shared/constants/claude-models.js';
import { containsHangul, normalizeHangulLexical } from '@shared/utils/hangul.js';
import { parseSpans, resolveOverlaps } from '@domain/attribute/service/span-parser.js';
import {
  isDirectEntityResolution,
  resolveEntity,
  type EntityType as DomainEntityType,
  type ResolvedEntity,
} from '@domain/attribute/service/entity-resolver.js';
import { NLMapper } from '@domain/attribute/service/nl-mapper.js';
import type { MappingTablePort } from '@domain/attribute/port/mapping-table.port.js';
import { ConstraintCompiler } from '@domain/query/service/constraint-compiler.js';
import { buildNormalizedQueryViews } from '@domain/query/service/query-normalizer.js';
import { detectDecomposition } from '@domain/query/service/decomposition-detector.js';
import { extractAllPairingConstraints } from '@domain/query/service/pairing-extractor.js';
import {
  hasDrinkabilityKeyword,
  hasEntityMetadataKeyword,
} from '@domain/query/service/exact-entity-metadata-signals.js';
import {
  RETRIEVAL_K_BY_INTENT,
  RETRIEVAL_K_DEFAULT,
  classifyQueryBudget,
  type IntentClass,
} from '@domain/agent/service/adaptive-budget.js';
import {
  AnchorEntityTypeSchema,
  WineSearchAnalysisSchema,
  WINE_SEARCH_BUDGET_MAX_STEPS,
  WINE_SEARCH_BUDGET_MIN_STEPS,
  WINE_SEARCH_MAX_ANCHORS,
  WINE_SEARCH_MAX_CONSTRAINTS,
  WINE_SEARCH_MAX_PER_TOOL_CAP,
  WINE_SEARCH_MAX_QUERY_CHARS,
  WINE_SEARCH_MAX_RESULT_LIMIT,
  WINE_SEARCH_MIN_PER_TOOL_CAP,
  WINE_SEARCH_MIN_RESULT_LIMIT,
  type AnalysisContract,
  type AnalysisRequiredTool,
  type AnalyzerIntent,
  type AnchorEntityType,
  type AnchorResolution,
  type ConstraintTierBundle,
  type Decomposition,
  type LlmFallbackOutcome,
  type RecommendedBudget,
  type WineSearchAnalysis,
} from './wine-search-schemas.js';
import { buildCallerSearchInterpretation } from './analysis-caller-interpretation.js';

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
/** Anthropic model id used for LLM fallback. Pulled from the
 *  {@link CLAUDE_SONNET_MODEL_ID} SSoT in `@domain/shared/constants/claude-models`
 *  so a future Sonnet bump (4.6 → 4.7 / 5.x) flips every analyzer/synthesizer
 *  in lockstep — see the same constant's docstring for the migration story.
 *  Tests inject a stub `StructuredLlmPort` so the literal here is only the
 *  deterministic default that flows into the request shape. */
const LLM_FALLBACK_MODEL = CLAUDE_SONNET_MODEL_ID;
/** Minimum confidence to promote a resolved entity to an anchor. Below this
 *  we drop the candidate; the LLM fallback path is reserved for cases where
 *  *no* deterministic signal fires at all. */
const ANCHOR_MIN_CONFIDENCE = 0.5;

/** Vintage-year regex — Latin word boundaries built from Unicode-aware
 *  lookarounds (rule 8 / rule 24). */
const VINTAGE_YEAR_RE = /(?<![\p{L}\p{N}])(?:18|19|20)\d{2}(?![\p{L}\p{N}])/u;
/** Explicit user-facing result-count intents only. We intentionally keep this
 *  narrow: `top3`, `탑3`, `상위 3개`. Broad patterns like bare `3개 추천` are
 *  ambiguous and stay unstructured until a stronger SSoT exists. */
const REQUESTED_RESULT_LIMIT_PATTERNS = [
  /(?:^|[^\p{L}\p{N}])top\s*-?\s*([1-9]\d{0,2})(?=$|[^\p{L}\p{N}])/iu,
  /(?:^|[^\p{L}\p{N}])탑\s*([1-9]\d{0,2})(?=$|[^\p{L}\p{N}])/u,
  /(?:^|[^\p{L}\p{N}])상위\s*([1-9]\d{0,2})(?:\s*개)?(?=$|[^\p{L}\p{N}])/u,
] as const;

class EmptyMappingTablePort implements MappingTablePort {
  findMapping(): Promise<null> {
    return Promise.resolve(null);
  }

  findMappingsByAttribute(): Promise<readonly []> {
    return Promise.resolve([]);
  }

  getCurrentVersion(): Promise<string> {
    return Promise.resolve('v1.0');
  }
}

const ANALYZER_CONSTRAINT_COMPILER = new ConstraintCompiler(
  new NLMapper(new EmptyMappingTablePort()),
);

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
      readonly reason:
        | 'empty_query'
        | 'too_long'
        | 'malformed'
        | 'blocked'
        /**
         * F-CritA: off-domain queries that the adaptive-budget classifier
         * matched (e.g. weather, beer, sports, crypto). The orchestrator
         * routes these through the unsupported_intent template (NOT the
         * security-blocked template) so the user sees a polite domain
         * redirect instead of a refusal-shaped response.
         */
        | 'off_domain';
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
    // We treat `adversarial` as a hard block (refuse path) and `off_domain`
    // as a polite-redirect reject — the comment above was previously
    // aspirational and the off-domain branch was missing, so beer / soju /
    // weather / sports / politics queries fell through to the deterministic
    // pipeline, got classified as `intent=search`, and the router emitted
    // a single-search plan → tool call → `mustNotCallTools` violation on
    // bench #20 / #104 / #109. The new branch short-circuits to the
    // orchestrator's reject path which uses the unsupported_intent template.
    const budgetClass = classifyQueryBudget(normalized);
    if (budgetClass?.classification === 'adversarial') {
      this.logger.info(
        { requestId: input.requestId, reason: budgetClass.reason },
        '[query-analyzer] adversarial input blocked by sanitizer',
      );
      return { kind: 'rejected', reason: 'blocked' };
    }
    if (budgetClass?.classification === 'off_domain') {
      this.logger.info(
        { requestId: input.requestId, reason: budgetClass.reason },
        '[query-analyzer] off-domain query — redirecting via reject path',
      );
      return { kind: 'rejected', reason: 'off_domain' };
    }
    if (budgetClass?.classification === 'knowledge_only') {
      // Knowledge-only intent — wine question that wants EXPLANATION (not
      // tool results). Same reject path as off_domain so synthesizer's
      // unsupported_intent template fires; the template's "I can help with
      // wine searches" copy is appropriate here too because the agent's
      // contract is search/recommendation, not free-form Q&A. A future
      // wave can wire a dedicated knowledge-answer template if rubric
      // tests demand it.
      this.logger.info(
        { requestId: input.requestId, reason: budgetClass.reason },
        '[query-analyzer] knowledge-only query — routing via reject path',
      );
      return { kind: 'rejected', reason: 'off_domain' };
    }

    const hangulDominant = computeHangulDominant(normalized);
    const normalizedViews = buildNormalizedQueryViews(normalized);

    // Resolve anchors first, then reuse the compiler SSoT for constraints so
    // analyzer output stays aligned with the live search pipeline.
    const anchors = extractAnchors(normalizedViews.collapsedWhitespace);
    const constraintBundle = await extractConstraintBundle(
      normalizedViews.collapsedWhitespace,
      input.abortSignal,
    );
    const constraints = flattenConstraintBundle(constraintBundle);
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
    const requestedResultLimit = extractRequestedResultLimit(normalizedViews.collapsedWhitespace);

    // T-IR-05: convenience intents (pairing / comparison / drinkability) no
    // longer have dedicated tools — all grounded work funnels through the
    // `search_hybrid` discovery primitive, and the agent composes the
    // convenience answer from the results. We still force a grounded search
    // whenever the query carries anchors, constraints, pairing tags, a
    // decomposition, or an anchor-bound drinkability check.
    const requiresGroundedTool =
      pairingTags.length > 0
      || decompositionOutcome.decomposed
      || (hasDrinkability && anchors.length > 0)
      || anchors.length > 0
      || constraints.length > 0;
    const requiredTool: AnalysisRequiredTool | undefined =
      requiresGroundedTool ? 'search_hybrid' : undefined;

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
      || pairingTags.length > 0
      || (contract.requiresDrinkabilityCheck && anchors.length > 0);

    // The query-analyzer reconciles the adaptive-budget classification with
    // the resolved QueryIntent: the classifier sees only raw lexical
    // signals, whereas `intent` accounts for resolved pairing tags /
    // anchors / decomposition. Examples that diverge:
    //   - "스테이크에 어울리는 와인" → classifier=default, intent=pair
    //     → must use `food_pairing` k (150), not the fallback (100).
    //   - "오푸스원 vs 알마비바" → classifier=compound, intent=compare
    //     → both project to `comparative` (k=20) — no override needed.
    //   - "강한 레드 추천해줘" → classifier=default, intent=search
    //     → keep fallback `unknown` k (100); the underlying anchors are
    //       diffuse enough that wide-pool exploratory would over-recall.
    const projectedIntentClass = projectIntentClass({
      classifierIntentClass: budgetClass?.intentClass,
      analyzerIntent: intent,
    });
    const recommendedBudget = computeRecommendedBudget({
      adaptiveMaxSteps: budgetClass?.maxSteps,
      expectedMultiStep,
      intentClass: projectedIntentClass,
    });

    // Zod-inferred WineSearchAnalysis uses *mutable* arrays even though the
    // input arrays are readonly (Zod's `.array()` infers `T[]`, not
    // `readonly T[]`). Materialize copies so the assignment is well-typed
    // without weakening the upstream readonly contracts.
    //
    // `callerInterpretation` is intentionally OMITTED from the initial shell
    // — the schema marks it optional and we populate it exactly once after
    // the LLM-fallback branch (below) so it reflects the final analysis.
    // Computing it twice (once here, once after fallback) wasted ~half of
    // every happy-path call and risked silent desync whenever a new
    // `WineSearchAnalysis` field was added to one literal but not the other.
    let candidate: WineSearchAnalysis = {
      intent,
      anchors: [...anchors],
      constraints: {
        hard: [...constraintBundle.hard],
        soft: [...constraintBundle.soft],
        inferred: [...constraintBundle.inferred],
      },
      normalizedConstraints: [...constraints],
      ...(requestedResultLimit !== undefined ? { requestedResultLimit } : {}),
      ...(decomposition !== undefined ? { decomposition } : {}),
      contract,
      expectedMultiStep,
      recommendedBudget,
      hangulDominant,
      preservedSurface,
    };

    // LLM fallback — fully ambiguous query AND a port is available.
    //
    // The `llmFallbackOutcome` field records exactly which branch executed so
    // downstream observability can distinguish:
    //   - 'not_attempted'              — deterministic signal present OR port absent
    //   - 'success'                    — LLM returned a parseable analysis
    //   - 'failed_preserved_unknown'   — LLM call threw; we kept the
    //                                    deterministic shell with intent='unknown'
    // Before this fix the failure path silently softened intent='unknown' to
    // 'search', masquerading an LLM outage as a confident search and bypassing
    // the deterministic-router's `unsupported_intent` reject for fully-ambiguous
    // queries. We now PRESERVE 'unknown' so the router handles the no-signal
    // case explicitly, and the outcome flag plus the log.warn in
    // `runLlmFallback` keep the failure observable.
    let llmFallbackOutcome: LlmFallbackOutcome = { kind: 'not_attempted' };
    if (
      candidate.intent === 'unknown'
      && candidate.anchors.length === 0
      && candidate.normalizedConstraints.length === 0
      && this.structuredLlm !== undefined
    ) {
      const fallbackResult = await this.runLlmFallback(
        this.structuredLlm,
        input,
        candidate,
      );
      if (fallbackResult.kind === 'success') {
        candidate = fallbackResult.analysis;
        llmFallbackOutcome = { kind: 'success' };
      } else {
        // Honest failure: PRESERVE the deterministic shell as-is with
        // intent='unknown'. We intentionally do NOT soften to 'search' — that
        // would masquerade an LLM outage as a confident search and bypass the
        // deterministic-router's `unsupported_intent` reject for this exact
        // no-signal case (no anchors, no constraints). Keeping 'unknown' lets
        // the router handle the ambiguous query explicitly; the outcome flag
        // below plus the log.warn in `runLlmFallback` keep the failure visible.
        llmFallbackOutcome = {
          kind: 'failed_preserved_unknown',
          failureReason: fallbackResult.failureReason,
        };
      }
    }

    // Final analysis: enrich the post-fallback candidate with its caller
    // interpretation (single, authoritative computation) and the fallback
    // observability flag, then validate. `buildCallerSearchInterpretation`
    // takes the analysis it should reflect, so any future field added to
    // `WineSearchAnalysis` automatically flows in without a parallel inline
    // literal needing to be touched.
    candidate = {
      ...candidate,
      callerInterpretation: buildCallerSearchInterpretation(candidate),
      llmFallbackOutcome,
    };

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
  ): Promise<LlmFallbackInternalResult> {
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
        kind: 'success',
        analysis: {
          ...result.data,
          preservedSurface: input.query,
          hangulDominant: deterministic.hangulDominant,
        },
      };
    } catch (err) {
      const failureReason = classifyFallbackFailure(err);
      this.logger.warn(
        {
          event: 'analyzer.llm_fallback_failed',
          requestId: input.requestId,
          failureReason,
          err,
        },
        '[query-analyzer] LLM fallback failed — preserving intent=unknown',
      );
      return { kind: 'failed', failureReason };
    }
  }
}

/** Internal disjoint result from {@link QueryAnalyzerService.runLlmFallback}.
 *  The public observability surface is {@link LlmFallbackOutcome}; this shape
 *  carries the resolved analysis on success so the caller can swap it in. */
type LlmFallbackInternalResult =
  | { readonly kind: 'success'; readonly analysis: WineSearchAnalysis }
  | { readonly kind: 'failed'; readonly failureReason: LlmFallbackFailureReason };

/** Branches in {@link LlmFallbackOutcome} of kind `failed_preserved_unknown`. */
type LlmFallbackFailureReason =
  | 'timeout'
  | 'refusal'
  | 'validation'
  | 'partial_output'
  | 'circuit_open'
  | 'unknown';

/** Map a thrown error from the structured-LLM port to its observability
 *  failure-reason label. The taxonomy mirrors the `StructuredLlm*Error`
 *  classes; any non-matching error falls through to `'unknown'` so an opaque
 *  exception still produces a categorized trace instead of an empty reason. */
function classifyFallbackFailure(err: unknown): LlmFallbackFailureReason {
  if (err instanceof StructuredLlmTimeoutError) return 'timeout';
  if (err instanceof StructuredLlmRefusalError) return 'refusal';
  if (err instanceof StructuredLlmValidationError) return 'validation';
  if (err instanceof StructuredLlmPartialOutputError) return 'partial_output';
  if (err instanceof StructuredLlmCircuitOpenError) return 'circuit_open';
  return 'unknown';
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

async function extractConstraintBundle(
  normalizedQuery: string,
  abortSignal: AbortSignal | undefined,
): Promise<ConstraintTierBundle> {
  const result = await ANALYZER_CONSTRAINT_COMPILER.compile(
    normalizedQuery,
    abortSignal,
  );
  return {
    hard: result.bundle.hard.slice(0, WINE_SEARCH_MAX_CONSTRAINTS),
    soft: result.bundle.soft.slice(0, WINE_SEARCH_MAX_CONSTRAINTS),
    inferred: result.bundle.inferred.slice(0, WINE_SEARCH_MAX_CONSTRAINTS),
  };
}

function flattenConstraintBundle(bundle: ConstraintTierBundle): readonly NormalizedConstraint[] {
  const flat: NormalizedConstraint[] = [
    ...bundle.hard,
    ...bundle.soft,
    ...bundle.inferred,
  ];
  return flat.length > WINE_SEARCH_MAX_CONSTRAINTS
    ? flat.slice(0, WINE_SEARCH_MAX_CONSTRAINTS)
    : flat;
}

function extractRequestedResultLimit(normalizedQuery: string): number | undefined {
  for (const pattern of REQUESTED_RESULT_LIMIT_PATTERNS) {
    const match = pattern.exec(normalizedQuery);
    if (match === null) {
      continue;
    }
    const parsed = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isFinite(parsed)) {
      continue;
    }
    return clampRequestedResultLimit(parsed);
  }
  return undefined;
}

function clampRequestedResultLimit(value: number): number {
  if (value < WINE_SEARCH_MIN_RESULT_LIMIT) {
    return WINE_SEARCH_MIN_RESULT_LIMIT;
  }
  if (value > WINE_SEARCH_MAX_RESULT_LIMIT) {
    return WINE_SEARCH_MAX_RESULT_LIMIT;
  }
  return value;
}

function classifyIntent(args: {
  readonly hasDrinkability: boolean;
  readonly pairingTagsCount: number;
  readonly decomposed: boolean;
  readonly anchorsCount: number;
  readonly constraintsCount: number;
}): AnalyzerIntent {
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
  readonly intentClass: IntentClass;
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

  // Adaptive retrieval k — SSoT `RETRIEVAL_K_BY_INTENT`. Falls back to the
  // documented default for any IntentClass not present in the map (defensive
  // — every member of the union has a mapping today).
  const retrievalK = RETRIEVAL_K_BY_INTENT.get(args.intentClass) ?? RETRIEVAL_K_DEFAULT;

  return { maxSteps: clamped, perToolCap, retrievalK };
}

/**
 * Reconcile the classifier's lexical IntentClass with the analyzer's
 * AnalyzerIntent. The classifier sees only the raw query; the analyzer also
 * has resolved pairing tags, anchors, and decomposition. Both surfaces
 * agree on the common cases; this function captures the few divergences
 * that matter for the retrieval-k lever.
 *
 * Rules (in priority order):
 *   1. `intent === 'pair'` → `food_pairing` — pairing tags are a strong
 *      signal that's invisible to the lexical classifier.
 *   2. `intent === 'compare'` → `comparative` — true even when the
 *      classifier missed the compound signal (e.g. "X와 Y 어느 게 좋아?"
 *      slips through the COMPOUND_INDICATORS keyword list).
 *   3. Otherwise, respect the classifier's projection (or fall back to
 *      `unknown` if it did not fire).
 */
function projectIntentClass(args: {
  readonly classifierIntentClass: IntentClass | undefined;
  readonly analyzerIntent: AnalyzerIntent;
}): IntentClass {
  if (args.analyzerIntent === 'pair') return 'food_pairing';
  if (args.analyzerIntent === 'compare') return 'comparative';
  return args.classifierIntentClass ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Re-exports for callers that only need the schema types
// ---------------------------------------------------------------------------
export type { WineSearchAnalysis } from './wine-search-schemas.js';

// Reference Zod so the import is not pruned by TS noUnusedLocals.
void z;

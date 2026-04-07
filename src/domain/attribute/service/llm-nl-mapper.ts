/**
 * LLM-backed NLMapper — extends the deterministic {@link NLMapper} with
 * LLM-based constraint extraction for phrases the rule table doesn't cover.
 *
 * Resolution order:
 *   1. Rule table (DEFAULT_MAPPINGS + MappingTablePort) — deterministic, 0ms
 *   2. LLM call (ChatLlmPort) — for unmatched phrases only, ~300-500ms
 *
 * LLM results are:
 *   - Validated against a Zod schema (malformed → dropped)
 *   - Filtered to allowed attributes only (unknown attribute → dropped)
 *   - Confidence-gated (< 0.5 → dropped)
 *   - Always emitted as soft constraints (RFC-004: LLM-generated hard constraints forbidden)
 *   - Tagged with mapping_version 'llm-v1.0' for observability
 *
 * Phase strategy:
 *   Phase 1: LLM handles all unknown phrases
 *   Phase 2: High-frequency LLM results migrate to rule table
 *   Phase 3: LLM handles long-tail only (~10% of queries)
 */

import type { NormalizedConstraint } from '../../shared/types/index.js';
import type { MappingTablePort } from '../port/mapping-table.port.js';
import type { ChatLlmPort } from '../../ai/port/chat-llm.port.js';
import { NLMapper, toNormalizedConstraint } from './nl-mapper.js';
import {
  LlmConstraintResponseSchema,
  LLM_ALLOWED_ATTRIBUTES,
  type LlmConstraintItem,
} from '../model/llm-constraint-schema.js';
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';

const log = bootstrapLogger.child({ component: 'LlmNLMapper' });

const LLM_MAPPING_VERSION = 'llm-v1.0';
const LLM_CONFIDENCE_THRESHOLD = 0.5;
const LLM_TIMEOUT_MS = 5_000;

const SYSTEM_PROMPT = `You are a wine search query constraint parser. Given Korean or English wine search phrases, extract structured attribute constraints.

Allowed attributes: body, sweetness, acidity, tannin, price_band, occasion, wine_type, country, region, appellation, grape_primary, style, critic_score, producer_prestige, finish_length, drinking_window, flavor_profile, certification.

Price band values: budget, mid, premium, luxury.
Wine type values: red, white, rosé, sparkling, natural, dessert, fortified, orange.
Body/sweetness/acidity/tannin/critic_score/producer_prestige: numeric 0-1.
Occasion values: gift, party, date, anniversary, celebration, daily.

Return a JSON array. Each item: { "phrase": string, "attribute": string, "operator": "=" | "<=" | ">=" | "range" | "in", "value": string | number | { "min": number, "max": number }, "confidence": 0-1 }.

Examples:
- "비싼" → [{"phrase":"비싼","attribute":"price_band","operator":"=","value":"luxury","confidence":0.85}]
- "평점좋은" → [{"phrase":"평점좋은","attribute":"critic_score","operator":">=","value":0.7,"confidence":0.8}]
- "과일향 풍부한" → [{"phrase":"과일향 풍부한","attribute":"flavor_profile","operator":"in","value":"fruity","confidence":0.8}]

If a phrase has no wine-related constraint meaning, omit it from the array. Return [] for no matches.`;

/**
 * Observability data emitted per mapConstraints() call.
 */
export interface ConstraintExtractionTrace {
  readonly candidatePhraseCount: number;
  readonly ruleTableHitCount: number;
  readonly llmHitCount: number;
  readonly llmSkippedCount: number;
  readonly fallbackTriggered: boolean;
  readonly source: 'rule_only' | 'llm_only' | 'hybrid' | 'fallback';
  readonly llmLatencyMs: number | null;
  readonly cacheHit: boolean;
  readonly missedPhrases: readonly string[];
}

export class LlmNLMapper extends NLMapper {
  private _lastExtractionTrace: ConstraintExtractionTrace | undefined;

  constructor(
    mappingTable: MappingTablePort,
    private readonly chatLlm: ChatLlmPort,
    private readonly llmTimeoutMs: number = LLM_TIMEOUT_MS,
  ) {
    super(mappingTable);
  }

  /**
   * Returns the trace from the most recent {@link mapConstraints} call.
   * Used by the Planner to populate {@link QueryObservabilitySlice}.
   */
  getLastExtractionTrace(): ConstraintExtractionTrace | undefined {
    return this._lastExtractionTrace;
  }

  /**
   * Maps phrases to constraints using rule table first, then LLM for misses.
   */
  override async mapConstraints(
    phrases: readonly string[],
  ): Promise<NormalizedConstraint[]> {
    const ruleResults: NormalizedConstraint[] = [];
    const missedPhrases: string[] = [];

    // Step 1: Rule table lookup (deterministic, fast)
    for (const phrase of phrases) {
      const mapping = await this.mapPhrase(phrase);
      if (mapping !== null) {
        ruleResults.push(toNormalizedConstraint(mapping));
      } else {
        missedPhrases.push(phrase);
      }
    }

    // Step 2: LLM for missed phrases (cap to prevent token/cost explosion)
    const MAX_LLM_PHRASES = 20;
    let llmResults: NormalizedConstraint[] = [];
    let llmSkippedCount = 0;
    let llmLatencyMs: number | null = null;
    const llmPhrases = missedPhrases.slice(0, MAX_LLM_PHRASES);

    if (llmPhrases.length > 0) {
      const llmStart = Date.now();
      try {
        const rawItems = await this.callLlm(llmPhrases);
        llmLatencyMs = Date.now() - llmStart;

        for (const item of rawItems) {
          if (!LLM_ALLOWED_ATTRIBUTES.has(item.attribute)) {
            llmSkippedCount++;
            continue;
          }
          if (item.confidence < LLM_CONFIDENCE_THRESHOLD) {
            llmSkippedCount++;
            continue;
          }
          llmResults.push(llmItemToConstraint(item));
        }
      } catch (err) {
        llmLatencyMs = Date.now() - llmStart;
        log.warn(
          { err, missedPhraseCount: missedPhrases.length, latencyMs: llmLatencyMs },
          'LLM constraint extraction failed — continuing with rule-only results',
        );
      }
    }

    const allResults = [...ruleResults, ...llmResults];

    // Build trace
    const hasRuleHits = ruleResults.length > 0;
    const hasLlmHits = llmResults.length > 0;
    const source: ConstraintExtractionTrace['source'] =
      hasRuleHits && hasLlmHits ? 'hybrid'
        : hasRuleHits ? 'rule_only'
          : hasLlmHits ? 'llm_only'
            : 'fallback';

    this._lastExtractionTrace = {
      candidatePhraseCount: phrases.length,
      ruleTableHitCount: ruleResults.length,
      llmHitCount: llmResults.length,
      llmSkippedCount,
      fallbackTriggered: allResults.length === 0,
      source,
      llmLatencyMs,
      cacheHit: false, // TODO: wire Redis phrase cache in Phase 2
      missedPhrases: missedPhrases.filter(
        (p) => !llmResults.some((r) => r.source_phrase === p),
      ),
    };

    log.debug(
      {
        candidatePhrases: phrases.length,
        ruleHits: ruleResults.length,
        llmHits: llmResults.length,
        llmSkipped: llmSkippedCount,
        source,
        llmLatencyMs,
      },
      'constraint extraction complete',
    );

    return allResults;
  }

  private async callLlm(phrases: readonly string[]): Promise<LlmConstraintItem[]> {
    const userMessage = JSON.stringify(phrases);

    // ChatLlmPort.complete() doesn't accept AbortSignal, so we enforce
    // timeout via Promise.race — the LLM call continues in the background
    // but its result is discarded if the timeout fires first.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`LLM query interpreter timed out after ${this.llmTimeoutMs}ms`));
      }, this.llmTimeoutMs);
    });

    try {
      const result = await Promise.race([
        this.chatLlm.complete({
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          temperature: 0,
          maxOutputTokens: 512,
        }),
        timeoutPromise,
      ]);

      const parsed = JSON.parse(result.text);
      const validated = LlmConstraintResponseSchema.safeParse(parsed);

      if (!validated.success) {
        log.warn(
          { issues: validated.error.issues, rawText: result.text.slice(0, 200) },
          'LLM response failed schema validation',
        );
        return [];
      }

      return validated.data;
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}

function llmItemToConstraint(item: LlmConstraintItem): NormalizedConstraint {
  let value: NormalizedConstraint['value'];
  if (typeof item.value === 'object' && !Array.isArray(item.value) && item.value !== null) {
    value = { min: item.value.min, max: item.value.max };
  } else if (Array.isArray(item.value)) {
    value = item.value;
  } else {
    value = item.value;
  }

  return {
    attribute: item.attribute,
    operator: item.operator,
    value,
    source_phrase: item.phrase,
    confidence: item.confidence,
    mapping_version: LLM_MAPPING_VERSION,
  };
}

// Removed — uses toNormalizedConstraint from nl-mapper.ts

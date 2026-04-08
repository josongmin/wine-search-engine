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

import { createHash } from 'node:crypto';
import type { NormalizedConstraint } from '../../shared/types/index.js';
import type { MappingTablePort } from '../port/mapping-table.port.js';
import type { PhraseCachePort } from '../port/phrase-cache.port.js';
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
 * Cache-key namespace bound to BOTH the explicit version and the actual prompt
 * content. Editing SYSTEM_PROMPT without bumping LLM_MAPPING_VERSION used to
 * silently invalidate semantics across the 24h positive TTL — this hash makes
 * any prompt edit produce a brand-new key namespace, so old entries become
 * unreachable and harmless.
 */
const PROMPT_FINGERPRINT = createHash('sha1').update(SYSTEM_PROMPT).digest('hex').slice(0, 8);
/** @internal Exported for testing — production callers should not depend on the layout. */
export const CACHE_KEY_NAMESPACE = `${LLM_MAPPING_VERSION}:${PROMPT_FINGERPRINT}`;

/**
 * Observability data emitted per mapConstraints() call.
 *
 * Phrase-cache breakdown (operators reading this for cost dashboards):
 *  - phraseCacheHits: cache returned a non-empty entry that produced ≥1
 *    surviving constraint after attribute/confidence filtering
 *  - phraseCacheNegativeSkipped: cache returned an empty (negative) entry —
 *    LLM call was skipped, but no constraints were produced from cache
 *  - phraseCacheMisses: cache had no entry for this phrase, fell through to LLM
 *
 * Sum invariant: hits + negativeSkipped + misses = number of phrases that
 * were actually checked against the cache (i.e. missedPhrases capped at
 * MAX_LLM_PHRASES). When phraseCache is undefined, all three are 0.
 */
export interface ConstraintExtractionTrace {
  readonly candidatePhraseCount: number;
  readonly ruleTableHitCount: number;
  readonly llmHitCount: number;
  readonly llmSkippedCount: number;
  readonly fallbackTriggered: boolean;
  readonly source: 'rule_only' | 'llm_only' | 'hybrid' | 'fallback';
  readonly llmLatencyMs: number | null;
  readonly phraseCacheHits: number;
  readonly phraseCacheNegativeSkipped: number;
  readonly phraseCacheMisses: number;
  readonly missedPhrases: readonly string[];
}

export class LlmNLMapper extends NLMapper {
  private _lastExtractionTrace: ConstraintExtractionTrace | undefined;

  constructor(
    mappingTable: MappingTablePort,
    private readonly chatLlm: ChatLlmPort,
    private readonly llmTimeoutMs: number = LLM_TIMEOUT_MS,
    private readonly phraseCache?: PhraseCachePort,
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

    // Dedupe at the entry point so we never pay rule-table or LLM cost twice
    // for the same phrase. Preserves first-occurrence ordering.
    const dedupedPhrases: string[] = [];
    {
      const seen = new Set<string>();
      for (const phrase of phrases) {
        if (!seen.has(phrase)) {
          seen.add(phrase);
          dedupedPhrases.push(phrase);
        }
      }
    }

    // Step 1: Rule table lookup (deterministic, fast)
    for (const phrase of dedupedPhrases) {
      const mapping = await this.mapPhrase(phrase);
      if (mapping !== null) {
        ruleResults.push(toNormalizedConstraint(mapping));
      } else {
        missedPhrases.push(phrase);
      }
    }

    // Step 2: LLM for missed phrases (cap to prevent token/cost explosion)
    const MAX_LLM_PHRASES = 20;
    const PHRASE_CACHE_TTL_SECONDS = 86_400; // 24h positive TTL
    const PHRASE_CACHE_NEGATIVE_TTL_SECONDS = 3_600; // 1h negative TTL (shorter so prompt fixes propagate)
    const llmResults: NormalizedConstraint[] = [];
    let llmSkippedCount = 0;
    let llmLatencyMs: number | null = null;
    let phraseCacheHits = 0;
    let phraseCacheNegativeSkipped = 0;
    let phraseCacheMisses = 0;
    const llmPhrases = missedPhrases.slice(0, MAX_LLM_PHRASES);

    if (llmPhrases.length > 0) {
      // Step 2a: Check phrase cache before LLM call.
      // Cache key is namespaced by CACHE_KEY_NAMESPACE (version + prompt
      // fingerprint) so prompt edits or version bumps invalidate stale entries.
      const uncachedPhrases: string[] = [];
      if (this.phraseCache !== undefined) {
        for (const phrase of llmPhrases) {
          try {
            const cached = await this.phraseCache.get(this.cacheKey(phrase));
            if (cached !== null) {
              // Negative cache: empty array means "LLM returned nothing for this phrase".
              // Skip the LLM call entirely; counted separately so operators can see
              // how many cost-saving negative skips happened.
              if (cached.length === 0) {
                phraseCacheNegativeSkipped++;
                continue;
              }
              const beforeCount = llmResults.length;
              for (const item of cached) {
                if (LLM_ALLOWED_ATTRIBUTES.has(item.attribute) && item.confidence >= LLM_CONFIDENCE_THRESHOLD) {
                  llmResults.push(llmItemToConstraint(item));
                }
              }
              // Only count as a useful cache hit if ≥1 item survived filtering.
              // A cached entry that gets fully filtered out is recorded as a
              // miss equivalent for trace purposes (we paid the lookup but
              // gained no constraints) — but we still skip the LLM call
              // because the LLM would just return the same filtered-out items.
              if (llmResults.length > beforeCount) {
                phraseCacheHits++;
              } else {
                phraseCacheMisses++;
              }
              continue;
            }
            phraseCacheMisses++;
          } catch { /* cache read failure → fall through to LLM */
            phraseCacheMisses++;
          }
          uncachedPhrases.push(phrase);
        }
      } else {
        uncachedPhrases.push(...llmPhrases);
      }

      // Step 2b: LLM call for uncached phrases only
      if (uncachedPhrases.length > 0) {
        const llmStart = Date.now();
        try {
          const rawItems = await this.callLlm(uncachedPhrases);
          llmLatencyMs = Date.now() - llmStart;

          // Cache LLM results per phrase, including negative entries for phrases
          // the LLM returned nothing for (so common no-match phrases don't keep
          // re-triggering the LLM).
          const itemsByPhrase = new Map<string, LlmConstraintItem[]>();
          for (const phrase of uncachedPhrases) {
            itemsByPhrase.set(phrase, []);
          }
          for (const item of rawItems) {
            const list = itemsByPhrase.get(item.phrase) ?? [];
            list.push(item);
            itemsByPhrase.set(item.phrase, list);
          }
          if (this.phraseCache !== undefined) {
            for (const [phrase, items] of itemsByPhrase) {
              const ttl = items.length === 0 ? PHRASE_CACHE_NEGATIVE_TTL_SECONDS : PHRASE_CACHE_TTL_SECONDS;
              this.phraseCache.set(this.cacheKey(phrase), items, ttl).catch((err: unknown) => {
                log.warn({ err, phrase }, 'Failed to cache LLM phrase result');
              });
            }
          }

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
            { err, missedPhraseCount: uncachedPhrases.length, latencyMs: llmLatencyMs },
            'LLM constraint extraction failed — continuing with rule-only results',
          );
        }
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
      phraseCacheHits,
      phraseCacheNegativeSkipped,
      phraseCacheMisses,
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

  /**
   * Build a namespace-prefixed cache key. The namespace combines
   * LLM_MAPPING_VERSION with a SHA-1 prefix of SYSTEM_PROMPT, so any prompt
   * edit (with or without an explicit version bump) produces a new key
   * partition and old entries become unreachable.
   */
  private cacheKey(phrase: string): string {
    return `${CACHE_KEY_NAMESPACE}:${phrase}`;
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

      const parsed: unknown = JSON.parse(result.text);
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
  // Range objects (`{min, max}`) are normalized into a discriminated form;
  // strings, numbers, and string-arrays pass through unchanged. The Zod
  // schema (LlmConstraintItemSchema) guarantees `value` is non-null, so the
  // discriminator is purely typeof + Array.isArray.
  const rawValue = item.value;
  const value: NormalizedConstraint['value'] =
    typeof rawValue === 'object' && !Array.isArray(rawValue)
      ? { min: rawValue.min, max: rawValue.max }
      : rawValue;

  return {
    attribute: item.attribute,
    operator: item.operator,
    value,
    source_phrase: item.phrase,
    confidence: item.confidence,
    mapping_version: LLM_MAPPING_VERSION,
  };
}

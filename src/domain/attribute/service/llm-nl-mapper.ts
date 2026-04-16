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
import type { ConstraintExtractionTrace } from '../model/constraint-extraction-trace.js';
import {
  NLMapper,
  toNormalizedConstraint,
  type MapConstraintsOptions,
  type MapConstraintsResult,
} from './nl-mapper.js';
import {
  LlmConstraintItemSchema,
  LLM_ALLOWED_ATTRIBUTES,
  type LlmConstraintItem,
} from '../model/llm-constraint-schema.js';
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';
import { abortError, throwIfAborted } from '../../shared/cooperative-abort.js';
import { HOURS_PER_DAY, MINUTES_PER_HOUR, SECONDS_PER_MINUTE } from '../../shared/utils/time-units.js';
import { resolveEntity } from './entity-resolver.js';
import type { FuzzyMatcherPort } from '../../query/port/fuzzy-matcher.port.js';

const log = bootstrapLogger.child({ component: 'LlmNLMapper' });

const LLM_MAPPING_VERSION = 'llm-v1.0';
const LLM_CONFIDENCE_THRESHOLD = 0.5;
const LLM_TIMEOUT_MS = 5_000;
const LLM_ENTITY_LINKER_VERSION = 'llm-linker-v1.0';
/** Prefix length of SHA-1 hex in prompt fingerprint (cache namespace). */
const PROMPT_FINGERPRINT_HEX_PREFIX_CHARS = 8;
/** Truncate raw LLM text in schema-validation failure logs. */
const LLM_SCHEMA_FAIL_RAW_TEXT_PREVIEW_CHARS = 200;
const ENTITY_LIKE_ATTRIBUTES = new Set(['country', 'region', 'appellation', 'grape_primary']);

/**
 * Hard cap on individual phrase length before it is interpolated into the
 * LLM prompt. Legitimate wine phrases are short (a few words); anything
 * longer is either noise or a prompt-overflow attack attempting to push
 * the system prompt out of the context window.
 */
const MAX_LLM_PHRASE_LENGTH = 120;

/**
 * Prompt-injection marker patterns stripped from user phrases before
 * interpolation into the LLM prompt body. These are well-known tokens that
 * attempt to break out of the user-turn boundary and inject a pseudo-system
 * instruction into the model. This is defense-in-depth only — the sanitizer
 * also rejects phrases containing newlines (which can synthetically create
 * a new role turn) rather than trying to scrub them.
 *
 * Keep this list conservative: false positives here silently drop real
 * phrases. The regex must cover ASCII only — phrases with Korean/accented
 * content are left untouched.
 */
const LLM_PROMPT_INJECTION_MARKERS: readonly RegExp[] = [
  /\[(?:SYSTEM|INST|ASSISTANT|USER|SYS)[^\]]*\]/gi,
  /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>/gi,
  /<<SYS>>|<<\/SYS>>/gi,
  /\[\/?INST\]/gi,
];

/**
 * Sanitizes a user phrase before interpolation into the LLM prompt.
 *
 * - Rejects phrases containing `\n` or `\r` — newline chars can synthetically
 *   create a new role turn in chat prompt formats and break out of the
 *   user-turn JSON string the phrase is embedded in.
 * - Strips known prompt-injection markers ([SYSTEM:, <|im_start|>, <<SYS>>, …)
 *   even though the phrase is JSON-stringified, so that a cached/logged
 *   phrase cannot surface these tokens downstream.
 * - Truncates to {@link MAX_LLM_PHRASE_LENGTH} to prevent prompt-overflow
 *   attacks that try to push the system prompt out of context.
 *
 * Returns `null` if the phrase is rejected outright (newline content, or
 * empty after sanitization); otherwise returns the cleaned phrase.
 *
 * @internal exported for tests.
 */
function sanitizeLlmPhrase(phrase: string): string | null {
  if (phrase.length === 0) {
    return null;
  }
  // Reject newlines — they can synthesize a new role turn even inside a
  // JSON-encoded user message when the provider is permissive.
  if (/[\r\n]/.test(phrase)) {
    return null;
  }
  let cleaned = phrase;
  for (const pattern of LLM_PROMPT_INJECTION_MARKERS) {
    cleaned = cleaned.replace(pattern, '');
  }
  cleaned = cleaned.trim();
  if (cleaned.length === 0) {
    return null;
  }
  if (cleaned.length > MAX_LLM_PHRASE_LENGTH) {
    cleaned = cleaned.slice(0, MAX_LLM_PHRASE_LENGTH);
  }
  return cleaned;
}

const SYSTEM_PROMPT = `You are a wine search query constraint parser. Given Korean or English wine search phrases, extract structured attribute constraints.

Allowed attributes: body, sweetness, acidity, tannin, price_band, occasion, wine_type, country, region, appellation, grape_primary, style, critic_score, producer_prestige, finish_length, drinking_window, flavor_profile, certification.

Price band values: budget, mid, premium, luxury.
Wine type values: red, white, rosé, sparkling, natural, dessert, fortified, orange.
Body/sweetness/acidity/tannin/critic_score/producer_prestige: numeric 0-1.
Occasion values: gift, party, celebration, anniversary, wedding, date_night, housewarming, solo, healing, camping, romantic, comforting.
Style values: dry, off_dry, sweet, sparkling, fortified, rose, natural, orange, chillable, screw_cap, approachable, crowd_pleasing, presentation_forward.

Return a JSON array. Each item: { "phrase": string, "attribute": string, "operator": "=" | "<=" | ">=" | "range" | "in" | "exclude", "value": string | number | { "min": number, "max": number }, "confidence": 0-1 }.

Use "exclude" operator for negation ("말고", "아닌", "빼고", "않고", "not", "except"). Do NOT use "!=" — use "exclude" instead.

Examples:
- "비싼" → [{"phrase":"비싼","attribute":"price_band","operator":"=","value":"luxury","confidence":0.85}]
- "평점좋은" → [{"phrase":"평점좋은","attribute":"critic_score","operator":">=","value":0.7,"confidence":0.8}]
- "과일향 풍부한" → [{"phrase":"과일향 풍부한","attribute":"flavor_profile","operator":"in","value":"fruity","confidence":0.8}]
- "스크류캡" → [{"phrase":"스크류캡","attribute":"style","operator":"in","value":"screw_cap","confidence":0.85}]
- "시원하게 마실" → [{"phrase":"시원하게 마실","attribute":"style","operator":"in","value":"chillable","confidence":0.8}]
- "실패 없는" → [{"phrase":"실패 없는","attribute":"style","operator":"in","value":"crowd_pleasing","confidence":0.8}]
- "예쁜 라벨" → [{"phrase":"예쁜 라벨","attribute":"style","operator":"in","value":"presentation_forward","confidence":0.8}]
- "샴페인 말고" → [{"phrase":"샴페인 말고","attribute":"region","operator":"exclude","value":"Champagne","confidence":0.85}]
- "레드인데" → [{"phrase":"레드인데","attribute":"wine_type","operator":"=","value":"red","confidence":0.9}]

If a phrase has no wine-related constraint meaning, omit it from the array. Return [] for no matches.`;

/**
 * Cache-key namespace bound to BOTH the explicit version and the actual prompt
 * content. Editing SYSTEM_PROMPT without bumping LLM_MAPPING_VERSION used to
 * silently invalidate semantics across the 24h positive TTL — this hash makes
 * any prompt edit produce a brand-new key namespace, so old entries become
 * unreachable and harmless.
 */
const PROMPT_FINGERPRINT = createHash('sha1').update(SYSTEM_PROMPT).digest('hex').slice(0, PROMPT_FINGERPRINT_HEX_PREFIX_CHARS);
/** @internal Exported for testing — production callers should not depend on the layout. */
export const CACHE_KEY_NAMESPACE = `${LLM_MAPPING_VERSION}:${PROMPT_FINGERPRINT}`;

/**
 * Observability payload returned from {@link NLMapper.mapConstraints} as
 * `constraintExtraction` (request-scoped — not stored on the service instance).
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
export class LlmNLMapper extends NLMapper {
  constructor(
    mappingTable: MappingTablePort,
    private readonly chatLlm: ChatLlmPort,
    private readonly llmTimeoutMs: number = LLM_TIMEOUT_MS,
    private readonly phraseCache?: PhraseCachePort,
    private readonly fuzzyMatcher?: FuzzyMatcherPort | undefined,
  ) {
    super(mappingTable);
  }

  /**
   * Maps phrases to constraints using rule table first, then LLM for misses.
   */
  override async mapConstraints(
    phrases: readonly string[],
    options?: MapConstraintsOptions,
  ): Promise<MapConstraintsResult> {
    throwIfAborted(options?.abortSignal, 'Constraint mapping aborted');

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
      throwIfAborted(options?.abortSignal, 'Constraint mapping aborted');
      const mapping = await this.mapPhrase(phrase);
      if (mapping !== null) {
        ruleResults.push(toNormalizedConstraint(mapping));
      } else {
        missedPhrases.push(phrase);
      }
    }

    // Step 2: LLM for missed phrases (cap to prevent token/cost explosion)
    const MAX_LLM_PHRASES = 20;
    const PHRASE_CACHE_TTL_SECONDS = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE; // 86 400 s (24h positive TTL)
    const PHRASE_CACHE_NEGATIVE_TTL_SECONDS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE; // 3 600 s (1h negative TTL — shorter so prompt fixes propagate)
    const llmResults: NormalizedConstraint[] = [];
    let llmSkippedCount = 0;
    let llmLatencyMs: number | null = null;
    let phraseCacheHits = 0;
    let phraseCacheNegativeSkipped = 0;
    let phraseCacheMisses = 0;
    let llmLinkedEntityCount = 0;
    const llmPhrases = missedPhrases.slice(0, MAX_LLM_PHRASES);

    if (llmPhrases.length > 0) {
      // Step 2a: Check phrase cache before LLM call.
      // Cache key is namespaced by CACHE_KEY_NAMESPACE (version + prompt
      // fingerprint) so prompt edits or version bumps invalidate stale entries.
      const uncachedPhrases: string[] = [];
      if (this.phraseCache !== undefined) {
        for (const phrase of llmPhrases) {
          throwIfAborted(options?.abortSignal, 'Constraint mapping aborted');
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
                  const normalized = llmItemToConstraint(item, this.fuzzyMatcher);
                  llmResults.push(normalized.constraint);
                  llmLinkedEntityCount += normalized.linkedEntity ? 1 : 0;
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
          const rawItems = await this.callLlm(uncachedPhrases, options?.abortSignal);
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
            const normalized = llmItemToConstraint(item, this.fuzzyMatcher);
            llmResults.push(normalized.constraint);
            llmLinkedEntityCount += normalized.linkedEntity ? 1 : 0;
          }
        } catch (err) {
          if (options?.abortSignal?.aborted) {
            throw abortError(
              err instanceof Error ? err.message : 'Constraint mapping aborted',
              err,
            );
          }
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

    const constraintExtraction: ConstraintExtractionTrace = {
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
      ...(llmLinkedEntityCount > 0 ? { llmLinkedEntityCount } : {}),
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

    return { constraints: allResults, constraintExtraction };
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

  private async callLlm(
    phrases: readonly string[],
    externalSignal?: AbortSignal,
  ): Promise<LlmConstraintItem[]> {
    // Prompt-injection hardening: sanitize each phrase before interpolation.
    // Phrases that fail the sanitizer (newlines, empty after stripping markers)
    // are dropped — we do NOT log the raw phrase to avoid leaking attack
    // payloads into observability pipelines.
    const safePhrases: string[] = [];
    for (const phrase of phrases) {
      const sanitized = sanitizeLlmPhrase(phrase);
      if (sanitized !== null) {
        safePhrases.push(sanitized);
      }
    }
    if (safePhrases.length === 0) {
      return [];
    }
    const userMessage = JSON.stringify(safePhrases);
    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      timeoutController.abort();
    }, this.llmTimeoutMs);

    const combinedSignal =
      externalSignal !== undefined
        ? AbortSignal.any([externalSignal, timeoutController.signal])
        : timeoutController.signal;

    const llmTimeoutError = (): Error =>
      new Error(`LLM query interpreter timed out after ${this.llmTimeoutMs}ms`);

    try {
      const result = await this.chatLlm.complete({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0,
        maxOutputTokens: 512,
        abortSignal: combinedSignal,
      });
      // Disarm timeout as soon as the provider returns so a late timer tick
      // cannot fire while we parse/validate synchronously.
      clearTimeout(timeoutHandle);
      // Real adapters reject when aborted; non-compliant mocks might still
      // resolve later — do not treat that as a successful completion.
      if (externalSignal?.aborted) {
        throw abortError('Constraint mapping aborted');
      }
      if (timeoutController.signal.aborted) {
        throw llmTimeoutError();
      }

      const parsed: unknown = JSON.parse(result.text);

      // Per-item validation: validate each item independently so that 1 bad
      // item (e.g., LLM returning "!=" instead of "exclude") does not nuke
      // the entire response. This is the standard LLM output resilience
      // pattern — LLMs routinely emit 1-2 malformed items in an otherwise
      // valid batch. (CLAUDE.md Rule 10: LLM tool output MUST NOT use strict.)
      if (!Array.isArray(parsed)) {
        log.warn(
          { rawText: result.text.slice(0, LLM_SCHEMA_FAIL_RAW_TEXT_PREVIEW_CHARS) },
          'LLM response is not an array — dropping entire response',
        );
        return [];
      }
      const validItems: LlmConstraintItem[] = [];
      let droppedCount = 0;
      for (const rawItem of parsed) {
        const itemResult = LlmConstraintItemSchema.safeParse(rawItem);
        if (itemResult.success) {
          validItems.push(itemResult.data);
        } else {
          droppedCount++;
        }
      }
      if (droppedCount > 0) {
        log.info(
          { droppedCount, keptCount: validItems.length, totalCount: parsed.length },
          'LLM response: dropped invalid items, kept valid ones',
        );
      }
      return validItems;
    } catch (err) {
      if (externalSignal?.aborted) {
        throw abortError(
          err instanceof Error ? err.message : 'Constraint mapping aborted',
          err,
        );
      }
      if (timeoutController.signal.aborted) {
        throw llmTimeoutError();
      }
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

function llmItemToConstraint(
  item: LlmConstraintItem,
  fuzzyMatcher?: FuzzyMatcherPort,
): {
  readonly constraint: NormalizedConstraint;
  readonly linkedEntity: boolean;
} {
  // Range objects (`{min, max}`) are normalized into a discriminated form;
  // strings, numbers, and string-arrays pass through unchanged. The Zod
  // schema (LlmConstraintItemSchema) guarantees `value` is non-null, so the
  // discriminator is purely typeof + Array.isArray.
  const rawValue = item.value;
  const canonicalized = canonicalizeEntityLikeValue(item, fuzzyMatcher);
  const value: NormalizedConstraint['value'] =
    canonicalized !== null
      ? canonicalized.value
      : (typeof rawValue === 'object' && !Array.isArray(rawValue)
          ? { min: rawValue.min, max: rawValue.max }
          : rawValue);

  return {
    constraint: {
      attribute: item.attribute,
      operator: item.operator,
      value,
      source_phrase: canonicalized !== null ? `llm_linker(${item.phrase})` : item.phrase,
      confidence: item.confidence,
      mapping_version: canonicalized !== null ? LLM_ENTITY_LINKER_VERSION : LLM_MAPPING_VERSION,
    },
    linkedEntity: canonicalized !== null,
  };
}

function canonicalizeEntityLikeValue(
  item: LlmConstraintItem,
  fuzzyMatcher?: FuzzyMatcherPort,
): { readonly value: string } | null {
  if (!ENTITY_LIKE_ATTRIBUTES.has(item.attribute)) {
    return null;
  }
  if (typeof item.value !== 'string') {
    return null;
  }
  const resolved = resolveEntity(item.value, { preferEntityOverStyle: true }, fuzzyMatcher);
  if (resolved === null || resolved.entityType !== item.attribute) {
    return null;
  }
  return { value: resolved.canonicalValue };
}

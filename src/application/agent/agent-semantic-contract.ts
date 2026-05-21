import { z } from 'zod';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import type { ChatLlmPort } from '../../domain/ai/port/chat-llm.port.js';
import type {
  AgentQueryExecutionContract,
  AgentSearchDefaults,
} from './agent-query-execution-contract.js';
import {
  SEARCH_TOOL_OCCASION_VALUES,
  SEARCH_TOOL_STYLE_HINT_VALUES,
} from '../search/search-tool-contract.js';
import {
  RECIPIENT_PROFILE_VALUES,
} from '../../domain/query/service/recipient-situation-profile.js';
import { estimateTokenCount } from './agent-llm-output.js';
import type { AgentExecutionState } from './agent-execution-state.js';

const log = bootstrapLogger.child({ component: 'AgentSemanticContractCompiler' });

export const AGENT_SEMANTIC_CONTRACT_PROMPT_VERSION = 'agent-semantic-contract-v1';

/** One semantic-contract call should be concise; the schema is intentionally compact. */
const SEMANTIC_CONTRACT_MAX_OUTPUT_TOKENS = 768;
/** Pinned seed keeps contract compilation replay-stable where the provider supports it. */
const SEMANTIC_CONTRACT_SEED = 11;
/** Shortest non-empty query/source span accepted by the contract schema. */
const SEMANTIC_TEXT_MIN_CHARS = 1;
/** Enough for a literal source span without allowing full-query rationales. */
const SEMANTIC_SOURCE_MAX_CHARS = 80;
/** Agent queries are capped upstream; this mirrors that boundary defensively. */
const SEMANTIC_SURFACE_MAX_CHARS = 2_000;
/** Contract confidence is normalized probability-like evidence from the compiler. */
const SEMANTIC_CONFIDENCE_MIN = 0;
/** Contract confidence is normalized probability-like evidence from the compiler. */
const SEMANTIC_CONFIDENCE_MAX = 1;
/** Numeric semantic preferences cover normalized scores plus bounded physical values such as ABV. */
const SEMANTIC_NUMERIC_VALUE_MAX = 100;
/** One recommendation is the smallest meaningful tool result count. */
const SEMANTIC_RESULT_LIMIT_MIN = 1;
/** Keep contract-imposed result count narrow; larger sets are planner policy, not meaning. */
const SEMANTIC_RESULT_LIMIT_MAX = 10;
/** One-shot slang/preferences should not force low-confidence semantic defaults. */
const SEMANTIC_PREFERENCE_CONFIDENCE_FLOOR = 0.75;
/**
 * Calibrated abstention threshold for the top-level semantic contract
 * `confidence` field. Below this value the compiler abstains — i.e. returns
 * `undefined` so the deterministic contract is preserved instead of merging
 * an under-confident LLM contract that could degrade tool selection.
 *
 * Selective prediction with a calibrated threshold is the standard
 * "abstain when the model is unsure" technique (Mozannar & Sontag,
 * "Consistent Estimators for Learning to Defer to an Expert," NeurIPS 2020).
 * The 0.5 value matches the schema midpoint (confidence is on [0, 1]) and
 * is the canonical cut-off for binary admit/reject under unit cost. Tune
 * upward only with gold-abstention labels demonstrating that a stricter
 * threshold yields net-positive admission quality.
 */
export const MIN_SEMANTIC_CONTRACT_CONFIDENCE_THRESHOLD = 0.5;

const SEMANTIC_CONTRACT_INTENTS = [
  'recommendation',
  'exact_lookup',
  'food_pairing',
  'comparison',
  'knowledge',
  'off_domain',
  'unknown',
] as const;

const SEMANTIC_PREFERENCE_AXES = [
  'style',
  'occasion',
  'recipient_profile',
  'gift_suitability_min',
  'beginner_suitability_min',
  'producer_prestige_min',
  'popularity_min',
  'sweetness_min',
  'sweetness_max',
  'acidity_min',
  'acidity_max',
  'tannin_max',
  'max_alcohol_pct',
  'drinking_window',
] as const;
const SEMANTIC_STRING_PREFERENCE_AXES: ReadonlySet<(typeof SEMANTIC_PREFERENCE_AXES)[number]> = new Set([
  'style',
  'occasion',
  'recipient_profile',
  'drinking_window',
]);
const SEMANTIC_NUMERIC_PREFERENCE_AXES: ReadonlySet<(typeof SEMANTIC_PREFERENCE_AXES)[number]> = new Set([
  'gift_suitability_min',
  'beginner_suitability_min',
  'producer_prestige_min',
  'popularity_min',
  'sweetness_min',
  'sweetness_max',
  'acidity_min',
  'acidity_max',
  'tannin_max',
  'max_alcohol_pct',
]);

const SEMANTIC_OBLIGATIONS = [
  'grounded_search_required',
  'claim_evidence_required',
  'recommend_exactly_one',
] as const;

const SEMANTIC_FORBIDDEN_ACTIONS = [
  'surface_rewrite',
  'answer_without_grounding',
] as const;

const SEMANTIC_STYLE_HINT_VALUE_SET: ReadonlySet<string> = new Set(SEARCH_TOOL_STYLE_HINT_VALUES);
const SEMANTIC_OCCASION_VALUE_SET: ReadonlySet<string> = new Set(SEARCH_TOOL_OCCASION_VALUES);
const SEMANTIC_RECIPIENT_PROFILE_VALUE_SET: ReadonlySet<string> = new Set(RECIPIENT_PROFILE_VALUES);

function isKnownSemanticPreferenceValue(
  axis: (typeof SEMANTIC_PREFERENCE_AXES)[number],
  value: string | number,
): boolean {
  if (SEMANTIC_NUMERIC_PREFERENCE_AXES.has(axis)) {
    return typeof value === 'number';
  }
  if (SEMANTIC_STRING_PREFERENCE_AXES.has(axis) && typeof value !== 'string') {
    return false;
  }
  switch (axis) {
    case 'style':
      return typeof value === 'string' && SEMANTIC_STYLE_HINT_VALUE_SET.has(value);
    case 'occasion':
      return typeof value === 'string' && SEMANTIC_OCCASION_VALUE_SET.has(value);
    case 'recipient_profile':
      return typeof value === 'string' && SEMANTIC_RECIPIENT_PROFILE_VALUE_SET.has(value);
    case 'drinking_window':
      return value === 'now';
    default:
      return typeof value === 'number';
  }
}

const SemanticPreferenceSchema = z
  .object({
    axis: z.enum(SEMANTIC_PREFERENCE_AXES),
    value: z.union([
      z.string().min(SEMANTIC_TEXT_MIN_CHARS).max(SEMANTIC_SOURCE_MAX_CHARS),
      z.number().finite().min(SEMANTIC_CONFIDENCE_MIN).max(SEMANTIC_NUMERIC_VALUE_MAX),
    ]),
    source: z.string().min(SEMANTIC_TEXT_MIN_CHARS).max(SEMANTIC_SOURCE_MAX_CHARS),
    confidence: z.number().finite().min(SEMANTIC_CONFIDENCE_MIN).max(SEMANTIC_CONFIDENCE_MAX),
  })
  .strict()
  .superRefine((preference, ctx) => {
    if (!isKnownSemanticPreferenceValue(preference.axis, preference.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `Unsupported semantic preference value for axis ${preference.axis}`,
      });
    }
  });

const AgentSemanticContractSchema = z
  .object({
    promptVersion: z.literal(AGENT_SEMANTIC_CONTRACT_PROMPT_VERSION),
    preservedSurface: z.string().min(SEMANTIC_TEXT_MIN_CHARS).max(SEMANTIC_SURFACE_MAX_CHARS),
    intent: z.enum(SEMANTIC_CONTRACT_INTENTS),
    confidence: z.number().finite().min(SEMANTIC_CONFIDENCE_MIN).max(SEMANTIC_CONFIDENCE_MAX),
    inferredPreferences: z.array(SemanticPreferenceSchema).max(SEMANTIC_RESULT_LIMIT_MAX),
    obligations: z.array(z.enum(SEMANTIC_OBLIGATIONS)).max(SEMANTIC_RESULT_LIMIT_MAX),
    forbidden: z.array(z.enum(SEMANTIC_FORBIDDEN_ACTIONS)).max(SEMANTIC_RESULT_LIMIT_MAX),
    resultLimit: z.number().int().min(SEMANTIC_RESULT_LIMIT_MIN).max(SEMANTIC_RESULT_LIMIT_MAX).optional(),
  })
  .strict();

export type AgentSemanticContract = z.infer<typeof AgentSemanticContractSchema>;

function shouldCompileSemanticContract(query: string): boolean {
  const normalized = query.normalize('NFC');
  return /[ㄱ-ㅎㅏ-ㅣ]/u.test(normalized);
}

function buildSystemPrompt(): string {
  return [
    'You are Cuvee SemanticContractCompiler.',
    'Your only job is meaning analysis. Do not answer the user. Do not call tools.',
    'Output strict JSON only, matching this contract:',
    '{',
    `  "promptVersion": "${AGENT_SEMANTIC_CONTRACT_PROMPT_VERSION}",`,
    '  "preservedSurface": "<exact user query>",',
    `  "intent": ${SEMANTIC_CONTRACT_INTENTS.map((intent) => `"${intent}"`).join(' | ')},`,
    '  "confidence": 0.0-1.0,',
    '  "inferredPreferences": [{"axis":"style","value":"crowd_pleasing","source":"ㄱㅊ","confidence":0.86}],',
    `  "obligations": ${SEMANTIC_OBLIGATIONS.map((value) => `"${value}"`).join(' | ')}[],`,
    `  "forbidden": ${SEMANTIC_FORBIDDEN_ACTIONS.map((value) => `"${value}"`).join(' | ')}[],`,
    '  "resultLimit": optional integer',
    '}',
    '',
    'Rules:',
    '- Preserve the user query exactly in preservedSurface. Never rewrite chat slang in the surface.',
    '- Emit inferredPreferences only when the meaning is clear from the user text.',
    `- style values must be one of: ${SEARCH_TOOL_STYLE_HINT_VALUES.join(', ')}.`,
    `- occasion values must be one of: ${SEARCH_TOOL_OCCASION_VALUES.join(', ')}.`,
    `- recipient_profile values must be one of: ${RECIPIENT_PROFILE_VALUES.join(', ')}.`,
    '- Semantic chat slang like "ㄱㅊ" may mean a decent/safe/crowd-pleasing recommendation; encode that as typed preference, not as rewritten query text.',
    '- Recommendation/comparison/specific wine factual questions require grounded_search_required and claim_evidence_required.',
    '- If the user asks for one item ("하나만", "one"), set resultLimit=1 and include recommend_exactly_one.',
    '- If unsure, keep inferredPreferences empty and intent "unknown".',
  ].join('\n');
}

function buildUserPrompt(query: string, deterministicContract: AgentQueryExecutionContract): string {
  return JSON.stringify({
    query,
    deterministicContract: {
      requiresGroundedWineSearch: deterministicContract.requiresGroundedWineSearch === true,
      hasEntityMetadataSignal: deterministicContract.hasEntityMetadataSignal,
      requiredTool: deterministicContract.requiredTool,
      searchDefaults: deterministicContract.searchDefaults,
    },
  });
}

function parseSemanticContract(text: string): AgentSemanticContract | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const validated = AgentSemanticContractSchema.safeParse(parsed);
  return validated.success ? validated.data : undefined;
}

function maxNumber(left: number | undefined, right: number): number {
  return left === undefined ? right : Math.max(left, right);
}

function mergeStringList(
  existing: readonly string[] | undefined,
  value: string,
): readonly string[] {
  const merged = [...(existing ?? [])];
  if (!merged.includes(value)) {
    merged.push(value);
  }
  return merged;
}

function isRecipientProfile(value: string): value is NonNullable<AgentSearchDefaults['recipient_profile']> {
  return RECIPIENT_PROFILE_VALUES.some((candidate) => candidate === value);
}

function mergePreference(
  defaults: AgentSearchDefaults,
  preference: AgentSemanticContract['inferredPreferences'][number],
): AgentSearchDefaults {
  if (preference.confidence < SEMANTIC_PREFERENCE_CONFIDENCE_FLOOR) {
    return defaults;
  }
  const value = preference.value;
  switch (preference.axis) {
    case 'style':
      return typeof value === 'string'
        ? { ...defaults, styles: mergeStringList(defaults.styles, value) }
        : defaults;
    case 'occasion':
      return typeof value === 'string'
        ? { ...defaults, occasion: mergeStringList(defaults.occasion, value) }
        : defaults;
    case 'recipient_profile':
      return typeof value === 'string' && isRecipientProfile(value)
        ? { ...defaults, recipient_profile: value }
        : defaults;
    case 'gift_suitability_min':
      return typeof value === 'number'
        ? { ...defaults, gift_suitability_min: maxNumber(defaults.gift_suitability_min, value) }
        : defaults;
    case 'beginner_suitability_min':
      return typeof value === 'number'
        ? { ...defaults, beginner_suitability_min: maxNumber(defaults.beginner_suitability_min, value) }
        : defaults;
    case 'producer_prestige_min':
      return typeof value === 'number'
        ? { ...defaults, producer_prestige_min: maxNumber(defaults.producer_prestige_min, value) }
        : defaults;
    case 'popularity_min':
      return typeof value === 'number'
        ? { ...defaults, popularity_min: maxNumber(defaults.popularity_min, value) }
        : defaults;
    case 'sweetness_min':
      return typeof value === 'number' ? { ...defaults, sweetness_min: value } : defaults;
    case 'sweetness_max':
      return typeof value === 'number' ? { ...defaults, sweetness_max: value } : defaults;
    case 'acidity_min':
      return typeof value === 'number' ? { ...defaults, acidity_min: value } : defaults;
    case 'acidity_max':
      return typeof value === 'number' ? { ...defaults, acidity_max: value } : defaults;
    case 'tannin_max':
      return typeof value === 'number' ? { ...defaults, tannin_max: value } : defaults;
    case 'max_alcohol_pct':
      return typeof value === 'number' ? { ...defaults, max_alcohol_pct: value } : defaults;
    case 'drinking_window':
      return value === 'now' ? { ...defaults, drinking_window: 'now' } : defaults;
  }
}

function buildSearchDefaultsFromSemanticContract(
  existing: AgentSearchDefaults | undefined,
  semanticContract: AgentSemanticContract,
): AgentSearchDefaults | undefined {
  let defaults: AgentSearchDefaults = { ...(existing ?? {}) };
  for (const preference of semanticContract.inferredPreferences) {
    defaults = mergePreference(defaults, preference);
  }
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

export function mergeAgentSemanticContract(
  contract: AgentQueryExecutionContract,
  semanticContract: AgentSemanticContract,
): AgentQueryExecutionContract {
  const searchDefaults = buildSearchDefaultsFromSemanticContract(
    contract.searchDefaults,
    semanticContract,
  );
  const requiresGroundedWineSearch =
    contract.requiresGroundedWineSearch === true
    || semanticContract.obligations.includes('grounded_search_required');
  const resultLimit =
    semanticContract.resultLimit ?? (
      semanticContract.obligations.includes('recommend_exactly_one')
        ? SEMANTIC_RESULT_LIMIT_MIN
        : undefined
    );

  return {
    ...contract,
    semanticContract,
    ...(searchDefaults !== undefined ? { searchDefaults } : {}),
    ...(requiresGroundedWineSearch ? { requiresGroundedWineSearch: true } : {}),
    ...(resultLimit !== undefined ? { resultLimit } : {}),
  };
}

export class AgentSemanticContractCompiler {
  constructor(private readonly chatLlm: ChatLlmPort) {}

  async compileIfNeeded(input: {
    readonly query: string;
    readonly requestId: string;
    readonly deterministicContract: AgentQueryExecutionContract;
    readonly timeoutMs: number;
    /**
     * Shared execution state. Tokens spent on the semantic-contract LLM call
     * are accumulated here so that the agent's `maxTotalTokens` guard
     * (agent-run-loop.ts) accounts for this preamble call. Without this
     * accumulation the budget can be exceeded by the contract call's tokens
     * before the planner loop even begins.
     */
    readonly state: AgentExecutionState;
    readonly abortSignal?: AbortSignal | undefined;
  }): Promise<AgentSemanticContract | undefined> {
    if (!shouldCompileSemanticContract(input.query)) {
      return undefined;
    }

    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(input.query, input.deterministicContract);

    const controller = new AbortController();
    const propagateAbort = (): void => { controller.abort(); };
    input.abortSignal?.addEventListener('abort', propagateAbort, { once: true });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.chatLlm.complete({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0,
          maxOutputTokens: SEMANTIC_CONTRACT_MAX_OUTPUT_TOKENS,
          seed: SEMANTIC_CONTRACT_SEED,
          abortSignal: controller.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            controller.abort();
            reject(new Error('semantic contract compiler timeout'));
          }, input.timeoutMs);
        }),
      ]);
      // Account for tokens regardless of whether the response parses — the
      // LLM call already consumed budget. Reuse the planner's estimator so
      // the budget accounting stays consistent across both call sites.
      input.state.totalInputTokens += estimateTokenCount(systemPrompt) + estimateTokenCount(userPrompt);
      input.state.totalOutputTokens += estimateTokenCount(result.text);
      const parsed = parseSemanticContract(result.text);
      if (parsed === undefined || parsed.preservedSurface !== input.query) {
        log.warn(
          { requestId: input.requestId },
          'semantic contract compiler returned invalid or surface-mutating output; ignoring contract',
        );
        return undefined;
      }
      // Calibrated abstention: under-confident contracts are silently
      // discarded in favor of the deterministic contract (Mozannar &
      // Sontag, NeurIPS 2020 — learning-to-defer with calibrated cut-off).
      if (parsed.confidence < MIN_SEMANTIC_CONTRACT_CONFIDENCE_THRESHOLD) {
        log.warn(
          { requestId: input.requestId, confidence: parsed.confidence },
          'semantic contract compiler abstained: confidence below MIN_SEMANTIC_CONTRACT_CONFIDENCE_THRESHOLD',
        );
        return undefined;
      }
      return parsed;
    } catch (err) {
      log.warn({ err, requestId: input.requestId }, 'semantic contract compiler failed; preserving deterministic contract');
      return undefined;
    } finally {
      controller.abort();
      input.abortSignal?.removeEventListener('abort', propagateAbort);
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}

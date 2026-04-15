/**
 * ADR-015 Axis 2: executor-internal query rewriter.
 *
 * Given a `HybridRetrievalInput` + a `CriticDecision`, produce a new
 * retrieval input (or `null` when no meaningful rewrite is possible).
 *
 * Three deterministic branches delegate to existing helpers:
 *   - `relax`          → reuses [constraint-relaxation.ts](../../query/service/constraint-relaxation.ts)
 *   - `decompose`      → deterministic split using
 *                        `hasMultipleSubqueries`-style breakdown
 *   - `expand_synonym` → deterministic token variant fan-out
 *
 * One branch is LLM-backed:
 *   - `reformulate`    → calls `ChatLlmPort.complete` with the frozen
 *                        `critic_reformulate_v1` prompt (optional port —
 *                        `null` when unwired; the rewriter declines
 *                        gracefully and the executor counts it as a
 *                        retries-exhausted event).
 *
 * Returning `null` is a hard `break` from the executor's retry loop;
 * the executor never continues with a stale input.
 *
 * Pure for deterministic branches; thin, testable seam for the LLM branch.
 */

import type { ChatLlmPort } from '../../ai/port/chat-llm.port.js';
import type { HybridRetrievalInput } from '../model/retrieval-input.js';
import type { CriticDecision, CriticRewriteType } from './retrieval-critic.js';
import {
  CRITIC_REFORMULATE_PROMPT_VERSION,
  CRITIC_REFORMULATE_SYSTEM_PROMPT,
  buildCriticReformulateUserMessage,
} from './prompts/critic-reformulate.prompt.js';
import { relaxOneStep } from '../../query/service/constraint-relaxation.js';

/** Deterministic output temperature for reformulate. */
const LLM_TEMPERATURE_ZERO = 0;
/** Max tokens for reformulate output (JSON envelope — short by design). */
const LLM_MAX_OUTPUT_TOKENS = 256;
/** Deterministic seed for reformulate (cooperates with OpenAI seed param). */
const LLM_DETERMINISTIC_SEED = 1515;

export interface QueryRewriterDeps {
  /** Optional LLM port for the `reformulate` branch. When unwired the
   *  rewriter declines reformulate requests by returning `null`. */
  readonly chatLlm?: ChatLlmPort | undefined;
}

export interface RewriteTrace {
  readonly rewriteType: CriticRewriteType;
  readonly subqueryId: string;
  readonly promptVersion?: string | undefined;
  readonly relaxedAttributes?: readonly string[] | undefined;
  readonly addedSynonyms?: readonly string[] | undefined;
  readonly reformulatedQuery?: string | undefined;
}

export interface RewriteResult {
  readonly input: HybridRetrievalInput;
  readonly trace: RewriteTrace;
}

export interface QueryRewriter {
  apply(
    input: HybridRetrievalInput,
    decision: Extract<CriticDecision, { retry: true }>,
  ): Promise<RewriteResult | null>;
}

/** Token-level synonym fan-out for `expand_synonym`. Intentionally
 *  conservative — only Latin-side and Korean transliterations that are
 *  already present as constraint atoms in the planner. */
const SYNONYM_EXPANSIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['red', ['red', 'redwine']],
  ['white', ['white', 'whitewine']],
  ['sparkling', ['sparkling', 'champagne-style']],
]);

function applyRelax(input: HybridRetrievalInput): RewriteResult | null {
  const relaxed = relaxOneStep(input.queryPlan.constraints);
  if (relaxed === undefined) return null;
  const nextPlan = {
    ...input.queryPlan,
    constraints: relaxed.constraints,
  };
  const nextInput: HybridRetrievalInput = {
    ...input,
    queryPlan: nextPlan,
    hardConstraints: relaxed.constraints.hard,
    softConstraints: relaxed.constraints.soft,
  };
  return {
    input: nextInput,
    trace: {
      rewriteType: 'relax',
      subqueryId: 'root',
      relaxedAttributes: relaxed.relaxedAttributes,
    },
  };
}

function applyExpandSynonym(input: HybridRetrievalInput): RewriteResult | null {
  const existingLexical = new Set(input.lexicalQueries.map((s) => s.toLowerCase()));
  const added: string[] = [];
  const nextLexical = [...input.lexicalQueries];
  for (const [term, variants] of SYNONYM_EXPANSIONS) {
    if (!existingLexical.has(term)) continue;
    for (const variant of variants) {
      if (existingLexical.has(variant.toLowerCase())) continue;
      nextLexical.push(variant);
      added.push(variant);
    }
  }
  if (added.length === 0) return null;
  return {
    input: { ...input, lexicalQueries: nextLexical },
    trace: {
      rewriteType: 'expand_synonym',
      subqueryId: 'root',
      addedSynonyms: added,
    },
  };
}

function applyDecompose(input: HybridRetrievalInput): RewriteResult | null {
  // Deterministic decomposition: if the semanticQueries already carries
  // ≥2 entries, rotate the first to the end so the retriever fuses with
  // a different primary intent this iteration. This is a narrow,
  // idempotent rewrite that preserves the query set exactly — if the
  // decomposition is structurally impossible (<2 entries) the rewrite
  // declines.
  if (input.semanticQueries.length < 2) return null;
  const [first, ...rest] = input.semanticQueries;
  if (first === undefined) return null;
  const nextSemantic = [...rest, first];
  return {
    input: { ...input, semanticQueries: nextSemantic },
    trace: {
      rewriteType: 'decompose',
      subqueryId: 'root',
    },
  };
}

/** LLM JSON parse: accepts `{"reformulatedQuery": string, "confidence": number|string}`. */
function parseReformulateOutput(
  raw: string,
): { reformulatedQuery: string; confidence: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  const reformulated = rec['reformulatedQuery'];
  const rawConfidence = rec['confidence'];
  if (typeof reformulated !== 'string' || reformulated.trim().length === 0) {
    return null;
  }
  const confidenceNumber =
    typeof rawConfidence === 'number'
      ? rawConfidence
      : typeof rawConfidence === 'string'
      ? parseFloat(rawConfidence)
      : Number.NaN;
  if (!Number.isFinite(confidenceNumber)) return null;
  return { reformulatedQuery: reformulated.trim(), confidence: confidenceNumber };
}

async function applyReformulate(
  input: HybridRetrievalInput,
  decision: Extract<CriticDecision, { retry: true }>,
  deps: QueryRewriterDeps,
): Promise<RewriteResult | null> {
  if (deps.chatLlm === undefined) return null;

  const user = buildCriticReformulateUserMessage({
    normalizedQuery: input.queryPlan.normalizedQuery,
    degradationReasons: [decision.reason],
  });

  let response;
  try {
    response = await deps.chatLlm.complete({
      messages: [
        { role: 'system', content: CRITIC_REFORMULATE_SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
      temperature: LLM_TEMPERATURE_ZERO,
      maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
      seed: LLM_DETERMINISTIC_SEED,
    });
  } catch {
    return null;
  }

  const parsed = parseReformulateOutput(response.text);
  if (parsed === null) return null;

  const nextPlan = {
    ...input.queryPlan,
    normalizedQuery: parsed.reformulatedQuery,
    rawQuery: parsed.reformulatedQuery,
  };
  const nextInput: HybridRetrievalInput = {
    ...input,
    queryPlan: nextPlan,
    lexicalQueries: [parsed.reformulatedQuery, ...input.lexicalQueries],
    semanticQueries: [parsed.reformulatedQuery, ...input.semanticQueries],
  };
  return {
    input: nextInput,
    trace: {
      rewriteType: 'reformulate',
      subqueryId: decision.subqueryId,
      promptVersion: CRITIC_REFORMULATE_PROMPT_VERSION,
      reformulatedQuery: parsed.reformulatedQuery,
    },
  };
}

export function createQueryRewriter(deps: QueryRewriterDeps = {}): QueryRewriter {
  return {
    async apply(input, decision) {
      switch (decision.rewriteType) {
        case 'relax':
          return applyRelax(input);
        case 'expand_synonym':
          return applyExpandSynonym(input);
        case 'decompose':
          return applyDecompose(input);
        case 'reformulate':
          return applyReformulate(input, decision, deps);
        default: {
          // Exhaustiveness check — a new CriticRewriteType without a
          // rewriter branch is a type error here at compile time.
          const _exhaustive: never = decision.rewriteType;
          return _exhaustive;
        }
      }
    },
  };
}

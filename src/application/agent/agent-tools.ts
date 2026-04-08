/**
 * Wraps existing use cases as agent tools.
 *
 * Each tool:
 *   1. Validates input with Zod
 *   2. Calls the existing use case (unchanged)
 *   3. Returns a summarized observation string for the LLM context
 *
 * The use cases, Vespa, ranking, decision — NONE are modified.
 */

import { z } from 'zod';
import type { SearchExecutorPort } from '../search/port/search-executor.port.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type { DrinkingWindowBlock } from '../../domain/response/model/result-item.js';
import type { EntityId } from '../../domain/shared/types/index.js';
import { createEntityId } from '../../domain/shared/types/index.js';
import type { RetrievalDocument } from '../../domain/retrieval/model/retrieval-document.js';

// ---------------------------------------------------------------------------
// Input schemas (same as tool-schemas.ts — reusing patterns)
// ---------------------------------------------------------------------------

const SearchInputSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(20).optional(),
  retrieval_mode: z.enum(['auto', 'entity', 'hybrid', 'mixed']).optional(),
});

const CompareInputSchema = z.object({
  query_a: z.string().min(1).max(500),
  query_b: z.string().min(1).max(500),
});

const DrinkingWindowInputSchema = z.object({
  entity_id: z.string().min(1),
  target_year: z.number().int().optional(),
});

const FoodPairingInputSchema = z.object({
  food: z.string().min(1),
  max_price: z.number().optional(),
  color: z.enum(['red', 'white', 'rosé', 'sparkling']).optional(),
});

// ---------------------------------------------------------------------------
// Tool result type
// ---------------------------------------------------------------------------

export interface AgentToolResult {
  /** Human-readable observation for the LLM context window. */
  readonly observation: string;
  /** Raw structured result (for inclusion in final response). */
  readonly rawResult: unknown;
}

// ---------------------------------------------------------------------------
// Dependencies (existing use cases — no changes)
// ---------------------------------------------------------------------------

export interface AgentToolDeps {
  readonly searchUseCase: SearchExecutorPort;
  readonly decomposedSearchExecute?: (
    subQueries: readonly string[],
    comparisonIntent: string,
    originalQuery: string,
    requestId: string,
    startTime: number,
  ) => Promise<ComparisonSearchResponse>;
  readonly drinkingWindowCheck?: (input: {
    vintage: number;
    grapePrimaryEnc: number;
    regionEnc: number;
    countryEnc: number;
    body: number;
    tannin: number;
    acidity: number;
    sweetness: number;
    avgCriticProxyScore: number;
    targetYear: number;
  }) => Promise<DrinkingWindowBlock>;
  /** Direct entity lookup by ID — bypasses the full search pipeline.
   *  When provided, check_drinking_window resolves entities via this port
   *  instead of running a search-as-lookup through searchUseCase. */
  readonly entityLookup?: ((id: EntityId) => Promise<RetrievalDocument | undefined>) | undefined;
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

const KNOWN_TOOLS = new Set([
  'search_wines',
  'compare_wines',
  'check_drinking_window',
  'get_food_pairings',
]);

export function isKnownTool(name: string): boolean {
  return KNOWN_TOOLS.has(name);
}

export async function executeAgentTool(
  toolName: string,
  input: Record<string, unknown>,
  deps: AgentToolDeps,
  requestId: string,
): Promise<AgentToolResult> {
  switch (toolName) {
    case 'search_wines': {
      const parseResult = SearchInputSchema.safeParse(input);
      if (!parseResult.success) {
        return { observation: `Invalid input for search_wines: ${parseResult.error.issues.map((i) => i.message).join(', ')}`, rawResult: null };
      }
      const parsed = parseResult.data;
      const response = await deps.searchUseCase.execute(
        {
          query: parsed.query,
          ...(parsed.retrieval_mode !== undefined
            ? { options: { mode: parsed.retrieval_mode, explain: false, clarification: false } }
            : {}),
        },
        requestId,
      );

      if (response.queryType === 'comparison') {
        return {
          observation: summarizeComparison(response),
          rawResult: response,
        };
      }

      // Activate diversity dedup when query contains diversity hints
      const wantsDiversity = /(?:diverse|different|다른|다르게|각각|variety)/i.test(parsed.query);
      return {
        observation: summarizeSearchResults(response, wantsDiversity),
        rawResult: response,
      };
    }

    case 'compare_wines': {
      const parseResult = CompareInputSchema.safeParse(input);
      if (!parseResult.success) {
        return { observation: `Invalid input for compare_wines: ${parseResult.error.issues.map((i) => i.message).join(', ')}`, rawResult: null };
      }
      const parsed = parseResult.data;
      if (deps.decomposedSearchExecute === undefined) {
        return { observation: 'Compare tool not available.', rawResult: null };
      }
      const response = await deps.decomposedSearchExecute(
        [parsed.query_a, parsed.query_b],
        'compare',
        `${parsed.query_a} vs ${parsed.query_b}`,
        requestId,
        Date.now(),
      );
      return {
        observation: summarizeComparison(response),
        rawResult: response,
      };
    }

    case 'check_drinking_window': {
      const parseResult = DrinkingWindowInputSchema.safeParse(input);
      if (!parseResult.success) {
        return { observation: `Invalid input for check_drinking_window: ${parseResult.error.issues.map((i) => i.message).join(', ')}`, rawResult: null };
      }
      const parsed = parseResult.data;
      const targetYear = parsed.target_year ?? new Date().getFullYear();

      // Prefer direct entity lookup (O(1) Vespa GET) over the full search
      // pipeline (planner → retrieval → ranking → decision). The search-as-lookup
      // approach was fundamentally broken: it used the entity_id as a natural-language
      // query, which ran NL parsing, fuzzy matching, and ranking on an opaque ID.
      if (deps.entityLookup !== undefined) {
        const entityId = createEntityId(parsed.entity_id);
        const doc = await deps.entityLookup(entityId);
        if (doc === undefined) {
          return { observation: `Wine ${parsed.entity_id} not found.`, rawResult: null };
        }
        const start = doc.drinkingWindowStart;
        const end = doc.drinkingWindowEnd;
        if (start !== undefined && end !== undefined) {
          const currentlyDrinkable = targetYear >= start && targetYear <= end;
          const dw: DrinkingWindowBlock = {
            drinkingWindowStart: start,
            drinkingWindowEnd: end,
            currentlyDrinkable,
            confidence: 'medium',
            ...(doc.drinkingWindowModelVersion !== undefined
              ? { modelVersion: doc.drinkingWindowModelVersion }
              : {}),
          };
          return {
            observation: `${doc.canonicalLabel ?? parsed.entity_id}: drinking window ${start}-${end}, currently ${currentlyDrinkable ? 'drinkable' : 'not in window'}`,
            rawResult: dw,
          };
        }
        return {
          observation: `${doc.canonicalLabel ?? parsed.entity_id}: no drinking window data available.`,
          rawResult: null,
        };
      }

      // Fallback: search-as-lookup when entityLookup port is not wired.
      const searchResult = await deps.searchUseCase.execute(
        { query: parsed.entity_id, options: { mode: 'entity', explain: false, clarification: false } },
        requestId,
      );
      const firstResult = searchResult.queryType === 'search' ? searchResult.results[0] : undefined;
      if (firstResult === undefined) {
        return { observation: `Wine ${parsed.entity_id} not found.`, rawResult: null };
      }
      const dw = firstResult.drinkingWindow;
      if (dw !== undefined) {
        return {
          observation: `${firstResult.entity.canonicalLabel}: drinking window ${dw.drinkingWindowStart}-${dw.drinkingWindowEnd}, currently ${dw.currentlyDrinkable ? 'drinkable' : 'not in window'}, confidence: ${dw.confidence}`,
          rawResult: dw,
        };
      }
      return {
        observation: `${firstResult.entity.canonicalLabel}: no drinking window data available.`,
        rawResult: null,
      };
    }

    case 'get_food_pairings': {
      const parseResult = FoodPairingInputSchema.safeParse(input);
      if (!parseResult.success) {
        return { observation: `Invalid input for get_food_pairings: ${parseResult.error.issues.map((i) => i.message).join(', ')}`, rawResult: null };
      }
      const parsed = parseResult.data;
      const query = `wines for ${parsed.food}${parsed.color ? ` ${parsed.color}` : ''}${parsed.max_price ? ` under $${parsed.max_price}` : ''}`;
      const response = await deps.searchUseCase.execute({ query }, requestId);

      if (response.queryType !== 'search') {
        return { observation: 'Unexpected response type for pairing search.', rawResult: response };
      }
      return {
        observation: summarizeSearchResults(response),
        rawResult: response,
      };
    }

    default:
      return { observation: `Unknown tool: ${toolName}`, rawResult: null };
  }
}

// ---------------------------------------------------------------------------
// Observation summarizers (compact for LLM context)
// ---------------------------------------------------------------------------

function summarizeSearchResults(response: SearchResponseV1, diversify = false): string {
  const { results, engineDecision } = response;
  if (results.length === 0) {
    // Differentiate between three failure modes so the LLM can stop retrying
    // a backend that is genuinely down or a query that has no possible match.
    // The system prompt's "broaden and retry" rule (agent-prompt.ts) is gated
    // on the absence of "do_not_retry" — see prompt update.
    const status = engineDecision.decisionStatus;
    const executionMode = response.meta.executionMode;
    const degradationReasons = response.meta.degradationReasons;

    // BACKEND_DEGRADED: search infrastructure is unavailable / errored.
    // Retrying with a different query will produce the same result.
    const backendDown =
      status === 'failed'
      || executionMode === 'degraded'
      || (Array.isArray(degradationReasons) && degradationReasons.length > 0);
    if (backendDown) {
      return (
        'BACKEND_DEGRADED: search infrastructure is unavailable. '
        + `Status=${status}, executionMode=${executionMode ?? 'n/a'}. `
        + 'do_not_retry=true. Provide the user the best partial answer with this fact.'
      );
    }

    // CLARIFY: engine asked for clarification, not a search retry.
    if (engineDecision.nextAction === 'clarify') {
      return (
        'CLARIFY_REQUIRED: query was ambiguous. '
        + 'do_not_retry=true. Ask the user a single targeted clarification question.'
      );
    }

    // NO_MATCH: search ran successfully but the corpus has nothing matching.
    // The agent MAY broaden the query ONCE if the original was over-constrained.
    return (
      `NO_MATCH: search ran successfully (status=${status}) but found no wines. `
      + 'May retry once with a broader query if the original had multiple constraints. '
      + 'Otherwise tell the user no match exists.'
    );
  }

  // Optional producer-level dedup for diversity requests
  let displayResults = results;
  if (diversify && results.length > 3) {
    const seen = new Set<string>();
    displayResults = results.filter((r) => {
      const key = r.entity.producer ?? r.entity.entityId;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const lines = displayResults.slice(0, 5).map((r, i) => {
    const parts = [
      `${i + 1}. ${r.entity.canonicalLabel}`,
      `(id: ${r.entity.entityId})`,
      `score: ${r.relevanceScore.toFixed(2)}`,
    ];
    if (r.entity.producer) parts.push(`producer: ${r.entity.producer}`);
    if (r.entity.region) parts.push(`region: ${r.entity.region}`);
    if (r.entity.vintage) parts.push(`vintage: ${r.entity.vintage}`);
    if (r.drinkingWindow) {
      parts.push(`drink: ${r.drinkingWindow.drinkingWindowStart}-${r.drinkingWindow.drinkingWindowEnd}`);
    }
    return parts.join(' | ');
  });

  return `Found ${results.length} results (showing top ${Math.min(5, displayResults.length)}):\n${lines.join('\n')}`;
}

function summarizeComparison(response: ComparisonSearchResponse): string {
  const sides = response.entities.map((e) => {
    const top = e.topResult;
    if (top === null) return `${e.subQuery}: no result (status: ${e.resolutionStatus})`;
    const parts = [
      `${e.subQuery}: ${top.entity.canonicalLabel}`,
      `entity_id: ${top.entity.entityId}`,
      `score: ${top.relevanceScore.toFixed(2)}`,
    ];
    if (top.entity.producer) parts.push(`producer: ${top.entity.producer}`);
    if (top.entity.region) parts.push(`region: ${top.entity.region}`);
    if (top.entity.vintage) parts.push(`vintage: ${top.entity.vintage}`);
    if (top.drinkingWindow) {
      parts.push(`drink: ${top.drinkingWindow.drinkingWindowStart}-${top.drinkingWindow.drinkingWindowEnd}`);
    }
    // Include match type / style hints if available for richer comparison synthesis
    const matchType = top.match?.matchType;
    if (matchType) parts.push(`match: ${matchType}`);
    return parts.join(' | ');
  });

  // Build a rich observation that explicitly signals completion so the agent
  // doesn't thrash by calling search_wines for individual wines that are already
  // fully described above. The previous 2-line sparse observation lacked this
  // closure signal, causing the LLM to chain 2-3 unnecessary search_wines calls
  // ("let me look up more details on Side A...") which burned 15-25 seconds.
  const summary = [
    `Comparison (${response.comparisonIntent}):`,
    `Side A: ${sides[0]}`,
    `Side B: ${sides[1]}`,
    '',
    'COMPARISON_COMPLETE: Both wines are fully described above. You now have ALL data needed to synthesize your comparison answer. Do NOT call search_wines — the comparison result already contains everything.',
  ];
  return summary.join('\n');
}

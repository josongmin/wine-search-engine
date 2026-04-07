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

      return {
        observation: summarizeSearchResults(response),
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
      // Drinking window check requires full wine attributes — simplified for agent.
      // In MVP, we search for the entity first then check.
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

function summarizeSearchResults(response: SearchResponseV1): string {
  const { results, engineDecision } = response;
  if (results.length === 0) {
    return `No results found. Decision: ${engineDecision.decisionStatus}`;
  }

  const lines = results.slice(0, 5).map((r, i) => {
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

  return `Found ${results.length} results (showing top ${Math.min(5, results.length)}):\n${lines.join('\n')}`;
}

function summarizeComparison(response: ComparisonSearchResponse): string {
  const sides = response.entities.map((e) => {
    const top = e.topResult;
    if (top === null) return `${e.subQuery}: no result`;
    return `${e.subQuery}: ${top.entity.canonicalLabel} (id: ${top.entity.entityId}, score: ${top.relevanceScore.toFixed(2)})`;
  });
  return `Comparison (${response.comparisonIntent}):\n${sides.join('\n')}`;
}

/**
 * FoodPairingUseCase — standalone application use case for wine-food pairing
 * queries.
 *
 * Extracted from the inline `get_food_pairings` branch in
 * `src/application/agent/agent-tools.ts:1883-1958` so that:
 *  - Plan-then-Execute can wire a `FoodPairingUseCasePort` adapter to a real
 *    application use case (the runner does not know agent layer concerns).
 *  - The pairing pipeline can be exercised in isolation under unit tests.
 *
 * Behavioral parity with the agent-tools branch:
 *  - Same Zod input contract via {@link FoodPairingRequestSchema}.
 *  - Same KRW budget resolution rules (`resolveFoodPairingBudgetKrw`).
 *  - Same query enrichment (base "wine pairing for ${food}" + structured
 *    clauses for budget / styles / pairing tags).
 *  - Same structured filters / preferences mapping
 *    (`buildFoodPairingStructuredFilters`,
 *    `buildFoodPairingStructuredPreferences`).
 *  - Same hybrid retrieval mode for the underlying search.
 *  - Same macro-evidence closure that lifts the pairing constraint when
 *    multiple supporting axes agree (`closeFoodPairingMacroEvidence`
 *    parity — see `collectFoodPairingMacroEvidenceAxes` mirror below).
 *
 * What this module deliberately omits:
 *  - The agent-tools branch wraps the SearchResponseV1 in a structured
 *    observation string for the LLM context window. That formatting is an
 *    agent-layer concern (Spotlighting sanitization, observation budgeting)
 *    and stays in `agent-tools.ts`.
 *
 * Cleanup follow-up: once the agent loop adopts `FoodPairingUseCase`
 * directly, the inline copy under `agent-tools.ts:1883-1958` can be deleted.
 */

import { z } from 'zod';
import {
  buildFoodPairingStructuredFilters,
  buildFoodPairingStructuredPreferences,
  resolveFoodPairingBudgetKrw,
} from '../search/food-pairing-tool-policy.js';
import {
  closeFoodPairingMacroEvidence as ssotCloseFoodPairingMacroEvidence,
  type PairingEvidenceClosureInput as SsotPairingEvidenceClosureInput,
} from '../search/food-pairing-macro-evidence.js';
import { appendStructuredQueryClauses } from '../search/search-tool-query-policy.js';
import type { SearchExecutorPort } from '../search/port/search-executor.port.js';
import type { SearchRequest } from '../search/search-request.dto.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { NormalizedConstraint } from '../../domain/shared/types/index.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import { throwIfAborted } from '../../domain/shared/cooperative-abort.js';
import {
  KRW_PER_USD_APPROXIMATE,
  MAX_QUERY_LENGTH,
} from '../../domain/shared/constants.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Max length for the user-supplied `food` string. Mirrors the
 *  `FOOD_PAIRING_FOOD_MAX_LEN` bound on the agent tool schema. */
const FOOD_PAIRING_FOOD_MAX_LEN = 200;
/** Max characters per single style / pairing tag entry. Matches
 *  `SEARCH_TOOL_STYLE_HINT_MAX_LEN` on the agent tool schema. */
const FOOD_PAIRING_HINT_MAX_LEN = 50;
/** Max styles a single pairing request can carry. Matches
 *  `SEARCH_TOOL_MAX_STYLES`. */
const FOOD_PAIRING_MAX_STYLES = 5;
/** Max pairing tags a single request can carry. Matches
 *  `FOOD_PAIRING_MAX_PAIRING_TAGS` on the agent tool schema. */
const FOOD_PAIRING_MAX_PAIRING_TAGS = 5;
/** Max KRW price filter. Aligns with `MAX_PRICE_KRW_BOUND` in agent-tools
 *  (~100M KRW, safely above any real wine). */
const FOOD_PAIRING_MAX_PRICE_KRW = 100_000_000;
/** Max legacy USD `max_price` input. Derived from the KRW cap and the
 *  configured KRW-per-USD constant. Mirrors `buildFoodPairingFieldShape`. */
const FOOD_PAIRING_MAX_PRICE_USD = Math.ceil(
  FOOD_PAIRING_MAX_PRICE_KRW / KRW_PER_USD_APPROXIMATE,
);
/** Sweetness target is a [0,1] indexed preference. Matches
 *  `FOOD_PAIRING_SWEETNESS_TARGET_*` on the agent contract. */
const FOOD_PAIRING_SWEETNESS_TARGET_MIN = 0;
const FOOD_PAIRING_SWEETNESS_TARGET_MAX = 1;
/** Acidity / tannin bounds are on the [0,10] sensory ordinal scale used by
 *  the agent contract (`FOOD_PAIRING_SENSORY_SCALE_*`). */
const FOOD_PAIRING_SENSORY_SCALE_MIN = 0;
const FOOD_PAIRING_SENSORY_SCALE_MAX = 10;
/** Pairing color enum. Mirrors `FOOD_PAIRING_COLORS` in
 *  `search-tool-contract.ts`. `both` retained for legacy callers — the
 *  agent system prompt steers them to `search_wines` instead. */
const FOOD_PAIRING_COLORS = ['red', 'white', 'rosé', 'sparkling', 'both'] as const;

/** Mapping-version tag stamped onto constraints produced by this use case.
 *  Mirrors `AGENT_FILTER_VERSION` in agent-tools so structured-filter
 *  provenance is stable across the two entry points. */
const FOOD_PAIRING_FILTER_VERSION = 'agent_v1';

// Macro-evidence axes minimum is owned by the SSoT
// `food-pairing-macro-evidence.ts` as
// `FOOD_PAIRING_MIN_MACRO_EVIDENCE_AXES`. Both this use case and the agent
// `get_food_pairings` branch import that helper rather than re-declaring it.

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

/**
 * Input contract for the food-pairing use case.
 *
 * Fields mirror what `agent-tools.ts:get_food_pairings` accepts. Snake-case
 * is preserved so the helper functions in
 * `food-pairing-tool-policy.ts` (which consume the same key shape) can be
 * reused without an additional translation layer.
 *
 * `.strict()` per CLAUDE.md schema quality bar (rule 10 / quality bar).
 */
export const FoodPairingRequestSchema = z.object({
  food: z.string().trim().min(1).max(FOOD_PAIRING_FOOD_MAX_LEN),
  color: z.enum(FOOD_PAIRING_COLORS).optional(),
  styles: z.array(z.string().trim().min(1).max(FOOD_PAIRING_HINT_MAX_LEN))
    .max(FOOD_PAIRING_MAX_STYLES)
    .optional(),
  pairing_tags: z.array(z.string().trim().min(1).max(FOOD_PAIRING_HINT_MAX_LEN))
    .max(FOOD_PAIRING_MAX_PAIRING_TAGS)
    .optional(),
  max_price: z.number().finite().min(1).max(FOOD_PAIRING_MAX_PRICE_USD).optional(),
  max_price_krw: z.number().int().finite().min(1).max(FOOD_PAIRING_MAX_PRICE_KRW).optional(),
  sweetness_target: z.number().finite()
    .min(FOOD_PAIRING_SWEETNESS_TARGET_MIN)
    .max(FOOD_PAIRING_SWEETNESS_TARGET_MAX)
    .optional(),
  acidity_min: z.number().finite()
    .min(FOOD_PAIRING_SENSORY_SCALE_MIN)
    .max(FOOD_PAIRING_SENSORY_SCALE_MAX)
    .optional(),
  tannin_max: z.number().finite()
    .min(FOOD_PAIRING_SENSORY_SCALE_MIN)
    .max(FOOD_PAIRING_SENSORY_SCALE_MAX)
    .optional(),
}).strict();
export type FoodPairingRequest = z.infer<typeof FoodPairingRequestSchema>;

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

/**
 * Output of {@link FoodPairingUseCase.execute}. Shape mirrors the
 * `FoodPairingResult` port type in `execution-runner.ts` so the
 * `FoodPairingUseCaseAdapter` is a structural identity (no field
 * renaming required).
 */
export interface FoodPairingResponse {
  readonly food: string;
  readonly results: SearchResponseV1;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the underlying search pipeline returns a comparison response
 *  for a pairing query. This is a defensive surface — the pairing flow
 *  never decomposes into "A vs B". */
export class UnexpectedPairingResponseError extends DomainError {
  constructor(observedQueryType: string) {
    super(
      'UNEXPECTED_PAIRING_RESPONSE',
      `Food pairing expected a single search response but received '${observedQueryType}'.`,
    );
    this.name = 'UnexpectedPairingResponseError';
  }
}

// ---------------------------------------------------------------------------
// Macro-evidence closure — delegated to the SSoT helper
// (`src/application/search/food-pairing-macro-evidence.ts`). The agent
// tool branch and this use case share the same closure so the lift-pairing
// rule never drifts between code paths (CLAUDE.md rule 25/30).
// ---------------------------------------------------------------------------

type PairingEvidenceClosureInput = SsotPairingEvidenceClosureInput;

function closeFoodPairingMacroEvidence(
  response: SearchResponseV1,
  input: PairingEvidenceClosureInput,
): SearchResponseV1 {
  return ssotCloseFoodPairingMacroEvidence(response, input);
}

// ---------------------------------------------------------------------------
// Query enrichment — direct port of the `get_food_pairings` query build.
// ---------------------------------------------------------------------------

/** Base query prefix. Kept module-scoped so the literal can be audited and
 *  swapped without touching the execute() body (CLAUDE.md rule 15). */
const FOOD_PAIRING_QUERY_PREFIX = 'wine pairing for';

function buildPairingQuery(
  parsed: FoodPairingRequest,
  budgetKrw: number | undefined,
): string {
  const baseQuery = `${FOOD_PAIRING_QUERY_PREFIX} ${parsed.food}`;
  return appendStructuredQueryClauses(
    baseQuery,
    [
      ...(budgetKrw !== undefined ? [`${budgetKrw}원 이하`] : []),
      ...(parsed.styles !== undefined ? [...parsed.styles] : []),
      ...(parsed.pairing_tags !== undefined ? [...parsed.pairing_tags] : []),
    ],
  );
}

// ---------------------------------------------------------------------------
// Dependencies / Use case
// ---------------------------------------------------------------------------

interface FoodPairingUseCaseDeps {
  /** Search executor used for the underlying hybrid retrieval. Same port
   *  the agent tool branch uses, so callers may share an instance. */
  readonly searchUseCase: SearchExecutorPort;
}

interface FoodPairingExecuteOptions {
  readonly abortSignal?: AbortSignal | undefined;
}

/**
 * FoodPairingUseCase orchestrates a single hybrid search shaped by typed
 * pairing objectives (color, styles, pairing tags, sensory bounds) and
 * lifts the pairing constraint via macro-evidence closure.
 *
 * The use case is intentionally thin — it composes existing search-tool
 * policy helpers and the SearchExecutorPort. New behaviour belongs in the
 * helpers (so the agent-tools inline copy can adopt it too) rather than
 * here.
 */
export class FoodPairingUseCase {
  constructor(private readonly deps: FoodPairingUseCaseDeps) {}

  async execute(
    request: FoodPairingRequest,
    requestId: string,
    options?: FoodPairingExecuteOptions,
  ): Promise<FoodPairingResponse> {
    throwIfAborted(options?.abortSignal, 'Food pairing aborted before search');

    const budgetKrw = resolveFoodPairingBudgetKrw(
      {
        ...(request.max_price !== undefined ? { max_price: request.max_price } : {}),
        ...(request.max_price_krw !== undefined ? { max_price_krw: request.max_price_krw } : {}),
      },
      {
        krwPerUsd: KRW_PER_USD_APPROXIMATE,
        maxPriceKrwCap: FOOD_PAIRING_MAX_PRICE_KRW,
      },
    );

    const query = buildPairingQuery(request, budgetKrw);
    if (query.length > MAX_QUERY_LENGTH) {
      throw new DomainError(
        'FOOD_PAIRING_QUERY_TOO_LONG',
        `Enriched pairing query exceeded ${MAX_QUERY_LENGTH} characters (got ${query.length}).`,
      );
    }

    const structuredFilters: readonly NormalizedConstraint[] =
      buildFoodPairingStructuredFilters(request, FOOD_PAIRING_FILTER_VERSION);
    const structuredPreferences: readonly NormalizedConstraint[] =
      buildFoodPairingStructuredPreferences(request, FOOD_PAIRING_FILTER_VERSION);

    const searchRequest: SearchRequest = {
      query,
      options: { mode: 'hybrid', explain: false, clarification: false },
      ...(structuredFilters.length > 0 ? { filters: structuredFilters } : {}),
      ...(structuredPreferences.length > 0 ? { preferences: structuredPreferences } : {}),
    };

    const rawResponse = await this.deps.searchUseCase.execute(
      searchRequest,
      requestId,
      {
        ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
      },
    );

    if (rawResponse.queryType !== 'search') {
      throw new UnexpectedPairingResponseError(rawResponse.queryType);
    }

    const enriched = closeFoodPairingMacroEvidence(rawResponse, request);
    return {
      food: request.food,
      results: enriched,
    };
  }
}

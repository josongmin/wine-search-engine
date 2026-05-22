/**
 * DrinkabilityUseCaseAdapter — adapts the production
 * `DrinkingWindowUseCase.check(...)` (rich `DrinkingWindowCheckRequest`
 * input) to the runner's per-entity
 * `DrinkabilityUseCasePort.probe(entityId, targetYear, ...)` shape.
 *
 * The runner only carries `entityId + targetYear`. To call
 * `DrinkingWindowUseCase` we need the full predictor feature set, so the
 * adapter depends on an entity-lookup port that returns the indexed
 * runtime projection for that entity. Two outcomes:
 *
 *  - Entity not found / missing the predictor-required fields → return
 *    `undefined`. The runner treats `undefined` as "no drinkability data
 *    available" and filters it out of the fan-out result set.
 *  - Entity found with the required fields → build a
 *    `DrinkingWindowCheckRequest` and return a
 *    `{ entityId, targetYear, window }` probe.
 *
 * Cooperative cancellation: the entity-lookup callback may accept an
 * `AbortSignal`. The use case `check()` itself does not currently expose
 * an abort hook (see {@link DrinkingWindowUseCasePort}), so the adapter
 * pre-checks the signal once before invoking it.
 */

import type { CanonicalEntityId } from '../../../domain/shared/types/index.js';
import { createCanonicalEntityId } from '../../../domain/shared/types/index.js';
import { throwIfAborted } from '../../../domain/shared/cooperative-abort.js';
import type { RetrievalDocument } from '../../../domain/retrieval/model/retrieval-document.js';
import type {
  DrinkingWindowCheckRequest,
  DrinkingWindowUseCasePort,
} from '../../drinking-window/port/drinking-window-usecase.port.js';
import { DEFAULT_DRINKING_WINDOW_CRITIC_PROXY_SCORE } from '../../drinking-window/port/drinking-window-usecase.port.js';
import type {
  DrinkabilityProbe,
  DrinkabilityUseCasePort,
} from '../execution-runner.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Encoded categorical fallback when the projection lacks an enc field.
 *  The deterministic predictor accepts 0 as "unknown" — keeping the value
 *  named makes downstream audits trivial. */
const DRINKABILITY_ENCODED_FALLBACK = 0;
/** Sensory ordinal fallback for body/tannin/acidity/sweetness when the
 *  field is absent. The predictor falls back to the midpoint of the [1–5]
 *  ordinal scale (see `DRINKING_WINDOW_SENSORY_ORDINAL_SCALE` doc). */
const DRINKABILITY_SENSORY_MIDPOINT = 3;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Callback that resolves a `CanonicalEntityId` into a runtime projection
 *  rich enough to drive the drinking-window predictor. Production wiring
 *  should pass the same lookup the agent-tools branch uses
 *  (`drinkingWindowEntityLookup` or `entityLookup`). */
interface DrinkabilityEntityLookupPort {
  (
    entityId: CanonicalEntityId,
    options?: { readonly abortSignal?: AbortSignal | undefined },
  ): Promise<RetrievalDocument | undefined>;
}

interface DrinkabilityUseCaseAdapterDeps {
  readonly drinkingWindowUseCase: DrinkingWindowUseCasePort;
  readonly entityLookup: DrinkabilityEntityLookupPort;
}

export class DrinkabilityUseCaseAdapter implements DrinkabilityUseCasePort {
  constructor(private readonly deps: DrinkabilityUseCaseAdapterDeps) {}

  async probe(
    entityId: string,
    targetYear: number,
    requestId: string,
    options?: { readonly abortSignal?: AbortSignal | undefined },
  ): Promise<DrinkabilityProbe | undefined> {
    void requestId; // requestId is informational at this seam; the use case
                    // does not log it.
    throwIfAborted(options?.abortSignal, 'Drinkability probe aborted before lookup');

    const canonicalId = createCanonicalEntityId(entityId);
    const doc = await this.deps.entityLookup(
      canonicalId,
      {
        ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
      },
    );
    if (doc === undefined) {
      return undefined;
    }

    const request = mapRetrievalDocumentToCheckRequest(doc, targetYear);
    if (request === undefined) {
      return undefined;
    }

    throwIfAborted(options?.abortSignal, 'Drinkability probe aborted before check');
    const window = await this.deps.drinkingWindowUseCase.check(request);
    return { entityId, targetYear, window };
  }
}

// ---------------------------------------------------------------------------
// Pure projection mapping (exported for unit coverage)
// ---------------------------------------------------------------------------

/**
 * Build a `DrinkingWindowCheckRequest` from a `RetrievalDocument`.
 *
 * Returns `undefined` when the document is missing a feature the
 * predictor strictly requires (vintage year). All other fields fall back
 * to documented defaults (see constants at the top of this file) so the
 * deterministic predictor's "unknown → midpoint" branch is reachable.
 */
export function mapRetrievalDocumentToCheckRequest(
  doc: RetrievalDocument,
  targetYear: number,
): DrinkingWindowCheckRequest | undefined {
  const vintage = doc.vintageYear;
  if (vintage === undefined || !Number.isFinite(vintage)) {
    return undefined;
  }
  return {
    vintage,
    grapePrimaryEnc: doc.grapePrimaryEnc ?? DRINKABILITY_ENCODED_FALLBACK,
    regionEnc: doc.regionEnc ?? DRINKABILITY_ENCODED_FALLBACK,
    countryEnc: doc.countryEnc ?? DRINKABILITY_ENCODED_FALLBACK,
    ...(doc.body !== undefined ? { body: doc.body } : {}),
    tannin: doc.tannin ?? DRINKABILITY_SENSORY_MIDPOINT,
    acidity: doc.acidity ?? DRINKABILITY_SENSORY_MIDPOINT,
    ...(doc.sweetness !== undefined ? { sweetness: doc.sweetness } : {}),
    avgCriticProxyScore:
      doc.avgCriticProxyScore ?? DEFAULT_DRINKING_WINDOW_CRITIC_PROXY_SCORE,
    ...(doc.drinkingWindowStart !== undefined
      ? { priorDrinkingWindowStart: doc.drinkingWindowStart }
      : {}),
    ...(doc.drinkingWindowEnd !== undefined
      ? { priorDrinkingWindowEnd: doc.drinkingWindowEnd }
      : {}),
    ...(doc.drinkingWindowModelVersion !== undefined
      ? { priorDrinkingWindowModelVersion: doc.drinkingWindowModelVersion }
      : {}),
    ...(doc.grapePrimary !== undefined ? { grapePrimary: doc.grapePrimary } : {}),
    producer: doc.producer,
    region: doc.region,
    ...(doc.appellation !== undefined ? { appellation: doc.appellation } : {}),
    ...(doc.closure !== undefined ? { closure: doc.closure } : {}),
    ...(doc.producerPrestige !== undefined ? { producerPrestige: doc.producerPrestige } : {}),
    targetYear,
  };
}

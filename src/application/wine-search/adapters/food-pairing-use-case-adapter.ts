/**
 * FoodPairingUseCaseAdapter — adapts the standalone {@link FoodPairingUseCase}
 * to the `FoodPairingUseCasePort` consumed by `ExecutionRunner`.
 *
 * The runner port's `FoodPairingUseCaseInput` is the analysis-driven slice
 * (camelCase `pairingTags`, `maxPriceKrw`). The use case accepts a richer
 * `FoodPairingRequest` (snake_case keys, matching the agent-tool contract
 * so the existing policy helpers are reusable).
 *
 * The adapter only performs key-name translation — no business logic. Any
 * additional pairing behaviour belongs in {@link FoodPairingUseCase}.
 */

import type {
  FoodPairingRequest,
  FoodPairingResponse,
  FoodPairingUseCase,
} from '../../food-pairing/food-pairing.usecase.js';
import type {
  FoodPairingUseCaseInput,
} from '../execution-plan-schemas.js';
import type {
  FoodPairingResult,
  FoodPairingUseCasePort,
} from '../execution-runner.js';

export class FoodPairingUseCaseAdapter implements FoodPairingUseCasePort {
  constructor(private readonly useCase: FoodPairingUseCase) {}

  async execute(
    input: FoodPairingUseCaseInput,
    requestId: string,
    options?: { readonly abortSignal?: AbortSignal | undefined },
  ): Promise<FoodPairingResult> {
    const request = mapFoodPairingInputToRequest(input);
    const response: FoodPairingResponse = await this.useCase.execute(
      request,
      requestId,
      {
        ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
      },
    );
    return { food: response.food, results: response.results };
  }
}

/**
 * Pure shape translation from runner-port camelCase to use case snake_case.
 *
 * The runner port intentionally omits the legacy USD `max_price` field
 * (analysis emits KRW directly), the sensory bounds `sweetness_target`,
 * `acidity_min`, `tannin_max`, and the `pairing` color value `both`. Those
 * remain reachable through the use case's direct entry point — the
 * adapter only forwards what the port carries.
 */
export function mapFoodPairingInputToRequest(
  input: FoodPairingUseCaseInput,
): FoodPairingRequest {
  return {
    food: input.food,
    ...(input.color !== undefined ? { color: input.color } : {}),
    ...(input.styles !== undefined && input.styles.length > 0
      ? { styles: [...input.styles] }
      : {}),
    ...(input.pairingTags !== undefined && input.pairingTags.length > 0
      ? { pairing_tags: [...input.pairingTags] }
      : {}),
    ...(input.maxPriceKrw !== undefined ? { max_price_krw: input.maxPriceKrw } : {}),
  };
}

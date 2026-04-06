import type { DrinkingWindowInput } from '../../../domain/drinking-window/port/drinking-window-predictor.port.js';
import type { DrinkingWindowBlock } from '../../../domain/response/model/result-item.js';

export interface DrinkingWindowCheckRequest extends DrinkingWindowInput {
  readonly targetYear: number;
}

export const DEFAULT_DRINKING_WINDOW_CRITIC_PROXY_SCORE = 80;

export interface DrinkingWindowUseCasePort {
  check(request: DrinkingWindowCheckRequest): Promise<DrinkingWindowBlock>;
}

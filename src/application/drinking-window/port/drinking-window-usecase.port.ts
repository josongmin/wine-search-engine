import type { DrinkingWindowBlock } from '../../../domain/response/model/result-item.js';

export interface DrinkingWindowUseCasePort {
  check(request: {
    readonly vintage: number;
    readonly grapePrimaryEnc: number;
    readonly regionEnc: number;
    readonly countryEnc: number;
    readonly body: number;
    readonly tannin: number;
    readonly acidity: number;
    readonly sweetness: number;
    readonly avgCriticProxyScore: number;
    readonly targetYear?: number;
  }): Promise<DrinkingWindowBlock>;
}

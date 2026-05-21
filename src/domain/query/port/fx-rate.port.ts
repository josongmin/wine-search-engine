/**
 * Port for foreign-exchange rate lookups used by the natural-language
 * constraint extractor.
 *
 * Why a port (Cockburn 2005 — hexagonal architecture):
 *   The extractor must convert foreign-currency price phrases ("$100 이하",
 *   "€50") into KRW for downstream Vespa filters. The historical implementation
 *   hardcoded the KRW↔USD rate (1350) into module-level constants, making it
 *   impossible to A/B-test rate sensitivity, swap to a live FX feed, or run
 *   property-based tests against rate-independent invariants.
 *
 * Contract:
 *   - All implementations MUST return positive, finite numbers.
 *   - All implementations MUST be synchronous — the extractor is a pure,
 *     deterministic function used inside hot paths (no I/O, no awaiting).
 *   - Implementations that need a remote rate must cache it in memory and
 *     refresh out-of-band.
 *
 * Default fallback: {@link DEFAULT_FX_RATE_PORT} returns the static
 * approximations from `domain/shared/constants.ts`, preserving existing
 * extractor behavior when no port is injected.
 *
 * @module fx-rate.port
 */
import {
  KRW_PER_USD_APPROXIMATE,
  KRW_PER_EUR_APPROXIMATE,
  KRW_PER_GBP_APPROXIMATE,
} from '../../shared/constants.js';

/**
 * Supported currency codes for FX lookup.
 *
 * Limited to USD/EUR/GBP because those are the only foreign currency symbols
 * the extractor's lexical layer recognizes ($/€/£). Adding a currency requires
 * (a) a new symbol in `extractForeignCurrencyPrice` and (b) a new arm here.
 */
export type SupportedFxCurrency = 'USD' | 'EUR' | 'GBP';

/**
 * Port interface for resolving "KRW per 1 unit of foreign currency".
 *
 * Implementations must return strictly positive, finite numbers. Returning
 * 0, negative values, NaN, or Infinity is a contract violation and the
 * extractor will reject the conversion (no constraint extracted).
 */
export interface FxRatePort {
  /**
   * Returns the current KRW value of 1 unit of the given currency.
   * Example: getKrwPerUnit('USD') → 1350 means 1 USD = 1350 KRW.
   *
   * Convenience accessor: getKrwUsdRate() === getKrwPerUnit('USD').
   */
  getKrwPerUnit(currency: SupportedFxCurrency): number;

  /** Shorthand for {@link getKrwPerUnit}('USD'). */
  getKrwUsdRate(): number;
}

/**
 * Default static FX rate port. Returns the same approximate mid-2025 rates
 * used by every other extractor in the repo (see
 * `KRW_PER_USD_APPROXIMATE` and friends in `domain/shared/constants.ts`).
 *
 * This default is the unique fallback for the extractor and is exported so
 * callers in tests can verify rate-injection paths against a known baseline.
 */
export const DEFAULT_FX_RATE_PORT: FxRatePort = {
  getKrwPerUnit(currency: SupportedFxCurrency): number {
    switch (currency) {
      case 'USD':
        return KRW_PER_USD_APPROXIMATE;
      case 'EUR':
        return KRW_PER_EUR_APPROXIMATE;
      case 'GBP':
        return KRW_PER_GBP_APPROXIMATE;
    }
  },
  getKrwUsdRate(): number {
    return KRW_PER_USD_APPROXIMATE;
  },
};

/**
 * Type guard: validates that a port returns finite, positive numbers for
 * every supported currency. Used at injection boundaries.
 */
export function isValidFxRate(rate: number): boolean {
  return Number.isFinite(rate) && rate > 0;
}

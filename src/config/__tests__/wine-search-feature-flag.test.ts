import { describe, expect, it } from 'vitest';
import {
  WINE_SEARCH_FEATURE_FLAG_ENV,
  isWineSearchEnabled,
} from '../wine-search-feature-flag.js';

/**
 * Behaviour spec for `isWineSearchEnabled`.
 *
 * The flag drives whether `Container.wineSearch` is constructed at composition
 * root time. Any drift in the parse semantics (e.g. `'TRUE'` accidentally
 * matching, empty string evaluating truthy) would silently flip the new
 * `/v1/wine-search` route on in a half-configured environment, so this is a
 * load-bearing contract test.
 */
describe('isWineSearchEnabled', () => {
  it('exposes the canonical env-var name as a const', () => {
    expect(WINE_SEARCH_FEATURE_FLAG_ENV).toBe('WINE_SEARCH_ENABLED');
  });

  it('returns true when WINE_SEARCH_ENABLED=true (exact lowercase)', () => {
    expect(isWineSearchEnabled({ WINE_SEARCH_ENABLED: 'true' })).toBe(true);
  });

  it('returns false when WINE_SEARCH_ENABLED is unset', () => {
    expect(isWineSearchEnabled({})).toBe(false);
  });

  it('returns false when WINE_SEARCH_ENABLED is empty string', () => {
    expect(isWineSearchEnabled({ WINE_SEARCH_ENABLED: '' })).toBe(false);
  });

  it('returns false when WINE_SEARCH_ENABLED=false explicitly', () => {
    expect(isWineSearchEnabled({ WINE_SEARCH_ENABLED: 'false' })).toBe(false);
  });

  // Case-sensitive parse — matches the `z.enum(['true','false'])` semantics
  // across the rest of the env layer. `'TRUE'` MUST NOT silently enable the
  // route (a misconfigured deploy script that uppercases env values
  // would otherwise opt into the new surface unintentionally).
  it('is case-sensitive: TRUE does not enable', () => {
    expect(isWineSearchEnabled({ WINE_SEARCH_ENABLED: 'TRUE' })).toBe(false);
  });

  it('does not accept "1" as truthy', () => {
    expect(isWineSearchEnabled({ WINE_SEARCH_ENABLED: '1' })).toBe(false);
  });

  it('does not accept "yes" as truthy', () => {
    expect(isWineSearchEnabled({ WINE_SEARCH_ENABLED: 'yes' })).toBe(false);
  });
});

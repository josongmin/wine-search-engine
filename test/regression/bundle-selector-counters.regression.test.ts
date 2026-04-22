import { beforeEach, describe, expect, it } from 'vitest';
import { globalBundleSelectorCounter } from '../../src/observability/bundle-selector-counters.js';

describe('bundle-selector counters', () => {
  beforeEach(() => {
    globalBundleSelectorCounter.reset();
  });

  it('tracks group_obligation_unsatisfied fail-closed reasons', () => {
    globalBundleSelectorCounter.incrementReason(
      'bundle_selector_fail_closed:group_obligation_unsatisfied',
    );

    expect(
      globalBundleSelectorCounter.snapshot()
        .BUNDLE_SELECTOR_GROUP_OBLIGATION_UNSATISFIED_COUNT,
    ).toBe(1);
  });
});

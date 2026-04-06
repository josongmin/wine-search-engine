import { describe, it, expect } from 'vitest';
import {
  snapshotVersionContractsMatch,
  type SnapshotVersionContract,
} from '../snapshot-version-contract.js';

const BASE_SHARED = {
  plannerVersion: 'pl1',
  policyRuleVersion: 'pr1',
  thresholdProfileId: 'tp1',
};

function v1(overrides?: Partial<typeof BASE_SHARED>): SnapshotVersionContract {
  return { version: 'v1', contract: { ...BASE_SHARED, ...overrides } };
}

function v2(
  overrides?: Partial<typeof BASE_SHARED> & {
    executionRoute?: string;
    retrievalMode?: string;
  },
): SnapshotVersionContract {
  return {
    version: 'v2',
    contract: {
      ...BASE_SHARED,
      executionRoute: 'hybrid',
      retrievalMode: 'entity_lookup',
      ...overrides,
    },
  };
}

describe('snapshotVersionContractsMatch', () => {
  describe('v1 vs v1', () => {
    it('returns true when all fields match', () => {
      expect(snapshotVersionContractsMatch(v1(), v1())).toBe(true);
    });

    it('returns false when plannerVersion differs', () => {
      expect(snapshotVersionContractsMatch(v1(), v1({ plannerVersion: 'pl2' }))).toBe(false);
    });

    it('returns false when policyRuleVersion differs', () => {
      expect(snapshotVersionContractsMatch(v1(), v1({ policyRuleVersion: 'pr2' }))).toBe(false);
    });

    it('returns false when thresholdProfileId differs', () => {
      expect(snapshotVersionContractsMatch(v1(), v1({ thresholdProfileId: 'tp2' }))).toBe(false);
    });
  });

  describe('v2 vs v2', () => {
    it('returns true when all five fields match', () => {
      expect(snapshotVersionContractsMatch(v2(), v2())).toBe(true);
    });

    it('returns false when retrievalMode differs', () => {
      expect(
        snapshotVersionContractsMatch(v2(), v2({ retrievalMode: 'semantic_search' })),
      ).toBe(false);
    });

    it('returns false when executionRoute differs', () => {
      expect(
        snapshotVersionContractsMatch(v2(), v2({ executionRoute: 'exact' })),
      ).toBe(false);
    });

    it('returns false when a shared field differs', () => {
      expect(snapshotVersionContractsMatch(v2(), v2({ plannerVersion: 'pl2' }))).toBe(false);
    });
  });

  describe('v1 vs v2 (migration compatibility)', () => {
    it('returns true when shared fields match', () => {
      expect(snapshotVersionContractsMatch(v1(), v2())).toBe(true);
    });

    it('returns true when compared in reverse order (v2 vs v1)', () => {
      expect(snapshotVersionContractsMatch(v2(), v1())).toBe(true);
    });

    it('returns false when shared fields differ', () => {
      expect(snapshotVersionContractsMatch(v1(), v2({ plannerVersion: 'pl2' }))).toBe(false);
    });

    it('ignores v2-only fields that differ — shared fields match is sufficient', () => {
      // The v1 snapshot has no executionRoute / retrievalMode concept, so
      // differences in those v2-only fields should not cause a mismatch.
      const a = v1();
      const b = v2({ executionRoute: 'exact', retrievalMode: 'semantic_search' });
      expect(snapshotVersionContractsMatch(a, b)).toBe(true);
    });
  });
});

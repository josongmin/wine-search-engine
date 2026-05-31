import { describe, it, expect } from 'vitest';
import { normalizeVerdict } from '../claim-verifier-semantic.js';

describe('normalizeVerdict', () => {
  describe('negated conflict phrasing must NOT become contradicted (bug repro)', () => {
    it.each([
      'no conflict',
      'no conflicting evidence',
      'No Conflicting Evidence',
      'not contradicted',
      'not contradicted by the evidence',
      'no contradiction found',
      'without conflict',
      'never contradicts the evidence',
    ])('%s → not_entailed (no contradiction asserted)', (raw) => {
      expect(normalizeVerdict(raw)).toBe('not_entailed');
    });
  });

  describe('genuine contradiction still maps to contradicted', () => {
    it.each([
      'contradicted',
      'CONTRADICTED',
      'conflict',
      'this claim conflicts with the evidence',
      'the evidence contradicts the claim',
      'false',
      'no',
    ])('%s → contradicted', (raw) => {
      expect(normalizeVerdict(raw)).toBe('contradicted');
    });
  });

  describe('positive verdicts', () => {
    it.each([
      ['entailed', 'entailed'],
      ['supported', 'entailed'],
      ['true', 'entailed'],
      ['yes', 'entailed'],
      ['support', 'entailed'],
      ['partially_entailed', 'partially_entailed'],
      ['partial match', 'partially_entailed'],
    ] as const)('%s → %s', (raw, expected) => {
      expect(normalizeVerdict(raw)).toBe(expected);
    });
  });

  describe('unknown / empty input falls through to not_entailed', () => {
    it.each(['', '   ', 'maybe', 'unknown', 'undetermined'])('%s → not_entailed', (raw) => {
      expect(normalizeVerdict(raw)).toBe('not_entailed');
    });
  });
});

/**
 * SCAN4-16: createAlias() MIN_ALIAS_LENGTH guard regression tests.
 *
 * Single-char aliases produce massive false positives in alias matching
 * (e.g. "A" matches any query containing "A"). The factory must reject them
 * at the domain boundary so they never reach the DB.
 */
import { describe, it, expect } from 'vitest';
import { createAlias } from '../alias.js';
import { MIN_ALIAS_LENGTH } from '../../service/alias-filter.js';
import { DomainError } from '../../../shared/error/domain-error.js';
import { createEntityId } from '../../../shared/types/index.js';

const BASE_PARAMS = {
  entityId: createEntityId('entity-001'),
  type: 'canonical' as const,
  confidencePrior: 0.9,
  source: 'test',
  scope: 'global' as const,
};

function expectInvariantViolation(fn: () => unknown): void {
  let thrown: unknown;
  try { fn(); } catch (e) { thrown = e; }
  expect(thrown).toBeInstanceOf(DomainError);
  expect((thrown as DomainError).code).toBe('INVARIANT_VIOLATION');
}

describe('createAlias — MIN_ALIAS_LENGTH guard (SCAN4-16)', () => {
  it('accepts alias exactly at MIN_ALIAS_LENGTH (boundary — just inside)', () => {
    const value = 'AB'; // length === 2 === MIN_ALIAS_LENGTH
    expect(() => createAlias({ ...BASE_PARAMS, value })).not.toThrow();
  });

  it('accepts alias longer than MIN_ALIAS_LENGTH', () => {
    expect(() => createAlias({ ...BASE_PARAMS, value: 'Bordeaux' })).not.toThrow();
  });

  it('accepts 2-char Korean alias (shortest meaningful syllable combo)', () => {
    // "로제" = rosé in Korean — valid 2-char alias
    expect(() => createAlias({ ...BASE_PARAMS, value: '로제' })).not.toThrow();
  });

  it('rejects single ASCII char (below MIN_ALIAS_LENGTH)', () => {
    expectInvariantViolation(() => createAlias({ ...BASE_PARAMS, value: 'A' }));
  });

  it('rejects single Korean syllable (ambiguous particle, below MIN_ALIAS_LENGTH)', () => {
    // "의" is a Korean possessive particle — single syllable, must not be an alias
    expectInvariantViolation(() => createAlias({ ...BASE_PARAMS, value: '의' }));
  });

  it('rejects whitespace-only alias (trimmed length = 0 < MIN_ALIAS_LENGTH)', () => {
    expectInvariantViolation(() => createAlias({ ...BASE_PARAMS, value: ' ' }));
  });

  it('rejects alias of length 1 with leading whitespace (trimmed to 1 char)', () => {
    expectInvariantViolation(() => createAlias({ ...BASE_PARAMS, value: ' X' }));
  });

  it(`MIN_ALIAS_LENGTH is ${String(MIN_ALIAS_LENGTH)} per SSoT module`, () => {
    // Parity check: factory and SSoT constant must agree
    expect(MIN_ALIAS_LENGTH).toBe(2);
  });
});

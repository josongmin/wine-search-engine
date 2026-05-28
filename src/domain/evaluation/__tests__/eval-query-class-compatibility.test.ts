import { describe, expect, it } from 'vitest';
import { isGoldRuntimeQueryClassMismatch } from '../service/eval-query-class-compatibility.js';

describe('eval-query-class-compatibility', () => {
  it('treats exact_entity -> short_entity as compatible', () => {
    expect(isGoldRuntimeQueryClassMismatch('exact_entity', 'short_entity')).toBe(false);
  });

  it('treats external corpus-only labels as non-assertive', () => {
    expect(isGoldRuntimeQueryClassMismatch('noisy_recall', 'short_entity')).toBe(false);
    expect(isGoldRuntimeQueryClassMismatch('exploration', 'semantic_preference')).toBe(false);
  });

  it('fails incompatible runtime refinements', () => {
    expect(isGoldRuntimeQueryClassMismatch('pure_constraint', 'semantic_preference')).toBe(true);
  });
});

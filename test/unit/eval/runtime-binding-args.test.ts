import { describe, expect, it } from 'vitest';
import {
  EXPLICIT_RUNTIME_BINDING_ERROR,
  requireExplicitEvalRuntimeBinding,
  resolveEvalRuntimeBinding,
} from '../../../scripts/eval/runtime-binding-args.js';

describe('eval runtime binding args', () => {
  it('accepts kebab-case runtime binding flags', () => {
    const binding = resolveEvalRuntimeBinding({
      'runtime-state': '/tmp/runtime-state.json',
      'use-active-runtime': false,
    });

    expect(binding).toEqual({
      runtimeStatePath: '/tmp/runtime-state.json',
      useActiveRuntime: false,
    });
  });

  it('accepts camelCase runtime binding flags', () => {
    const binding = resolveEvalRuntimeBinding({
      runtimeState: '/tmp/runtime-state.json',
      useActiveRuntime: true,
    });

    expect(binding).toEqual({
      runtimeStatePath: '/tmp/runtime-state.json',
      useActiveRuntime: true,
    });
  });

  it('fails closed when neither runtime-state nor use-active-runtime is present', () => {
    expect(() =>
      requireExplicitEvalRuntimeBinding({
        runtimeStatePath: undefined,
        useActiveRuntime: false,
      }),
    ).toThrow(EXPLICIT_RUNTIME_BINDING_ERROR);
  });
});

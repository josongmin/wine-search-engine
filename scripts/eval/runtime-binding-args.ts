export const EXPLICIT_RUNTIME_BINDING_ERROR =
  'Explicit runtime binding required: pass --runtime-state <path> or --use-active-runtime';

export const EVAL_RUNTIME_BINDING_OPTIONS = {
  runtimeState: { type: 'string' as const },
  'runtime-state': { type: 'string' as const },
  useActiveRuntime: { type: 'boolean' as const, default: false },
  'use-active-runtime': { type: 'boolean' as const, default: false },
} as const;

export interface EvalRuntimeBindingOptionValues {
  readonly runtimeState?: string | undefined;
  readonly 'runtime-state'?: string | undefined;
  readonly useActiveRuntime?: boolean | undefined;
  readonly 'use-active-runtime'?: boolean | undefined;
}

export interface EvalRuntimeBinding {
  readonly runtimeStatePath?: string | undefined;
  readonly useActiveRuntime: boolean;
}

export function resolveEvalRuntimeBinding(
  values: EvalRuntimeBindingOptionValues,
): EvalRuntimeBinding {
  return {
    runtimeStatePath: values['runtime-state'] ?? values.runtimeState,
    useActiveRuntime: (values['use-active-runtime'] ?? values.useActiveRuntime) === true,
  };
}

export function requireExplicitEvalRuntimeBinding(binding: EvalRuntimeBinding): string {
  if (binding.runtimeStatePath === undefined && !binding.useActiveRuntime) {
    throw new Error(EXPLICIT_RUNTIME_BINDING_ERROR);
  }
  return binding.runtimeStatePath ?? '';
}

type RetrievalBranchObligation = 'required' | 'optional';

interface RetrievalBranchSpec<TKey extends string, TResult> {
  readonly key: TKey;
  readonly obligation: RetrievalBranchObligation;
  readonly execute: () => Promise<TResult>;
}

interface RetrievalBranchSuccess<TKey extends string, TResult> {
  readonly key: TKey;
  readonly obligation: RetrievalBranchObligation;
  readonly result: TResult;
}

interface RetrievalBranchFailure<TKey extends string> {
  readonly key: TKey;
  readonly obligation: RetrievalBranchObligation;
  readonly error: unknown;
  readonly errorMessage: string;
}

type RetrievalBranchExecutionResult<TKey extends string, TResult> =
  | {
      readonly status: 'ok';
      readonly successes: readonly RetrievalBranchSuccess<TKey, TResult>[];
      readonly optionalFailures: readonly RetrievalBranchFailure<TKey>[];
    }
  | {
      readonly status: 'fail_closed';
      readonly successes: readonly RetrievalBranchSuccess<TKey, TResult>[];
      readonly optionalFailures: readonly RetrievalBranchFailure<TKey>[];
      readonly requiredFailures: readonly RetrievalBranchFailure<TKey>[];
    };

export async function executeRetrievalBranches<TKey extends string, TResult>(
  specs: readonly RetrievalBranchSpec<TKey, TResult>[],
): Promise<RetrievalBranchExecutionResult<TKey, TResult>> {
  const settled = await Promise.allSettled(specs.map((spec) => spec.execute()));
  const successes: RetrievalBranchSuccess<TKey, TResult>[] = [];
  const optionalFailures: RetrievalBranchFailure<TKey>[] = [];
  const requiredFailures: RetrievalBranchFailure<TKey>[] = [];

  for (let index = 0; index < settled.length; index += 1) {
    const spec = specs[index];
    const outcome = settled[index];
    if (spec === undefined || outcome === undefined) continue;
    if (outcome.status === 'fulfilled') {
      successes.push({
        key: spec.key,
        obligation: spec.obligation,
        result: outcome.value,
      });
      continue;
    }
    const failure: RetrievalBranchFailure<TKey> = {
      key: spec.key,
      obligation: spec.obligation,
      error: outcome.reason,
      errorMessage: formatBranchErrorMessage(outcome.reason),
    };
    if (spec.obligation === 'required') {
      requiredFailures.push(failure);
    } else {
      optionalFailures.push(failure);
    }
  }

  if (requiredFailures.length > 0) {
    return {
      status: 'fail_closed',
      successes,
      optionalFailures,
      requiredFailures,
    };
  }

  return {
    status: 'ok',
    successes,
    optionalFailures,
  };
}

export function formatRetrievalBranchFailureReasons<TKey extends string>(
  scope: string,
  failures: readonly RetrievalBranchFailure<TKey>[],
  mode: 'degraded' | 'fail_closed',
): readonly string[] {
  return failures.map((failure) => `retrieval_branch_${mode}:${scope}:${failure.key}`);
}

function formatBranchErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

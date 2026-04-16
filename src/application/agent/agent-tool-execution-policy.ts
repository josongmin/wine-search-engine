import type { AgentExecutionState } from './agent-execution-state.js';
import type { AgentQueryExecutionContract } from './agent-query-execution-contract.js';
import {
  isExactMetadataEntityLookupCandidate,
  normalizeExactMetadataSearchInput,
} from './agent-query-execution-contract.js';

function shouldInjectRefinementHint(observation: string): boolean {
  return observation.includes('0개') || observation.includes('검색 결과가 없습니다') || observation.startsWith('NO_MATCH:');
}

interface ResolveSingleToolInput {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly queryExecutionContract: AgentQueryExecutionContract;
}

interface ResolveParallelBatchInput {
  readonly calls: readonly {
    readonly tool: string;
    readonly input: Record<string, unknown>;
  }[];
  readonly queryExecutionContract: AgentQueryExecutionContract;
}

function normalizeSearchInput(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): Record<string, unknown> {
  if (!queryExecutionContract.hasEntityMetadataSignal) {
    return input;
  }
  const searchQuery = input['query'];
  if (typeof searchQuery !== 'string' || !isExactMetadataEntityLookupCandidate(searchQuery)) {
    return input;
  }
  const normalized = normalizeExactMetadataSearchInput(input).effectiveInput;
  return normalized['limit'] === 1
    ? normalized
    : { ...normalized, limit: 1 };
}

export class AgentToolExecutionPolicy {
  resolveSingleTool(input: ResolveSingleToolInput): Record<string, unknown> {
    if (input.tool !== 'search_wines') {
      return input.input;
    }
    return normalizeSearchInput(input.input, input.queryExecutionContract);
  }

  resolveParallelBatch(input: ResolveParallelBatchInput): readonly {
    readonly tool: string;
    readonly input: Record<string, unknown>;
  }[] {
    return input.calls.map((call) => (
      call.tool === 'search_wines'
        ? { ...call, input: normalizeSearchInput(call.input, input.queryExecutionContract) }
        : call
    ));
  }

  maybeInjectRefinementHint(
    state: AgentExecutionState,
    observations: readonly string[],
    remainingSteps: number,
  ): void {
    if (
      state.hasInjectedRefinementHint ||
      remainingSteps < 3 ||
      !observations.some((observation) => shouldInjectRefinementHint(observation))
    ) {
      return;
    }
    state.hasInjectedRefinementHint = true;
    state.pendingPlannerDirective = { kind: 'relax_constraints_retry' };
  }
}

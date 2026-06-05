export const RUNTIME_SUBSTRATE_PUBLISH_PHASES = [
  'artifact_validate',
  'pg_stage',
  'graph_sync',
  'pg_verify',
  'runtime_state_stage',
  'promote',
  'post_promote_verify',
] as const;

export type RuntimeSubstratePublishPhase = typeof RUNTIME_SUBSTRATE_PUBLISH_PHASES[number];

function getRuntimeSubstratePublishPhaseIndex(
  phase: RuntimeSubstratePublishPhase,
): number {
  return RUNTIME_SUBSTRATE_PUBLISH_PHASES.indexOf(phase);
}

function advanceRuntimeSubstratePublishPhase(
  current: RuntimeSubstratePublishPhase,
  next: RuntimeSubstratePublishPhase,
): RuntimeSubstratePublishPhase {
  const currentIndex = getRuntimeSubstratePublishPhaseIndex(current);
  const nextIndex = getRuntimeSubstratePublishPhaseIndex(next);
  if (nextIndex !== currentIndex + 1) {
    throw new Error(`Illegal runtime substrate publish phase transition: ${current} -> ${next}`);
  }
  return next;
}

export interface RuntimeSubstratePublishStateMachine {
  readonly current: RuntimeSubstratePublishPhase;
  advance(next: RuntimeSubstratePublishPhase): RuntimeSubstratePublishPhase;
}

export function createRuntimeSubstratePublishStateMachine(
  initial: RuntimeSubstratePublishPhase = 'artifact_validate',
): RuntimeSubstratePublishStateMachine {
  let current = initial;
  return {
    get current(): RuntimeSubstratePublishPhase {
      return current;
    },
    advance(next: RuntimeSubstratePublishPhase): RuntimeSubstratePublishPhase {
      current = advanceRuntimeSubstratePublishPhase(current, next);
      return current;
    },
  };
}

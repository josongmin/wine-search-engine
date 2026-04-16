export const SNAPSHOT_PUBLISH_PHASES = [
  'built',
  'vespa_indexed',
  'runtime_substrates_published',
  'pointer_promoted',
  'runtime_artifacts_promoted',
] as const;

export type SnapshotPublishPhase = typeof SNAPSHOT_PUBLISH_PHASES[number];

function getSnapshotPublishPhaseIndex(phase: SnapshotPublishPhase): number {
  return SNAPSHOT_PUBLISH_PHASES.indexOf(phase);
}

export function hasSnapshotPublishReachedPhase(
  current: SnapshotPublishPhase,
  boundary: SnapshotPublishPhase,
): boolean {
  return getSnapshotPublishPhaseIndex(current) >= getSnapshotPublishPhaseIndex(boundary);
}

function advanceSnapshotPublishPhase(
  current: SnapshotPublishPhase,
  next: SnapshotPublishPhase,
): SnapshotPublishPhase {
  const currentIndex = getSnapshotPublishPhaseIndex(current);
  const nextIndex = getSnapshotPublishPhaseIndex(next);
  if (nextIndex !== currentIndex + 1) {
    throw new Error(`Illegal search snapshot publish phase transition: ${current} -> ${next}`);
  }
  return next;
}

export interface SnapshotPublishStateMachine {
  readonly current: SnapshotPublishPhase;
  advance(next: SnapshotPublishPhase): SnapshotPublishPhase;
  hasReached(boundary: SnapshotPublishPhase): boolean;
}

export function createSnapshotPublishStateMachine(
  initial: SnapshotPublishPhase = 'built',
): SnapshotPublishStateMachine {
  let current = initial;
  return {
    get current(): SnapshotPublishPhase {
      return current;
    },
    advance(next: SnapshotPublishPhase): SnapshotPublishPhase {
      current = advanceSnapshotPublishPhase(current, next);
      return current;
    },
    hasReached(boundary: SnapshotPublishPhase): boolean {
      return hasSnapshotPublishReachedPhase(current, boundary);
    },
  };
}

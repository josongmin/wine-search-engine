import { describe, expect, it } from 'vitest';
import { createRuntimeSubstratePublishStateMachine } from '../../../scripts/etl/runtime-substrate-publish-state-machine.js';

describe('runtime substrate publish state machine', () => {
  it('advances only in declared phase order', () => {
    const machine = createRuntimeSubstratePublishStateMachine();
    expect(machine.current).toBe('artifact_validate');
    expect(machine.advance('pg_stage')).toBe('pg_stage');
    expect(machine.advance('graph_sync')).toBe('graph_sync');
    expect(machine.advance('pg_verify')).toBe('pg_verify');
    expect(machine.advance('runtime_state_stage')).toBe('runtime_state_stage');
    expect(machine.advance('promote')).toBe('promote');
    expect(machine.advance('post_promote_verify')).toBe('post_promote_verify');
  });

  it('fails closed on illegal phase transitions', () => {
    const machine = createRuntimeSubstratePublishStateMachine();
    expect(() => machine.advance('runtime_state_stage')).toThrow(/Illegal runtime substrate publish phase transition/);
  });
});

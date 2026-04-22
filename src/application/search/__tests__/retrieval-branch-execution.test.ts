import { describe, expect, it } from 'vitest';
import {
  executeRetrievalBranches,
  formatRetrievalBranchFailureReasons,
} from '../retrieval-branch-execution.js';

describe('executeRetrievalBranches', () => {
  it('fail-closes when a required branch rejects', async () => {
    const result = await executeRetrievalBranches([
      {
        key: 'red',
        obligation: 'required',
        execute: async () => 'red-ok',
      },
      {
        key: 'white',
        obligation: 'required',
        execute: async () => {
          throw new Error('GOAWAY');
        },
      },
    ]);

    expect(result.status).toBe('fail_closed');
    if (result.status !== 'fail_closed') {
      throw new Error('expected fail_closed');
    }
    expect(result.successes).toEqual([
      { key: 'red', obligation: 'required', result: 'red-ok' },
    ]);
    expect(result.requiredFailures).toEqual([
      expect.objectContaining({
        key: 'white',
        obligation: 'required',
        errorMessage: 'GOAWAY',
      }),
    ]);
  });

  it('keeps optional branch failures as degraded partial success', async () => {
    const result = await executeRetrievalBranches([
      {
        key: 'red',
        obligation: 'required',
        execute: async () => 'red-ok',
      },
      {
        key: 'sparkling',
        obligation: 'optional',
        execute: async () => {
          throw new Error('timeout');
        },
      },
    ]);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('expected ok');
    }
    expect(result.successes).toEqual([
      { key: 'red', obligation: 'required', result: 'red-ok' },
    ]);
    expect(result.optionalFailures).toEqual([
      expect.objectContaining({
        key: 'sparkling',
        obligation: 'optional',
        errorMessage: 'timeout',
      }),
    ]);
    expect(
      formatRetrievalBranchFailureReasons(
        'typed_recommendation',
        result.optionalFailures,
        'degraded',
      ),
    ).toEqual(['retrieval_branch_degraded:typed_recommendation:sparkling']);
  });
});

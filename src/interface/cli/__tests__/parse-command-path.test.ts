import { describe, expect, it } from 'vitest';
import { parseCommandPath } from '../argv/parse-command-path.js';

describe('parseCommandPath', () => {
  it('splits group, name and leaf args', () => {
    expect(parseCommandPath(['system', 'ping'])).toEqual({
      group: 'system',
      name: 'ping',
      leafArgs: [],
    });
    expect(parseCommandPath(['system', 'ping', '--note', 'hi'])).toEqual({
      group: 'system',
      name: 'ping',
      leafArgs: ['--note', 'hi'],
    });
  });

  it('returns null when no tokens are present', () => {
    expect(parseCommandPath([])).toBeNull();
  });

  it('returns null when a group has no leaf command name', () => {
    expect(parseCommandPath(['auth'])).toBeNull();
  });
});

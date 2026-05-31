import { describe, expect, it } from 'vitest';
import { hasCommandPathPrefix, parseCommandPath } from '../argv/parse-command-path.js';

const COMMAND_PATHS = [
  ['system', 'ping'],
  ['auth', 'status'],
  ['agent', 'session', 'turn'],
] as const;

describe('parseCommandPath', () => {
  it('resolves the longest matching command path and leaf args', () => {
    expect(parseCommandPath(['system', 'ping'], COMMAND_PATHS)).toEqual({
      path: ['system', 'ping'],
      leafArgs: [],
    });
    expect(parseCommandPath(['system', 'ping', '--note', 'hi'], COMMAND_PATHS)).toEqual({
      path: ['system', 'ping'],
      leafArgs: ['--note', 'hi'],
    });
    expect(parseCommandPath(['agent', 'session', 'turn', '--q', 'hi'], COMMAND_PATHS)).toEqual({
      path: ['agent', 'session', 'turn'],
      leafArgs: ['--q', 'hi'],
    });
  });

  it('returns null when no tokens are present', () => {
    expect(parseCommandPath([], COMMAND_PATHS)).toBeNull();
  });

  it('returns null when no registered command matches', () => {
    expect(parseCommandPath(['auth'], COMMAND_PATHS)).toBeNull();
    expect(parseCommandPath(['agent', 'session'], COMMAND_PATHS)).toBeNull();
  });

  it('detects incomplete prefixes separately from unknown paths', () => {
    expect(hasCommandPathPrefix(['agent', 'session'], COMMAND_PATHS)).toBe(true);
    expect(hasCommandPathPrefix(['auth'], COMMAND_PATHS)).toBe(true);
    expect(hasCommandPathPrefix(['nope'], COMMAND_PATHS)).toBe(false);
  });
});

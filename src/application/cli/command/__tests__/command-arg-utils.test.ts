import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../../context/command-context.js';
import { CliError } from '../cli-error.js';
import {
  expectFlagValue,
  parseHeaderAssignment,
  parsePositiveInteger,
  resolveBodySpec,
  resolveJsonOverlay,
} from '../command-arg-utils.js';

function fakeCtx(
  overrides: { readTextFile?: (path: string) => Promise<string>; cwd?: string } = {},
): CommandContext {
  return {
    cwd: overrides.cwd ?? '/work',
    readTextFile: overrides.readTextFile ?? (async () => ''),
  } as unknown as CommandContext;
}

describe('expectFlagValue', () => {
  it('returns the next arg when present', () => {
    expect(expectFlagValue(['--header', 'x-a=1'], 0, '--header')).toBe('x-a=1');
  });

  it('throws CliError(usage) naming the flag when value missing', () => {
    try {
      expectFlagValue(['--header'], 0, '--header');
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).kind).toBe('usage');
      expect((error as CliError).message).toContain('--header');
    }
  });
});

describe('parsePositiveInteger', () => {
  it('parses a positive integer string', () => {
    expect(parsePositiveInteger('5', '--limit')).toBe(5);
  });

  it.each([['0'], ['-1'], ['abc'], ['1.5']])('rejects %s', (value) => {
    try {
      parsePositiveInteger(value, '--limit');
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).kind).toBe('usage');
      expect((error as CliError).message).toContain('--limit');
    }
  });
});

describe('parseHeaderAssignment', () => {
  it('splits at the first equals sign', () => {
    expect(parseHeaderAssignment('x-foo=bar', '--header')).toEqual({
      name: 'x-foo',
      value: 'bar',
    });
  });

  it('keeps everything after the first = as value', () => {
    expect(parseHeaderAssignment('a=b=c', '--header')).toEqual({
      name: 'a',
      value: 'b=c',
    });
  });

  it.each([['noequals'], ['=trailing'], ['leading=']])('rejects %s', (value) => {
    try {
      parseHeaderAssignment(value, '--header');
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).kind).toBe('usage');
    }
  });
});

describe('resolveBodySpec', () => {
  it('returns undefined when bodySpec is undefined', async () => {
    await expect(resolveBodySpec(fakeCtx(), undefined)).resolves.toBeUndefined();
  });

  it('returns literal body verbatim when no @ prefix', async () => {
    await expect(resolveBodySpec(fakeCtx(), '{"q":1}')).resolves.toBe('{"q":1}');
  });

  it('reads from file via ctx.readTextFile with resolved cwd path', async () => {
    const seen: string[] = [];
    const ctx = fakeCtx({
      cwd: '/work',
      readTextFile: async (path: string) => {
        seen.push(path);
        return '{"hello":"world"}';
      },
    });
    const result = await resolveBodySpec(ctx, '@req.json');
    expect(result).toBe('{"hello":"world"}');
    expect(seen).toEqual([resolve('/work', 'req.json')]);
  });

  it('throws CliError(usage) on bare @ with empty path', async () => {
    try {
      await resolveBodySpec(fakeCtx(), '@');
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).kind).toBe('usage');
      expect((error as CliError).message).toContain('expected @<path>');
    }
  });

  it('wraps readTextFile rejections in CliError(usage) with cause', async () => {
    const original = new Error('ENOENT');
    const ctx = fakeCtx({
      readTextFile: async () => {
        throw original;
      },
    });
    try {
      await resolveBodySpec(ctx, '@missing.json');
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).kind).toBe('usage');
      expect((error as CliError).cause).toBe(original);
    }
  });
});

describe('resolveJsonOverlay', () => {
  it('returns empty object when bodySpec is undefined', async () => {
    await expect(resolveJsonOverlay(fakeCtx(), undefined)).resolves.toEqual({});
  });

  it('parses a valid JSON object literal', async () => {
    await expect(resolveJsonOverlay(fakeCtx(), '{"q":"x","n":2}')).resolves.toEqual({
      q: 'x',
      n: 2,
    });
  });

  it('throws CliError(usage) on invalid JSON', async () => {
    try {
      await resolveJsonOverlay(fakeCtx(), '{not json}');
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).kind).toBe('usage');
      expect((error as CliError).message).toContain('Invalid JSON');
    }
  });

  it('throws when JSON is an array, not an object', async () => {
    try {
      await resolveJsonOverlay(fakeCtx(), '[1,2,3]');
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).kind).toBe('usage');
      expect((error as CliError).message).toContain('must be an object');
    }
  });

  it('throws when JSON is null', async () => {
    try {
      await resolveJsonOverlay(fakeCtx(), 'null');
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).kind).toBe('usage');
      expect((error as CliError).message).toContain('must be an object');
    }
  });
});

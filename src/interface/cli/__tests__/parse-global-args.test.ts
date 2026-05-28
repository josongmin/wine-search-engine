import { describe, expect, it } from 'vitest';
import { parseGlobalArgs } from '../argv/parse-global-args.js';
import { CliError } from '../../../application/cli/command/cli-error.js';
import { EXIT_USAGE } from '../../../application/cli/command/exit-code.js';

describe('parseGlobalArgs', () => {
  it('applies defaults for empty argv', () => {
    const { global, rest } = parseGlobalArgs([]);
    expect(global.help).toBe(false);
    expect(global.output).toBe('human');
    expect(global.timeoutMs).toBeNull();
    expect(global.verbose).toBe(false);
    expect(global.debug).toBe(false);
    expect(global.target).toBeUndefined();
    expect(rest).toEqual([]);
  });

  it('maps --json to output=json and --output overrides it (last wins)', () => {
    expect(parseGlobalArgs(['--json']).global.output).toBe('json');
    expect(parseGlobalArgs(['--json', '--output', 'yaml']).global.output).toBe('yaml');
    expect(parseGlobalArgs(['--output', 'yaml', '--json']).global.output).toBe('json');
  });

  it('parses target, profile, base-url, request-id and boolean flags', () => {
    const { global } = parseGlobalArgs([
      '--target', 'remote',
      '--profile', 'staging',
      '--base-url', 'https://api.example.com',
      '--auth-mode', 'bearer',
      '--bearer-token', 'tok',
      '--request-id', 'req-1',
      '--verbose',
      '--debug',
    ]);
    expect(global.target).toBe('remote');
    expect(global.profile).toBe('staging');
    expect(global.baseUrl).toBe('https://api.example.com');
    expect(global.authMode).toBe('bearer');
    expect(global.bearerToken).toBe('tok');
    expect(global.requestId).toBe('req-1');
    expect(global.verbose).toBe(true);
    expect(global.debug).toBe(true);
  });

  it('parses a positive --timeout-ms and rejects invalid values', () => {
    expect(parseGlobalArgs(['--timeout-ms', '5000']).global.timeoutMs).toBe(5000);
    for (const bad of ['abc', '0', '-1', 'NaN', 'Infinity']) {
      expect(() => parseGlobalArgs(['--timeout-ms', bad])).toThrow(CliError);
    }
  });

  it('rejects an invalid --target and --output with a usage error', () => {
    const targetErr = (() => {
      try {
        parseGlobalArgs(['--target', 'prod']);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(targetErr).toBeInstanceOf(CliError);
    expect((targetErr as CliError).exitCode).toBe(EXIT_USAGE);

    expect(() => parseGlobalArgs(['--output', 'bogus'])).toThrow(CliError);
  });

  it('throws when a value-taking flag is missing its value', () => {
    expect(() => parseGlobalArgs(['--profile'])).toThrow(CliError);
    expect(() => parseGlobalArgs(['--timeout-ms'])).toThrow(CliError);
  });

  it('leaves command path and unknown leaf flags in rest, in order', () => {
    const { global, rest } = parseGlobalArgs([
      '--json', 'search', 'run', '--q', 'opus one 2018', '--limit', '5',
    ]);
    expect(global.output).toBe('json');
    expect(rest).toEqual(['search', 'run', '--q', 'opus one 2018', '--limit', '5']);
  });

  it('recognizes a global flag that appears after the command', () => {
    const { global, rest } = parseGlobalArgs(['system', 'ping', '--target', 'remote']);
    expect(global.target).toBe('remote');
    expect(rest).toEqual(['system', 'ping']);
  });

  it('treats --help and -h as help', () => {
    expect(parseGlobalArgs(['--help']).global.help).toBe(true);
    expect(parseGlobalArgs(['-h']).global.help).toBe(true);
  });
});

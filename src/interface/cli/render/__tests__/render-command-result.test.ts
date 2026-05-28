import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import type { CommandResult } from '../../../../application/cli/context/command-result.js';
import type { CliIo } from '../../io.js';
import { renderCommandResult } from '../render-command-result.js';

function makeIo(): { io: CliIo; stdout: () => string; stderr: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      write: (chunk: string) => void out.push(chunk),
      writeError: (chunk: string) => void err.push(chunk),
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

function res(overrides: Partial<CommandResult> & { data: unknown }): CommandResult {
  return { ...overrides };
}

describe('renderCommandResult', () => {
  describe('human format', () => {
    it('writes plain string with trailing newline', () => {
      const cap = makeIo();
      renderCommandResult(res({ data: 'hello' }), 'human', cap.io);
      expect(cap.stdout()).toBe('hello\n');
      expect(cap.stderr()).toBe('');
    });

    it('renders objects as YAML (not JSON) ending with newline', () => {
      const cap = makeIo();
      renderCommandResult(res({ data: { key: 'value' } }), 'human', cap.io);
      const out = cap.stdout();
      expect(out.endsWith('\n')).toBe(true);
      expect(out).toMatch(/^[a-zA-Z]/);
      expect(out).toContain('key:');
      expect(out).toContain('value');
      // Confirm it is YAML, not JSON
      expect(out).not.toContain('{');
      expect(out).not.toContain('"key"');
    });

    it('renders empty array as YAML "[]\\n"', () => {
      const cap = makeIo();
      renderCommandResult(res({ data: [] }), 'human', cap.io);
      expect(cap.stdout()).toBe('[]\n');
    });
  });

  describe('json format', () => {
    it('renders nested objects with indent 2 and trailing newline', () => {
      const cap = makeIo();
      const data = { a: 1, b: [2, 3] };
      renderCommandResult(res({ data }), 'json', cap.io);
      expect(cap.stdout()).toBe(`${JSON.stringify(data, null, 2)}\n`);
    });

    it('renders empty object as "{}\\n"', () => {
      const cap = makeIo();
      renderCommandResult(res({ data: {} }), 'json', cap.io);
      expect(cap.stdout()).toBe('{}\n');
    });
  });

  describe('yaml format', () => {
    it('produces parseable YAML that roundtrips to the original object', () => {
      const cap = makeIo();
      const data = { name: 'Sassicaia', vintage: 2018, regions: ['Bolgheri', 'Tuscany'] };
      renderCommandResult(res({ data }), 'yaml', cap.io);
      const out = cap.stdout();
      expect(out.endsWith('\n')).toBe(true);
      expect(YAML.parse(out)).toEqual(data);
    });
  });

  describe('table format', () => {
    it('renders an array of flat records with header, divider and data rows', () => {
      const cap = makeIo();
      const data = [
        { a: 1, b: 'x' },
        { a: 2, b: 'y' },
      ];
      renderCommandResult(res({ data }), 'table', cap.io);
      const out = cap.stdout();
      const lines = out.split('\n');
      // First line: header listing column names
      expect(lines[0]).toContain('a');
      expect(lines[0]).toContain('b');
      // Second line: dash divider
      expect(lines[1]).toMatch(/^-+(\s+-+)*$/);
      // Subsequent lines: data rows
      expect(out).toContain('1');
      expect(out).toContain('2');
      expect(out).toContain('x');
      expect(out).toContain('y');
      expect(out.endsWith('\n')).toBe(true);
    });

    it('auto-wraps a single record into a one-row table', () => {
      const cap = makeIo();
      renderCommandResult(res({ data: { a: 1, b: 'x' } }), 'table', cap.io);
      const out = cap.stdout();
      const lines = out.split('\n').filter((line) => line.length > 0);
      // header + divider + one data row = 3 non-empty lines
      expect(lines.length).toBe(3);
      expect(lines[0]).toContain('a');
      expect(lines[0]).toContain('b');
      expect(lines[1]).toMatch(/^-+(\s+-+)*$/);
      expect(lines[2]).toContain('1');
      expect(lines[2]).toContain('x');
    });

    it('falls back to JSON when the array is empty', () => {
      const cap = makeIo();
      renderCommandResult(res({ data: [] }), 'table', cap.io);
      expect(cap.stdout()).toBe(`${JSON.stringify([], null, 2)}\n`);
    });

    it('falls back to JSON when a row contains a nested object', () => {
      const cap = makeIo();
      const data = [{ a: { nested: 1 } }];
      renderCommandResult(res({ data }), 'table', cap.io);
      expect(cap.stdout()).toBe(`${JSON.stringify(data, null, 2)}\n`);
    });
  });

  describe('raw format', () => {
    it('writes plain string with trailing newline', () => {
      const cap = makeIo();
      renderCommandResult(res({ data: 'hello' }), 'raw', cap.io);
      expect(cap.stdout()).toBe('hello\n');
    });

    it('JSON-stringifies non-string data with indent 2 plus newline', () => {
      const cap = makeIo();
      const data = { a: 1, b: [2, 3] };
      renderCommandResult(res({ data }), 'raw', cap.io);
      expect(cap.stdout()).toBe(`${JSON.stringify(data, null, 2)}\n`);
    });
  });

  describe('warnings', () => {
    it('emits each warning to stderr regardless of format', () => {
      const cap = makeIo();
      renderCommandResult(
        res({ data: { ok: true }, warnings: ['w1', 'w2'] }),
        'json',
        cap.io,
      );
      const err = cap.stderr();
      expect(err).toContain('warning: w1\n');
      expect(err).toContain('warning: w2\n');
      // stdout still receives the formatted body
      expect(cap.stdout()).toBe(`${JSON.stringify({ ok: true }, null, 2)}\n`);
    });

    it('emits warnings even when format is human and data is a string', () => {
      const cap = makeIo();
      renderCommandResult(
        res({ data: 'body', warnings: ['careful'] }),
        'human',
        cap.io,
      );
      expect(cap.stderr()).toBe('warning: careful\n');
      expect(cap.stdout()).toBe('body\n');
    });
  });

  describe('renderAs: raw-api', () => {
    const apiData = {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json', 'x-request-id': 'abc' },
      body: { result: 42 },
    };

    it('renders entire object as JSON for json format', () => {
      const cap = makeIo();
      const data = { ...apiData, rawText: '{"result":42}', showHeaders: true };
      renderCommandResult(res({ data, renderAs: 'raw-api' }), 'json', cap.io);
      expect(cap.stdout()).toBe(`${JSON.stringify(data, null, 2)}\n`);
    });

    it('renders entire object as YAML for yaml format', () => {
      const cap = makeIo();
      const data = { ...apiData, showHeaders: false };
      renderCommandResult(res({ data, renderAs: 'raw-api' }), 'yaml', cap.io);
      const out = cap.stdout();
      expect(out.endsWith('\n')).toBe(true);
      expect(YAML.parse(out)).toEqual(data);
    });

    it('renders the headers (not body) as a table for table format', () => {
      const cap = makeIo();
      renderCommandResult(
        res({ data: apiData, renderAs: 'raw-api' }),
        'table',
        cap.io,
      );
      const out = cap.stdout();
      // headers are a single record → one-row table
      expect(out).toContain('content-type');
      expect(out).toContain('application/json');
      expect(out).toContain('x-request-id');
      expect(out).toContain('abc');
      // body must NOT leak into the table
      expect(out).not.toContain('result');
      expect(out).not.toContain('42');
    });

    it('raw format prefers rawText when present', () => {
      const cap = makeIo();
      const data = { ...apiData, body: { result: 42 }, rawText: 'RAW-TEXT-PAYLOAD' };
      renderCommandResult(res({ data, renderAs: 'raw-api' }), 'raw', cap.io);
      expect(cap.stdout()).toBe('RAW-TEXT-PAYLOAD\n');
    });

    it('raw format uses string body when rawText is absent', () => {
      const cap = makeIo();
      const data = { ...apiData, body: 'plain-body-string' };
      renderCommandResult(res({ data, renderAs: 'raw-api' }), 'raw', cap.io);
      expect(cap.stdout()).toBe('plain-body-string\n');
    });

    it('raw format JSON-stringifies non-string body when rawText is absent', () => {
      const cap = makeIo();
      const body = { result: 42, nested: [1, 2] };
      const data = { ...apiData, body };
      renderCommandResult(res({ data, renderAs: 'raw-api' }), 'raw', cap.io);
      expect(cap.stdout()).toBe(`${JSON.stringify(body, null, 2)}\n`);
    });

    it('human format with showHeaders=false emits status line then body, no headers section', () => {
      const cap = makeIo();
      const data = { ...apiData, body: { result: 42 }, showHeaders: false };
      renderCommandResult(res({ data, renderAs: 'raw-api' }), 'human', cap.io);
      const out = cap.stdout();
      const lines = out.split('\n');
      expect(lines[0]).toBe('HTTP 200 OK');
      // No header lines should appear
      expect(out).not.toContain('content-type:');
      expect(out).not.toContain('x-request-id:');
      // Body (YAML) should appear after the status block
      expect(out).toContain('result:');
      expect(out).toContain('42');
    });

    it('human format with showHeaders=true emits headers between status and body', () => {
      const cap = makeIo();
      const data = { ...apiData, body: { result: 42 }, showHeaders: true };
      renderCommandResult(res({ data, renderAs: 'raw-api' }), 'human', cap.io);
      const out = cap.stdout();
      const lines = out.split('\n');
      expect(lines[0]).toBe('HTTP 200 OK');
      // Headers as "name: value" lines must appear
      expect(out).toContain('content-type: application/json');
      expect(out).toContain('x-request-id: abc');
      // Body (YAML) follows
      expect(out).toContain('result:');
      expect(out).toContain('42');
      // Status line precedes the headers
      const statusIdx = out.indexOf('HTTP 200 OK');
      const headerIdx = out.indexOf('content-type: application/json');
      const bodyIdx = out.indexOf('result:');
      expect(statusIdx).toBeLessThan(headerIdx);
      expect(headerIdx).toBeLessThan(bodyIdx);
    });

    it('human format with string body emits the body verbatim (not YAML)', () => {
      const cap = makeIo();
      const data = { ...apiData, body: 'plain text body', showHeaders: false };
      renderCommandResult(res({ data, renderAs: 'raw-api' }), 'human', cap.io);
      const out = cap.stdout();
      expect(out).toContain('HTTP 200 OK');
      expect(out).toContain('plain text body\n');
    });

    it('falls back to JSON stringify when data does not look like raw-api shape', () => {
      const cap = makeIo();
      const data = { foo: 'bar' };
      renderCommandResult(res({ data, renderAs: 'raw-api' }), 'human', cap.io);
      expect(cap.stdout()).toBe(`${JSON.stringify(data, null, 2)}\n`);
    });
  });
});

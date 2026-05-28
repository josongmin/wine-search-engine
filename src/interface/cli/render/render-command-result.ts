import type { CommandResult } from '../../../application/cli/context/command-result.js';
import type { OutputFormat } from '../../../application/cli/port/output-renderer.port.js';
import type { CliIo } from '../io.js';
import YAML from 'yaml';

const JSON_INDENT = 2;

function asJson(data: unknown): string {
  return `${JSON.stringify(data, null, JSON_INDENT)}\n`;
}

function asYaml(data: unknown): string {
  const rendered = YAML.stringify(data);
  return rendered.endsWith('\n') ? rendered : `${rendered}\n`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTableRow(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && Object.values(value).every((entry) => typeof entry !== 'object');
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function formatTable(data: unknown): string {
  const rows = Array.isArray(data) ? data : isPlainRecord(data) ? [data] : [];
  if (rows.length === 0 || !rows.every(isTableRow)) {
    return asJson(data);
  }
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const widths = columns.map((column) => {
    let width = column.length;
    for (const row of rows) {
      const cellWidth = formatCell(row[column]).length;
      if (cellWidth > width) {
        width = cellWidth;
      }
    }
    return width;
  });
  const renderRow = (row: Record<string, unknown>): string =>
    columns
      .map((column, index) => formatCell(row[column]).padEnd(widths[index] ?? column.length))
      .join('  ')
      .trimEnd();
  const divider = widths.map((width) => '-'.repeat(width)).join('  ');
  return `${renderRow(Object.fromEntries(columns.map((column) => [column, column])))}\n${divider}\n${rows
    .map(renderRow)
    .join('\n')}\n`;
}

function isRawApiRenderData(
  data: unknown,
): data is {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly rawText?: string;
  readonly showHeaders?: boolean;
} {
  return isPlainRecord(data)
    && typeof data['status'] === 'number'
    && typeof data['statusText'] === 'string'
    && isPlainRecord(data['headers']);
}

function renderRawApi(result: CommandResult, format: OutputFormat, io: CliIo): void {
  if (!isRawApiRenderData(result.data)) {
    io.write(asJson(result.data));
    return;
  }
  const data = result.data;
  switch (format) {
    case 'json':
      io.write(asJson(data));
      return;
    case 'yaml':
      io.write(asYaml(data));
      return;
    case 'table':
      io.write(formatTable(data.headers));
      return;
    case 'raw':
      io.write(`${data.rawText ?? (typeof data.body === 'string' ? data.body : JSON.stringify(data.body, null, JSON_INDENT))}\n`);
      return;
    case 'human': {
      const lines = [`HTTP ${String(data.status)} ${data.statusText}`];
      if (data.showHeaders === true) {
        lines.push('');
        for (const [name, value] of Object.entries(data.headers)) {
          lines.push(`${name}: ${value}`);
        }
      }
      lines.push('');
      io.write(`${lines.join('\n')}\n`);
      if (typeof data.body === 'string') {
        io.write(`${data.body}\n`);
      } else {
        io.write(asYaml(data.body));
      }
    }
  }
}

/**
 * Common CLI renderer contract. Warnings go to stderr; data formatting stays
 * centralized so leaf commands remain transport/domain only.
 */
export function renderCommandResult(
  result: CommandResult,
  format: OutputFormat,
  io: CliIo,
): void {
  for (const warning of result.warnings ?? []) {
    io.writeError(`warning: ${warning}\n`);
  }

  if (result.renderAs === 'raw-api') {
    renderRawApi(result, format, io);
    return;
  }

  switch (format) {
    case 'human':
      io.write(typeof result.data === 'string' ? `${result.data}\n` : asYaml(result.data));
      break;
    case 'json':
      io.write(asJson(result.data));
      break;
    case 'yaml':
      io.write(asYaml(result.data));
      break;
    case 'table':
      io.write(formatTable(result.data));
      break;
    case 'raw':
      io.write(
        typeof result.data === 'string'
          ? `${result.data}\n`
          : `${JSON.stringify(result.data, null, JSON_INDENT)}\n`,
      );
      break;
  }
}

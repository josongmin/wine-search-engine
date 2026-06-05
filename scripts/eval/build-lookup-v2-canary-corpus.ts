#!/usr/bin/env tsx

import { writeFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const LOOKUP_CANARY_STATUSES = ['resolved', 'ambiguous', 'failed', 'redirect_discovery'] as const;
type LookupCanaryStatus = (typeof LOOKUP_CANARY_STATUSES)[number];

export interface LookupV2CanaryCorpusRow {
  readonly qid: string;
  readonly query: string;
  readonly expected_status?: LookupCanaryStatus | undefined;
  readonly accepted_statuses?: readonly LookupCanaryStatus[] | undefined;
  readonly expected_entity_id?: string | undefined;
}

export interface LookupV2CanaryCorpusBuilderArgs {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly queryField: string;
  readonly qidField?: string | undefined;
  readonly expectedStatusField?: string | undefined;
  readonly acceptedStatusesField?: string | undefined;
  readonly expectedEntityIdField?: string | undefined;
  readonly routeField?: string | undefined;
  readonly routeValue?: string | undefined;
  readonly methodField?: string | undefined;
  readonly methodValue?: string | undefined;
  readonly limit?: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getValueAtPath(input: unknown, dottedPath: string): unknown {
  const segments = dottedPath.split('.');
  let current: unknown = input;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^\d+$/u.test(segment)) {
        return undefined;
      }
      current = current[Number.parseInt(segment, 10)];
      continue;
    }
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function readStringField(record: Record<string, unknown>, fieldPath: string, context: string): string {
  const value = getValueAtPath(record, fieldPath);
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context}: field "${fieldPath}" must be a non-empty string`);
  }
  return value;
}

function readOptionalStringField(
  record: Record<string, unknown>,
  fieldPath: string,
  context: string,
): string | undefined {
  const value = getValueAtPath(record, fieldPath);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context}: field "${fieldPath}" must be a non-empty string when present`);
  }
  return value;
}

function parseLookupCanaryStatus(raw: string, context: string): LookupCanaryStatus {
  if ((LOOKUP_CANARY_STATUSES as readonly string[]).includes(raw)) {
    return raw as LookupCanaryStatus;
  }
  throw new Error(
    `${context}: invalid lookup status "${raw}", expected one of ${LOOKUP_CANARY_STATUSES.join(', ')}`,
  );
}

function readOptionalStatusField(
  record: Record<string, unknown>,
  fieldPath: string,
  context: string,
): LookupCanaryStatus | undefined {
  const value = getValueAtPath(record, fieldPath);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${context}: field "${fieldPath}" must be a string when present`);
  }
  return parseLookupCanaryStatus(value, context);
}

function readOptionalStatusesField(
  record: Record<string, unknown>,
  fieldPath: string,
  context: string,
): readonly LookupCanaryStatus[] | undefined {
  const value = getValueAtPath(record, fieldPath);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${context}: field "${fieldPath}" must be an array of lookup statuses`);
  }
  const statuses = value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new Error(`${context}: field "${fieldPath}[${String(index)}]" must be a string`);
    }
    return parseLookupCanaryStatus(item, context);
  });
  return statuses.length > 0 ? statuses : undefined;
}

export function parseLookupV2CanaryCorpusBuilderArgs(
  argv: readonly string[],
): LookupV2CanaryCorpusBuilderArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: 'string' },
      output: { type: 'string', default: '/tmp/lookup-v2-canary-corpus.jsonl' },
      'query-field': { type: 'string' },
      'qid-field': { type: 'string' },
      'expected-status-field': { type: 'string' },
      'accepted-statuses-field': { type: 'string' },
      'expected-entity-id-field': { type: 'string' },
      'route-field': { type: 'string' },
      'route-value': { type: 'string' },
      'method-field': { type: 'string' },
      'method-value': { type: 'string' },
      limit: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.input === undefined) {
    throw new Error('Missing required --input <logs.ndjson>');
  }
  if (values['query-field'] === undefined) {
    throw new Error('Missing required --query-field <dotted.path>');
  }
  if ((values['route-field'] === undefined) !== (values['route-value'] === undefined)) {
    throw new Error('Route filter requires both --route-field and --route-value');
  }
  if ((values['method-field'] === undefined) !== (values['method-value'] === undefined)) {
    throw new Error('Method filter requires both --method-field and --method-value');
  }

  const limit =
    values.limit === undefined
      ? undefined
      : Number.parseInt(values.limit, 10);
  if (values.limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`Invalid --limit value: ${values.limit}`);
  }

  return {
    inputPath: values.input,
    outputPath: values.output ?? '/tmp/lookup-v2-canary-corpus.jsonl',
    queryField: values['query-field'],
    ...(values['qid-field'] !== undefined ? { qidField: values['qid-field'] } : {}),
    ...(values['expected-status-field'] !== undefined
      ? { expectedStatusField: values['expected-status-field'] }
      : {}),
    ...(values['accepted-statuses-field'] !== undefined
      ? { acceptedStatusesField: values['accepted-statuses-field'] }
      : {}),
    ...(values['expected-entity-id-field'] !== undefined
      ? { expectedEntityIdField: values['expected-entity-id-field'] }
      : {}),
    ...(values['route-field'] !== undefined ? { routeField: values['route-field'] } : {}),
    ...(values['route-value'] !== undefined ? { routeValue: values['route-value'] } : {}),
    ...(values['method-field'] !== undefined ? { methodField: values['method-field'] } : {}),
    ...(values['method-value'] !== undefined ? { methodValue: values['method-value'] } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function recordMatchesExplicitFilters(
  record: Record<string, unknown>,
  args: LookupV2CanaryCorpusBuilderArgs,
): boolean {
  if (args.routeField !== undefined && args.routeValue !== undefined) {
    if (getValueAtPath(record, args.routeField) !== args.routeValue) {
      return false;
    }
  }
  if (args.methodField !== undefined && args.methodValue !== undefined) {
    if (getValueAtPath(record, args.methodField) !== args.methodValue) {
      return false;
    }
  }
  return true;
}

export function buildLookupV2CanaryCorpusFromNdjson(
  content: string,
  args: LookupV2CanaryCorpusBuilderArgs,
): {
  readonly selectedRows: readonly LookupV2CanaryCorpusRow[];
  readonly scannedRowCount: number;
  readonly matchedRowCount: number;
} {
  const rows: LookupV2CanaryCorpusRow[] = [];
  const lines = content.split('\n');
  let scannedRowCount = 0;
  let matchedRowCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (trimmed.length === 0) {
      continue;
    }
    scannedRowCount += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`Malformed JSON at ${args.inputPath}:${String(index + 1)}`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`${args.inputPath}:${String(index + 1)} must be a JSON object`);
    }
    if (!recordMatchesExplicitFilters(parsed, args)) {
      continue;
    }
    matchedRowCount += 1;
    const context = `${args.inputPath}:${String(index + 1)}`;
    const qidFromField =
      args.qidField !== undefined
        ? readOptionalStringField(parsed, args.qidField, context)
        : undefined;
    const qid = qidFromField ?? `row-${String(rows.length + 1)}`;
    const query = readStringField(parsed, args.queryField, context);
    const expectedStatus =
      args.expectedStatusField !== undefined
        ? readOptionalStatusField(parsed, args.expectedStatusField, context)
        : undefined;
    const acceptedStatuses =
      args.acceptedStatusesField !== undefined
        ? readOptionalStatusesField(parsed, args.acceptedStatusesField, context)
        : undefined;
    const expectedEntityId =
      args.expectedEntityIdField !== undefined
        ? readOptionalStringField(parsed, args.expectedEntityIdField, context)
        : undefined;
    rows.push({
      qid,
      query,
      ...(expectedStatus !== undefined ? { expected_status: expectedStatus } : {}),
      ...(acceptedStatuses !== undefined ? { accepted_statuses: acceptedStatuses } : {}),
      ...(expectedEntityId !== undefined ? { expected_entity_id: expectedEntityId } : {}),
    });
    if (args.limit !== undefined && rows.length >= args.limit) {
      break;
    }
  }

  return {
    selectedRows: rows,
    scannedRowCount,
    matchedRowCount,
  };
}

export async function buildLookupV2CanaryCorpus(
  args: LookupV2CanaryCorpusBuilderArgs,
): Promise<{
  readonly rowCount: number;
  readonly scannedRowCount: number;
  readonly matchedRowCount: number;
}> {
  const raw = readFileSync(args.inputPath, 'utf8');
  const built = buildLookupV2CanaryCorpusFromNdjson(raw, args);
  if (built.selectedRows.length === 0) {
    throw new Error(`[lookup-canary-build] empty selection from ${args.inputPath}`);
  }
  writeFileSync(
    args.outputPath,
    `${built.selectedRows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  );
  return {
    rowCount: built.selectedRows.length,
    scannedRowCount: built.scannedRowCount,
    matchedRowCount: built.matchedRowCount,
  };
}

async function main(): Promise<void> {
  const args = parseLookupV2CanaryCorpusBuilderArgs(process.argv.slice(2).filter((arg) => arg !== '--'));
  const result = await buildLookupV2CanaryCorpus(args);
  console.log(
    `[lookup-canary-build] scanned=${String(result.scannedRowCount)} matched=${String(result.matchedRowCount)} rows=${String(result.rowCount)}`,
  );
  console.log(`[lookup-canary-build] report → ${args.outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    console.error('[lookup-canary-build] FATAL', error);
    process.exit(1);
  });
}

import { readFileSync } from 'node:fs';

export type LookupV2StretchStatus =
  | 'resolved'
  | 'ambiguous'
  | 'failed'
  | 'redirect_discovery';

export interface LookupV2StretchRow {
  readonly qid: string;
  readonly query: string;
  readonly expected_status: LookupV2StretchStatus;
  readonly expected_entity_hint?: string;
  readonly expected_entity_id?: string;
  readonly accepted_statuses?: readonly LookupV2StretchStatus[];
  readonly class: string;
  readonly note: string;
}

export interface LookupV2StretchCandidateRow {
  readonly qid?: string;
  readonly query: string;
  readonly expected_status: LookupV2StretchStatus;
  readonly expected_entity_hint?: string;
  readonly expected_entity_id?: string;
  readonly accepted_statuses?: readonly LookupV2StretchStatus[];
  readonly class: string;
  readonly note: string;
}

export interface LookupV2StretchCorpusSummary {
  readonly totalRows: number;
  readonly entityRows: number;
  readonly discoveryRows: number;
  readonly hangulRows: number;
  readonly spacedRows: number;
  readonly statusCounts: Record<LookupV2StretchStatus, number>;
  readonly classCounts: Record<string, number>;
  readonly qidPrefixes: Record<string, number>;
  readonly maxNumericSuffixByPrefix: Record<string, number>;
}

export const LOOKUP_V2_STRETCH_STATUS_VALUES: readonly LookupV2StretchStatus[] = [
  'resolved',
  'ambiguous',
  'failed',
  'redirect_discovery',
] as const;

const LOOKUP_V2_STRETCH_STATUS_SET = new Set<string>(LOOKUP_V2_STRETCH_STATUS_VALUES);
const QID_PATTERN = /^elv2-([a-z0-9]+)-(\d+)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function parseOptionalStatuses(
  value: unknown,
  label: string,
): readonly LookupV2StretchStatus[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array when provided`);
  }
  const seen = new Set<string>();
  const statuses: LookupV2StretchStatus[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !LOOKUP_V2_STRETCH_STATUS_SET.has(entry)) {
      throw new Error(`${label} contains invalid status`);
    }
    if (seen.has(entry)) {
      throw new Error(`${label} contains duplicate status ${entry}`);
    }
    seen.add(entry);
    statuses.push(entry as LookupV2StretchStatus);
  }
  return statuses;
}

function validateStatusSpecificFields(args: {
  readonly row: LookupV2StretchCandidateRow;
  readonly label: string;
}): void {
  const { row, label } = args;
  if (row.expected_status === 'redirect_discovery') {
    if (row.expected_entity_hint !== undefined) {
      throw new Error(`${label} redirect_discovery row must not carry expected_entity_hint`);
    }
    if (row.expected_entity_id !== undefined) {
      throw new Error(`${label} redirect_discovery row must not carry expected_entity_id`);
    }
    return;
  }
  if (row.expected_status === 'resolved'
    && (typeof row.expected_entity_hint !== 'string' || row.expected_entity_hint.trim().length === 0)) {
    throw new Error(`${label} resolved row requires expected_entity_hint`);
  }
  if (row.expected_entity_id !== undefined
    && (typeof row.expected_entity_hint !== 'string' || row.expected_entity_hint.trim().length === 0)) {
    throw new Error(`${label} expected_entity_id requires expected_entity_hint`);
  }
}

function parseRow(
  value: unknown,
  label: string,
  allowMissingQid: boolean,
): LookupV2StretchCandidateRow {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  const expectedStatus = requireNonEmptyString(value['expected_status'], `${label}.expected_status`);
  if (!LOOKUP_V2_STRETCH_STATUS_SET.has(expectedStatus)) {
    throw new Error(`${label}.expected_status must be one of ${LOOKUP_V2_STRETCH_STATUS_VALUES.join(', ')}`);
  }
  const qidValue = value['qid'];
  const qid = qidValue === undefined ? undefined : requireNonEmptyString(qidValue, `${label}.qid`);
  if (!allowMissingQid && qid === undefined) {
    throw new Error(`${label}.qid is required`);
  }
  if (qid !== undefined && !QID_PATTERN.test(qid)) {
    throw new Error(`${label}.qid must match ${QID_PATTERN.source}`);
  }

  const row: LookupV2StretchCandidateRow = {
    ...(qid !== undefined ? { qid } : {}),
    query: requireNonEmptyString(value['query'], `${label}.query`),
    expected_status: expectedStatus as LookupV2StretchStatus,
    ...(typeof value['expected_entity_hint'] === 'string'
      ? { expected_entity_hint: requireNonEmptyString(value['expected_entity_hint'], `${label}.expected_entity_hint`) }
      : {}),
    ...(typeof value['expected_entity_id'] === 'string'
      ? { expected_entity_id: requireNonEmptyString(value['expected_entity_id'], `${label}.expected_entity_id`) }
      : {}),
    ...(parseOptionalStatuses(value['accepted_statuses'], `${label}.accepted_statuses`) !== undefined
      ? { accepted_statuses: parseOptionalStatuses(value['accepted_statuses'], `${label}.accepted_statuses`) }
      : {}),
    class: requireNonEmptyString(value['class'], `${label}.class`),
    note: requireNonEmptyString(value['note'], `${label}.note`),
  };
  validateStatusSpecificFields({ row, label });
  return row;
}

function parseJsonlRows(
  raw: string,
  sourceLabel: string,
  allowMissingQid: boolean,
): readonly LookupV2StretchCandidateRow[] {
  const rows: LookupV2StretchCandidateRow[] = [];
  const seenQids = new Set<string>();
  const seenQueries = new Set<string>();
  for (const [index, line] of raw.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const label = `${sourceLabel}:line${index + 1}`;
    const row = parseRow(JSON.parse(trimmed) as unknown, label, allowMissingQid);
    if (row.qid !== undefined) {
      if (seenQids.has(row.qid)) {
        throw new Error(`${label}.qid duplicates ${row.qid} inside source`);
      }
      seenQids.add(row.qid);
    }
    if (seenQueries.has(row.query)) {
      throw new Error(`${label}.query duplicates "${row.query}" inside source`);
    }
    seenQueries.add(row.query);
    rows.push(row);
  }
  return rows;
}

export function loadLookupV2StretchCorpusSync(path: string): readonly LookupV2StretchRow[] {
  return parseJsonlRows(readFileSync(path, 'utf8'), path, false) as readonly LookupV2StretchRow[];
}

export function loadLookupV2StretchCandidateSync(path: string): readonly LookupV2StretchCandidateRow[] {
  return parseJsonlRows(readFileSync(path, 'utf8'), path, true);
}

export function summarizeLookupV2StretchCorpus(
  rows: readonly LookupV2StretchCandidateRow[],
): LookupV2StretchCorpusSummary {
  const statusCounts: Record<LookupV2StretchStatus, number> = {
    resolved: 0,
    ambiguous: 0,
    failed: 0,
    redirect_discovery: 0,
  };
  const classCounts = new Map<string, number>();
  const qidPrefixes = new Map<string, number>();
  const maxNumericSuffixByPrefix = new Map<string, number>();
  let entityRows = 0;
  let discoveryRows = 0;
  let hangulRows = 0;
  let spacedRows = 0;

  for (const row of rows) {
    statusCounts[row.expected_status] += 1;
    classCounts.set(row.class, (classCounts.get(row.class) ?? 0) + 1);
    if (row.expected_status === 'redirect_discovery') {
      discoveryRows += 1;
    } else {
      entityRows += 1;
    }
    if (/[가-힣]/u.test(row.query)) {
      hangulRows += 1;
    }
    if (/\s/u.test(row.query)) {
      spacedRows += 1;
    }
    if (row.qid !== undefined) {
      const match = row.qid.match(QID_PATTERN);
      if (match !== null) {
        const [, prefix, numericText] = match;
        const numeric = Number.parseInt(numericText, 10);
        qidPrefixes.set(prefix, (qidPrefixes.get(prefix) ?? 0) + 1);
        maxNumericSuffixByPrefix.set(prefix, Math.max(maxNumericSuffixByPrefix.get(prefix) ?? 0, numeric));
      }
    }
  }

  return {
    totalRows: rows.length,
    entityRows,
    discoveryRows,
    hangulRows,
    spacedRows,
    statusCounts,
    classCounts: Object.fromEntries([...classCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    qidPrefixes: Object.fromEntries([...qidPrefixes.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    maxNumericSuffixByPrefix: Object.fromEntries([...maxNumericSuffixByPrefix.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  };
}

export function assignLookupV2StretchQids(args: {
  readonly candidateRows: readonly LookupV2StretchCandidateRow[];
  readonly existingRows: readonly LookupV2StretchRow[];
  readonly qidPrefix: string;
}): readonly LookupV2StretchRow[] {
  const qidPrefix = requireNonEmptyString(args.qidPrefix, 'qidPrefix');
  const existingQids = new Set(args.existingRows.map((row) => row.qid));
  const existingQueries = new Set(args.existingRows.map((row) => row.query));
  const assignedRows: LookupV2StretchRow[] = [];
  const prefixPattern = new RegExp(`^elv2-${qidPrefix}-(\\d+)$`);
  let maxNumeric = 0;
  for (const row of args.existingRows) {
    const match = row.qid.match(prefixPattern);
    if (match !== null) {
      maxNumeric = Math.max(maxNumeric, Number.parseInt(match[1], 10));
    }
  }
  for (const [index, row] of args.candidateRows.entries()) {
    if (existingQueries.has(row.query)) {
      throw new Error(`candidate query duplicates existing corpus row: "${row.query}"`);
    }
    const qid = row.qid ?? `elv2-${qidPrefix}-${String(maxNumeric + index + 1).padStart(3, '0')}`;
    if (existingQids.has(qid)) {
      throw new Error(`candidate qid duplicates existing corpus row: ${qid}`);
    }
    assignedRows.push({
      qid,
      query: row.query,
      expected_status: row.expected_status,
      ...(row.expected_entity_hint !== undefined ? { expected_entity_hint: row.expected_entity_hint } : {}),
      ...(row.expected_entity_id !== undefined ? { expected_entity_id: row.expected_entity_id } : {}),
      ...(row.accepted_statuses !== undefined ? { accepted_statuses: row.accepted_statuses } : {}),
      class: row.class,
      note: row.note,
    });
    existingQids.add(qid);
    existingQueries.add(row.query);
  }
  return assignedRows;
}

export function serializeLookupV2StretchRows(rows: readonly LookupV2StretchRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

export function formatLookupV2StretchCorpusSummary(summary: LookupV2StretchCorpusSummary): string {
  const lines = [
    `[stretch-corpus] total_rows=${summary.totalRows}`,
    `[stretch-corpus] entity_rows=${summary.entityRows} discovery_rows=${summary.discoveryRows}`,
    `[stretch-corpus] hangul_rows=${summary.hangulRows} spaced_rows=${summary.spacedRows}`,
    `[stretch-corpus] status_counts=${JSON.stringify(summary.statusCounts)}`,
    `[stretch-corpus] qid_prefixes=${JSON.stringify(summary.qidPrefixes)}`,
    `[stretch-corpus] max_numeric_suffix_by_prefix=${JSON.stringify(summary.maxNumericSuffixByPrefix)}`,
    `[stretch-corpus] top_classes=${JSON.stringify(
      Object.fromEntries(
        [...Object.entries(summary.classCounts)]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 12),
      ),
    )}`,
  ];
  return lines.join('\n');
}

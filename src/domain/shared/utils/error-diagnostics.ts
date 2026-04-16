const MAX_ERROR_CAUSE_DEPTH = 5;

export interface SafeErrorDiagnostics {
  readonly name: string;
  readonly message: string;
  readonly code?: string | number;
  readonly errno?: string | number;
  readonly statusCode?: number;
  readonly syscall?: string;
  readonly hostname?: string;
  readonly address?: string;
  readonly port?: string | number;
  readonly isAborted?: boolean;
  readonly cause?: SafeErrorDiagnostics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readStringOrNumber(
  record: Record<string, unknown>,
  key: string,
): string | number | undefined {
  const value = record[key];
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function getSafeErrorDiagnostics(
  error: unknown,
  depth = 0,
  seen = new Set<unknown>(),
): SafeErrorDiagnostics | undefined {
  if (!isRecord(error) || seen.has(error) || depth >= MAX_ERROR_CAUSE_DEPTH) {
    return undefined;
  }

  seen.add(error);

  const name = readString(error, 'name') ?? 'Error';
  const message = readString(error, 'message') ?? '<no message>';
  const code = readStringOrNumber(error, 'code');
  const errno = readStringOrNumber(error, 'errno');
  const statusCode = readNumber(error, 'statusCode');
  const syscall = readString(error, 'syscall');
  const hostname = readString(error, 'hostname');
  const address = readString(error, 'address');
  const port = readStringOrNumber(error, 'port');
  const isAborted = readBoolean(error, 'isAborted');
  const cause = getSafeErrorDiagnostics(error['cause'], depth + 1, seen);

  const diagnostics: SafeErrorDiagnostics = {
    name,
    message,
    ...(code !== undefined ? { code } : {}),
    ...(errno !== undefined ? { errno } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(syscall !== undefined ? { syscall } : {}),
    ...(hostname !== undefined ? { hostname } : {}),
    ...(address !== undefined ? { address } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(isAborted !== undefined ? { isAborted } : {}),
    ...(cause !== undefined ? { cause } : {}),
  };

  return diagnostics;
}

function formatSingleErrorDiagnostic(
  label: string,
  diagnostic: SafeErrorDiagnostics,
): string {
  const attributes = [
    `name=${diagnostic.name}`,
    `message=${diagnostic.message}`,
    ...(diagnostic.code !== undefined ? [`code=${String(diagnostic.code)}`] : []),
    ...(diagnostic.errno !== undefined ? [`errno=${String(diagnostic.errno)}`] : []),
    ...(diagnostic.statusCode !== undefined ? [`statusCode=${String(diagnostic.statusCode)}`] : []),
    ...(diagnostic.syscall !== undefined ? [`syscall=${diagnostic.syscall}`] : []),
    ...(diagnostic.hostname !== undefined ? [`hostname=${diagnostic.hostname}`] : []),
    ...(diagnostic.address !== undefined ? [`address=${diagnostic.address}`] : []),
    ...(diagnostic.port !== undefined ? [`port=${String(diagnostic.port)}`] : []),
    ...(diagnostic.isAborted !== undefined ? [`isAborted=${String(diagnostic.isAborted)}`] : []),
  ];

  return `${label}{${attributes.join(', ')}}`;
}

export function formatErrorDiagnostics(error: unknown): string | undefined {
  const root = getSafeErrorDiagnostics(error);
  if (root === undefined) {
    return undefined;
  }

  const rendered: string[] = [];
  let current: SafeErrorDiagnostics | undefined = root;
  let depth = 0;
  while (current !== undefined && depth < MAX_ERROR_CAUSE_DEPTH) {
    rendered.push(formatSingleErrorDiagnostic(depth === 0 ? 'error' : `cause${depth}`, current));
    current = current.cause;
    depth += 1;
  }

  return rendered.join(' ');
}

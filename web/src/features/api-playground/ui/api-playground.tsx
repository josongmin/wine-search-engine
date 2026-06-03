'use client';

/**
 * Generic API playground panel: pick an endpoint from a catalog, edit the JSON
 * body (prefilled with a working template), fire it, and inspect the verbatim
 * status + response (4xx/5xx envelopes included). Auth headers are attached
 * automatically per endpoint gate from optional operator credentials. A
 * copy-pasteable curl is rendered alongside.
 *
 * Reused by the product search tester (public endpoints, no keys) and the ops
 * console (debug/write-gated endpoints).
 */

import { useMemo, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { rawApiCall, type RawApiResult } from '@/shared/api/client';
import { Badge, Button, Card, CardContent, CardHeader } from '@/shared/ui';

export type AuthGate = 'none' | 'debug' | 'write';

export interface EndpointSpec {
  id: string;
  label: string;
  method: 'GET' | 'POST';
  path: string;
  auth: AuthGate;
  /** JSON body template; empty string means "no body" (GET / no-payload). */
  template: string;
}

/** Minimal credential shape (structurally compatible with the ops keys hook). */
export interface PlaygroundKeys {
  debugKey: string;
  writeKey: string;
}

export const prettyJson = (o: unknown) => JSON.stringify(o, null, 2);

const AUTH_LABEL: Record<AuthGate, string> = {
  none: 'public',
  debug: 'X-Debug-Key',
  write: 'X-Ops-Write-Key',
};
const AUTH_VARIANT: Record<AuthGate, 'default' | 'info' | 'warning'> = {
  none: 'default',
  debug: 'info',
  write: 'warning',
};

const textareaClass =
  'w-full rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900';

function authHeadersFor(spec: EndpointSpec, keys?: PlaygroundKeys): { debugKey?: string; writeKey?: string } {
  if (!keys) return {};
  switch (spec.auth) {
    case 'debug':
      return keys.debugKey.length > 0 ? { debugKey: keys.debugKey } : {};
    case 'write':
      // write endpoints carry BOTH gates server-side; send what we have.
      return {
        ...(keys.debugKey.length > 0 ? { debugKey: keys.debugKey } : {}),
        ...(keys.writeKey.length > 0 ? { writeKey: keys.writeKey } : {}),
      };
    case 'none':
      return {};
  }
}

function curlFor(spec: EndpointSpec, body: string): string {
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  const lines = [`curl -s -X ${spec.method} '${base}${spec.path}'`];
  if (spec.method !== 'GET') lines.push(`  -H 'Content-Type: application/json'`);
  if (spec.auth === 'debug' || spec.auth === 'write') lines.push(`  -H 'X-Debug-Key: $X_DEBUG_KEY'`);
  if (spec.auth === 'write') lines.push(`  -H 'X-Ops-Write-Key: $X_OPS_WRITE_KEY'`);
  if (spec.method !== 'GET' && body.trim().length > 0) {
    lines.push(`  -d '${body.replace(/\n\s*/g, '')}'`);
  }
  return lines.join(' \\\n');
}

export function ApiPlaygroundPanel({
  endpoints,
  keys,
  title = 'API playground',
  subtitle = 'Fire any endpoint directly and inspect the raw response.',
}: {
  endpoints: readonly EndpointSpec[];
  keys?: PlaygroundKeys;
  title?: string;
  subtitle?: string;
}) {
  const first = endpoints[0];
  const [endpointId, setEndpointId] = useState(first?.id ?? '');
  const spec = useMemo(
    () => endpoints.find((e) => e.id === endpointId) ?? first,
    [endpoints, endpointId, first],
  );
  const [body, setBody] = useState(first?.template ?? '');
  const [result, setResult] = useState<RawApiResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function selectEndpoint(id: string) {
    const next = endpoints.find((e) => e.id === id) ?? first;
    setEndpointId(id);
    setBody(next?.template ?? '');
    setResult(null);
    setError(null);
  }

  if (!spec) return null;

  const missingKey =
    keys !== undefined &&
    ((spec.auth === 'debug' && keys.debugKey.length === 0) ||
      (spec.auth === 'write' && keys.writeKey.length === 0));

  async function send() {
    if (!spec) return;
    setError(null);
    // Validate JSON body up front so the caller sees a clear local error
    // instead of a server 400 for a typo.
    let payload: string | undefined;
    if (spec.method !== 'GET' && body.trim().length > 0) {
      try {
        JSON.parse(body);
      } catch (e) {
        setError(`Invalid JSON body: ${e instanceof Error ? e.message : 'parse error'}`);
        return;
      }
      payload = body;
    }
    setBusy(true);
    try {
      setResult(
        await rawApiCall(spec.method, spec.path, {
          ...authHeadersFor(spec, keys),
          ...(payload !== undefined ? { body: payload } : {}),
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-neutral-500">{subtitle}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            value={spec.id}
            onChange={(e) => selectEndpoint(e.target.value)}
            aria-label="endpoint"
          >
            {endpoints.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
          <Badge variant={AUTH_VARIANT[spec.auth]}>{AUTH_LABEL[spec.auth]}</Badge>
          <code className="font-mono text-xs text-neutral-500">
            {spec.method} {spec.path}
          </code>
          <Button size="sm" className="ml-auto" onClick={() => void send()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Send
          </Button>
        </div>

        {missingKey ? (
          <p className="text-xs text-amber-600">
            This endpoint needs the {AUTH_LABEL[spec.auth]} — fill it above or expect a 403.
          </p>
        ) : null}

        {spec.method !== 'GET' ? (
          <label className="block space-y-1">
            <span className="text-xs font-medium">Request body (JSON)</span>
            <textarea
              className={textareaClass}
              rows={Math.min(16, Math.max(4, body.split('\n').length + 1))}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              spellCheck={false}
              aria-label="request body"
            />
          </label>
        ) : null}

        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        {result ? (
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <span
                className={`rounded px-1.5 py-0.5 font-mono font-medium ${
                  result.ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                }`}
              >
                {result.status === 0 ? 'ERR' : result.status}
              </span>
              <span className="text-neutral-500">{result.durationMs} ms</span>
            </div>
            <pre className="max-h-96 overflow-auto rounded-md bg-neutral-50 p-3 font-mono text-xs dark:bg-neutral-900">
              {typeof result.body === 'string' ? result.body : prettyJson(result.body)}
            </pre>
          </div>
        ) : null}

        <div>
          <p className="mb-1 text-xs font-medium text-neutral-500">curl</p>
          <pre className="overflow-auto rounded-md bg-neutral-50 p-3 font-mono text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
            {curlFor(spec, body)}
          </pre>
        </div>
      </CardContent>
    </Card>
  );
}

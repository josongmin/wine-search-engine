'use client';

/**
 * Operator credential panel for the lookup-V2 ops console (T-ELV2-07).
 *
 * Holds the two trusted keys (X-Debug-Key for reads, X-Ops-Write-Key for
 * writes) in component state, mirrored to sessionStorage so they survive
 * navigation between the ops pages within a tab. They are NEVER sent anywhere
 * except as request headers to the operator endpoints, and are cleared when the
 * tab closes (sessionStorage, not localStorage).
 */

import { useCallback, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/shared/ui';

const DEBUG_KEY_STORAGE = 'elv2.ops.debugKey';
const WRITE_KEY_STORAGE = 'elv2.ops.writeKey';

export interface OpsKeys {
  debugKey: string;
  writeKey: string;
  setDebugKey: (v: string) => void;
  setWriteKey: (v: string) => void;
}

/** SSR-safe read of a sessionStorage value (empty on the server). */
function readSession(key: string): string {
  return typeof window === 'undefined' ? '' : sessionStorage.getItem(key) ?? '';
}

export function useOpsKeys(): OpsKeys {
  // Lazy initializer (no effect) seeds from sessionStorage on the client; the
  // server renders empty. Inputs carry suppressHydrationWarning so the
  // legitimate server('')↔client(stored) value gap does not warn.
  const [debugKey, setDebugKeyState] = useState(() => readSession(DEBUG_KEY_STORAGE));
  const [writeKey, setWriteKeyState] = useState(() => readSession(WRITE_KEY_STORAGE));

  const setDebugKey = useCallback((v: string) => {
    setDebugKeyState(v);
    sessionStorage.setItem(DEBUG_KEY_STORAGE, v);
  }, []);
  const setWriteKey = useCallback((v: string) => {
    setWriteKeyState(v);
    sessionStorage.setItem(WRITE_KEY_STORAGE, v);
  }, []);

  return { debugKey, writeKey, setDebugKey, setWriteKey };
}

const inputClass =
  'w-full rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-900';

export function OpsKeysPanel({ keys, requireWrite = false }: { keys: OpsKeys; requireWrite?: boolean }) {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold">Operator credentials</h2>
        <p className="text-xs text-neutral-500">
          Read uses <code>X-Debug-Key</code>; write uses <code>X-Ops-Write-Key</code>. Kept in
          this tab only.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium">X-Debug-Key (read)</span>
          <input
            type="password"
            suppressHydrationWarning
            className={inputClass}
            value={keys.debugKey}
            onChange={(e) => keys.setDebugKey(e.target.value)}
            placeholder="HTTP_DEBUG_SECRET"
          />
        </label>
        {requireWrite ? (
          <label className="block space-y-1">
            <span className="text-xs font-medium">X-Ops-Write-Key (write/publish)</span>
            <input
              type="password"
              suppressHydrationWarning
              className={inputClass}
              value={keys.writeKey}
              onChange={(e) => keys.setWriteKey(e.target.value)}
              placeholder="HTTP_OPS_WRITE_SECRET"
            />
          </label>
        ) : null}
      </CardContent>
    </Card>
  );
}

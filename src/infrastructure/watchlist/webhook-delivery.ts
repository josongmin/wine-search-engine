/**
 * Epic 17.1: Webhook Delivery Service
 *
 * Delivers watchlist events via HTTPS POST with retry logic (1s, 5s, 30s backoff)
 * and HMAC-SHA256 signature verification.
 */

import { createHmac, randomUUID } from 'crypto';
import { promises as dnsPromises } from 'node:dns';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { WatchlistEntry, WatchlistChangeEvent } from '../../domain/watchlist/model/watchlist-entry.js';

/**
 * Returns true if the given resolved IP address is private/reserved/loopback
 * and should be rejected at webhook delivery time. Defends against DNS rebinding
 * where the schema-time hostname check passes but DNS later returns an internal IP.
 */
function isPrivateOrReservedIp(ip: string): boolean {
  // IPv4
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 127 || a === 10 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  // IPv6 (collapsed forms accepted; just check well-known prefixes)
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(lower)) return true; // link-local fe80::/10
  if (lower.startsWith('ff')) return true;   // multicast
  // IPv4-mapped IPv6
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped) return isPrivateOrReservedIp(mapped[1]!);
  return false;
}

const log = bootstrapLogger.child({ component: 'WebhookDelivery' });

/**
 * Webhook payload structure sent to the callback URL.
 */
export interface WebhookPayload {
  readonly watchlist_id: string;
  readonly entity_id: string;
  readonly event_type: string;
  readonly event_data: Record<string, unknown>;
  readonly triggered_at: string; // ISO 8601
}

/**
 * Delivery attempt log entry (for audit/debugging).
 */
export interface DeliveryLog {
  readonly id: string; // UUID
  readonly watchlistId: string;
  readonly attempt: number; // 1-4
  readonly statusCode: number | null; // null if connection failed
  readonly errorMessage: string | null;
  readonly deliveredAt: Date;
}

export interface WebhookDeliveryObserver {
  onAttempt?(log: DeliveryLog): Promise<void> | void;
}

export interface WatchlistDeliveryPort {
  deliver(
    entry: WatchlistEntry,
    event: WatchlistChangeEvent,
    observer?: WebhookDeliveryObserver,
  ): Promise<boolean>;
}

interface WebhookAttemptResult {
  readonly statusCode: number | null;
  readonly errorMessage: string | null;
  readonly succeeded: boolean;
}

/**
 * Delivers watchlist events via HTTP webhook with fixed retry schedule.
 * Computes HMAC-SHA256 signature using webhook secret from config.
 *
 * Retry schedule: up to 4 attempts total (1 initial + 3 retries).
 * Waits between attempts: 1 s → 5 s → 30 s.
 */
export class WebhookDelivery implements WatchlistDeliveryPort {
  private readonly secret: string;
  private readonly sleepFn: (ms: number) => Promise<void>;

  /**
   * @param secret   - HMAC-SHA256 signing secret (min 16 chars).
   * @param sleepFn  - Optional sleep implementation (injectable for tests).
   */
  constructor(secret: string, sleepFn?: (ms: number) => Promise<void>) {
    if (secret.length < 16) {
      throw new Error('WEBHOOK_SECRET must be at least 16 characters');
    }
    this.secret = secret;
    this.sleepFn = sleepFn ?? this.defaultSleep;
  }

  /**
   * Delivers a watchlist event to a callback URL with retry logic.
   *
   * Attempts: 4 total (1 initial + 3 retries).
   * Waits between attempts: 1 s, 5 s, 30 s.
   *
   * @param entry - The watchlist entry with callback URL.
   * @param event - The change event to deliver.
   * @returns true if delivery succeeded, false after all attempts are exhausted.
   */
  async deliver(
    entry: WatchlistEntry,
    event: WatchlistChangeEvent,
    observer?: WebhookDeliveryObserver,
  ): Promise<boolean> {
    const payload: WebhookPayload = {
      watchlist_id: entry.id,
      entity_id: entry.entityId,
      event_type: event.type,
      event_data: event.data,
      triggered_at: event.occurredAt,
    };

    // 4 total attempts: initial try + 3 retries separated by 1 s, 5 s, 30 s waits.
    // backoffs[i] is the wait *before* attempt i+1 (i.e. after attempt i fails).
    const maxAttempts = 4;
    const backoffs = [1000, 5000, 30000]; // 1s, 5s, 30s — one entry per inter-attempt gap

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const attemptNumber = attempt + 1;
      try {
        const result = await this.sendRequest(
          entry.callbackUrl,
          entry.id,
          payload,
        );
        await observer?.onAttempt?.({
          id: randomUUID(),
          watchlistId: entry.id,
          attempt: attemptNumber,
          statusCode: result.statusCode,
          errorMessage: result.errorMessage,
          deliveredAt: new Date(),
        });

        if (result.succeeded) {
          return true;
        }
      } catch (err: unknown) {
        // Network error or other exception; will retry
        const errorMessage = err instanceof Error ? err.message : String(err);
        await observer?.onAttempt?.({
          id: randomUUID(),
          watchlistId: entry.id,
          attempt: attemptNumber,
          statusCode: null,
          errorMessage,
          deliveredAt: new Date(),
        });
        log.warn(
          { err, watchlistId: entry.id, attempt: attemptNumber, entityId: entry.entityId },
          'webhook delivery attempt failed (will retry if attempts remain)',
        );
      }

      // Wait before next retry (no wait after the last attempt)
      if (attempt < maxAttempts - 1) {
        const backoff = backoffs[attempt];
        if (backoff !== undefined) {
          await this.sleepFn(backoff);
        }
      }
    }

    return false;
  }

  /**
   * Sends the webhook request with HMAC signature and timeout.
   * Returns true on 2xx status, false otherwise.
   */
  private async sendRequest(
    url: string,
    watchlistId: string,
    payload: WebhookPayload,
  ): Promise<WebhookAttemptResult> {
    // Defense-in-depth SSRF check at delivery time (DNS rebinding mitigation).
    // Schema validation runs at creation time; re-check here because DNS can change.
    let hostname: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') {
        return { statusCode: null, errorMessage: 'Callback URL must use https', succeeded: false };
      }
      hostname = parsed.hostname;
    } catch {
      return { statusCode: null, errorMessage: 'Invalid callback URL', succeeded: false };
    }

    // Resolve the hostname and reject if any resolved IP falls in a
    // private/reserved range. Catches DNS-rebinding attacks where a
    // public hostname now returns an internal address (cloud metadata,
    // RFC1918, link-local, loopback).
    try {
      const lookups = await dnsPromises.lookup(hostname, { all: true });
      for (const { address } of lookups) {
        if (isPrivateOrReservedIp(address)) {
          log.warn({ hostname, address }, 'webhook delivery blocked: resolved IP is private/reserved');
          return {
            statusCode: null,
            errorMessage: 'Callback host resolved to private/reserved IP',
            succeeded: false,
          };
        }
      }
    } catch (err) {
      // DNS resolution failure → fail-closed (do not deliver).
      log.warn({ hostname, err }, 'webhook delivery blocked: DNS resolution failed');
      return { statusCode: null, errorMessage: 'DNS resolution failed', succeeded: false };
    }

    const body = JSON.stringify(payload);
    const signature = this.computeSignature(watchlistId, body);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 5000); // 5s timeout

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Wine-Watchlist-Signature': signature,
        },
        body,
        signal: controller.signal,
        redirect: 'error',
      });

      const statusCode = response.status;
      return {
        statusCode,
        errorMessage: statusCode >= 200 && statusCode < 300
          ? null
          : `Webhook returned HTTP ${statusCode}`,
        succeeded: statusCode >= 200 && statusCode < 300,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Computes HMAC-SHA256 signature for the payload.
   * Format: sha256(`${watchlistId}.${payload}`).
   */
  private computeSignature(watchlistId: string, payload: string): string {
    const message = `${watchlistId}.${payload}`;
    const hmac = createHmac('sha256', this.secret);
    hmac.update(message);
    return hmac.digest('hex');
  }

  /**
   * Default sleep implementation (real timer).  Replaced in tests via constructor injection.
   */
  private readonly defaultSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
}

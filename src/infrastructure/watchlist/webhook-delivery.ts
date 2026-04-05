/**
 * Epic 17.1: Webhook Delivery Service
 *
 * Delivers watchlist events via HTTPS POST with retry logic (1s, 5s, 30s backoff)
 * and HMAC-SHA256 signature verification.
 */

import { createHmac, randomUUID } from 'crypto';
import type { WatchlistEntry, WatchlistChangeEvent } from '../../domain/watchlist/model/watchlist-entry.js';

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
  readonly attempt: number; // 1-3
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
 * Delivers watchlist events via HTTP webhook with exponential backoff retry.
 * Computes HMAC-SHA256 signature using webhook secret from config.
 */
export class WebhookDelivery implements WatchlistDeliveryPort {
  private readonly secret: string;

  /**
   * @param secret - HMAC-SHA256 signing secret (min 16 chars).
   */
  constructor(secret: string) {
    if (secret.length < 16) {
      throw new Error('WEBHOOK_SECRET must be at least 16 characters');
    }
    this.secret = secret;
  }

  /**
   * Delivers a watchlist event to a callback URL with retry logic.
   * Retries on failure: 1s, 5s, 30s backoff.
   *
   * @param entry - The watchlist entry with callback URL.
   * @param event - The change event to deliver.
   * @returns true if delivery succeeded, false after 3 failed attempts.
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

    const maxAttempts = 3;
    const backoffs = [1000, 5000, 30000]; // 1s, 5s, 30s in milliseconds

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
        console.error(`Webhook delivery attempt ${attemptNumber} failed for ${entry.id}:`, err);
      }

      // Wait before retry (except after last attempt)
      if (attempt < maxAttempts - 1) {
        const backoff = backoffs[attempt];
        if (backoff !== undefined) {
          await this.sleep(backoff);
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
   * Sleeps for the specified milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

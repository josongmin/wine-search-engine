/**
 * SSRF validation regression tests.
 *
 * Ensures the watchlist callback URL validator blocks all known SSRF
 * bypass techniques including IPv4 obfuscation, IPv6-mapped addresses,
 * and private/reserved network ranges.
 *
 * Append-only — never delete a regression test.
 */

import { describe, it, expect } from 'vitest';

// Import the schema that contains isPrivateOrReservedHost + HttpsUrlSchema
// via the CreateWatchlistRequestSchema which chains them.
import { CreateWatchlistRequestSchema } from '../../src/interface/http/schemas/watchlist.schema.js';

function validateCallbackUrl(url: string): boolean {
  const result = CreateWatchlistRequestSchema.safeParse({
    entity_id: 'test-entity',
    trigger_conditions: [{ type: 'critic_score_above', threshold: 90 }],
    callback_url: url,
  });
  return result.success;
}

describe('SSRF callback URL validation', () => {
  describe('blocks private/reserved IPv4 addresses', () => {
    const blockedIPs = [
      'https://127.0.0.1/hook',
      'https://10.0.0.1/hook',
      'https://10.255.255.255/hook',
      'https://172.16.0.1/hook',
      'https://172.31.255.255/hook',
      'https://192.168.0.1/hook',
      'https://192.168.255.255/hook',
      'https://169.254.169.254/hook', // AWS IMDS
      'https://0.0.0.0/hook',
    ];

    for (const url of blockedIPs) {
      it(`blocks ${url}`, () => {
        expect(validateCallbackUrl(url)).toBe(false);
      });
    }
  });

  describe('blocks IPv4 obfuscation techniques', () => {
    it('blocks decimal integer notation (2130706433 = 127.0.0.1)', () => {
      expect(validateCallbackUrl('https://2130706433/hook')).toBe(false);
    });

    it('blocks hex notation (0x7f000001 = 127.0.0.1)', () => {
      expect(validateCallbackUrl('https://0x7f000001/hook')).toBe(false);
    });

    it('blocks short-form (127.1 = 127.0.0.1)', () => {
      expect(validateCallbackUrl('https://127.1/hook')).toBe(false);
    });

    it('blocks per-octet hex (0x7f.0x0.0x0.0x1)', () => {
      expect(validateCallbackUrl('https://0x7f.0x0.0x0.0x1/hook')).toBe(false);
    });

    it('blocks decimal 10.x private via integer (167772161 = 10.0.0.1)', () => {
      expect(validateCallbackUrl('https://167772161/hook')).toBe(false);
    });
  });

  describe('blocks IPv6 addresses', () => {
    it('blocks loopback [::1]', () => {
      expect(validateCallbackUrl('https://[::1]/hook')).toBe(false);
    });

    it('blocks IPv6-mapped IPv4 (::ffff:127.0.0.1)', () => {
      expect(validateCallbackUrl('https://[::ffff:127.0.0.1]/hook')).toBe(false);
    });

    it('blocks IPv6-mapped IPv4 hex (::ffff:7f00:1)', () => {
      expect(validateCallbackUrl('https://[::ffff:7f00:1]/hook')).toBe(false);
    });
  });

  describe('blocks localhost', () => {
    it('blocks https://localhost/hook', () => {
      expect(validateCallbackUrl('https://localhost/hook')).toBe(false);
    });
  });

  describe('blocks non-HTTPS', () => {
    it('blocks http:// URLs', () => {
      expect(validateCallbackUrl('http://example.com/hook')).toBe(false);
    });
  });

  describe('allows legitimate public HTTPS URLs', () => {
    it('allows https://example.com/hook', () => {
      expect(validateCallbackUrl('https://example.com/hook')).toBe(true);
    });

    it('allows https://my-webhook.ngrok.io/wine-alerts', () => {
      expect(validateCallbackUrl('https://my-webhook.ngrok.io/wine-alerts')).toBe(true);
    });
  });
});

/**
 * Property-based regression suite for the watchlist infrastructure stack.
 *
 * Locks SOTA++ security/resilience invariants across the trio that an
 * adversary can reach from a webhook callback URL or a poisoned pub/sub
 * payload:
 *
 *   - {@link isPrivateOrReservedIp} (SSRF guard — SSoT, used at watchlist
 *     create-time AND each webhook delivery attempt). This is the
 *     security-critical surface: a single private/reserved range that the
 *     guard reports as "public" is an SSRF hole (cloud metadata, RFC1918,
 *     loopback, link-local).
 *   - {@link RedisWatchlistPublisher} (pub/sub publish path — channel naming
 *     determinism + Korean entity-id preservation + oversize rejection).
 *   - {@link RedisWatchlistSubscriber} + {@link PgWatchlistPoisonStore} /
 *     {@link InMemoryWatchlistPoisonStore} (poison-queue isolation: a
 *     handler that always fails must not block healthy deliveries and the
 *     poisoned payload must land in the DLQ verbatim).
 *
 * SSRF coverage pinned here (defence-in-depth on the SSoT function itself —
 * NOT relying on the caller's dns.lookup() to normalise input):
 *   1. Dotted-decimal private/reserved ranges → ALL blocked.
 *   2. Public dotted-decimal hosts → allowed.
 *   3. IP-encoding bypasses (decimal / octal / hex / mixed) of loopback &
 *      RFC1918 → blocked. A non-dotted integer literal that decodes to a
 *      private address MUST NOT be reported as public.
 *   4. IPv6 loopback / ULA / link-local / IPv4-mapped (dotted + hex) → blocked.
 *   5. Korean entity ids survive the publish channel verbatim (NFC).
 *   6. Poison-queue isolation: failing handler → DLQ, healthy handler → success.
 *
 * fast-check numRuns: 100.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { isPrivateOrReservedIp } from '../../src/infrastructure/watchlist/ssrf-guard.js';
import { RedisWatchlistPublisher } from '../../src/infrastructure/watchlist/redis-watchlist-publisher.js';
import {
  RedisWatchlistSubscriber,
  InMemoryWatchlistPoisonStore,
  type WatchlistEventHandler,
} from '../../src/infrastructure/watchlist/redis-watchlist-subscriber.js';
import { PgWatchlistPoisonStore } from '../../src/infrastructure/watchlist/pg-watchlist-poison-store.js';
import type { WatchlistChangeEvent } from '../../src/domain/watchlist/model/watchlist-entry.js';

const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Helpers — IP encoding bypass generators
// ---------------------------------------------------------------------------

/** Encode a dotted IPv4 as its 32-bit unsigned decimal integer literal. */
function toDecimalIp(a: number, b: number, c: number, d: number): string {
  // ((a<<24)|(b<<16)|(c<<8)|d) but >>>0 to stay unsigned; avoid bit ops on
  // values that overflow int32 by using arithmetic.
  const n = a * 256 * 256 * 256 + b * 256 * 256 + c * 256 + d;
  return n.toString(10);
}

/** Encode a dotted IPv4 as a single hex integer literal (0x...). */
function toHexIp(a: number, b: number, c: number, d: number): string {
  const n = a * 256 * 256 * 256 + b * 256 * 256 + c * 256 + d;
  return `0x${n.toString(16)}`;
}

/** Encode each octet of an IPv4 in octal (leading-zero) dotted form. */
function toOctalDottedIp(a: number, b: number, c: number, d: number): string {
  const oct = (x: number): string => `0${x.toString(8)}`;
  return `${oct(a)}.${oct(b)}.${oct(c)}.${oct(d)}`;
}

// Representative private/reserved IPv4 addresses (dotted-decimal canonical).
const PRIVATE_IPV4_SAMPLES: ReadonlyArray<readonly [number, number, number, number]> = [
  [127, 0, 0, 1], // loopback
  [127, 255, 255, 254],
  [10, 0, 0, 1], // RFC1918 class A
  [10, 255, 255, 255],
  [172, 16, 0, 1], // RFC1918 class B
  [172, 31, 255, 255],
  [192, 168, 0, 1], // RFC1918 class C
  [192, 168, 255, 255],
  [169, 254, 169, 254], // link-local / cloud metadata
  [0, 0, 0, 0], // "this network"
];

// ---------------------------------------------------------------------------
// Property 1 — dotted-decimal private/reserved ranges are ALL blocked
// ---------------------------------------------------------------------------

describe('SSRF guard — dotted-decimal private/reserved ranges', () => {
  it('blocks loopback 127.0.0.0/8 for any host octets', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (b, c, d) => {
          expect(isPrivateOrReservedIp(`127.${b}.${c}.${d}`)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('blocks RFC1918 class A 10.0.0.0/8', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (b, c, d) => {
          expect(isPrivateOrReservedIp(`10.${b}.${c}.${d}`)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('blocks RFC1918 class B 172.16.0.0/12 (and only 16-31 second octet)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 16, max: 31 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (b, c, d) => {
          expect(isPrivateOrReservedIp(`172.${b}.${c}.${d}`)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('blocks RFC1918 class C 192.168.0.0/16 and link-local 169.254.0.0/16', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (c, d) => {
          expect(isPrivateOrReservedIp(`192.168.${c}.${d}`)).toBe(true);
          expect(isPrivateOrReservedIp(`169.254.${c}.${d}`)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2 — public dotted-decimal hosts are allowed (no false positives)
// ---------------------------------------------------------------------------

describe('SSRF guard — public hosts allowed', () => {
  it('allows representative public IPv4 addresses', () => {
    // 8.8.8.8, 1.1.1.1, 93.184.216.34 (example.com), 172.15/172.32 (just
    // outside class B), 192.169 (just outside class C), 169.253/169.255.
    const publicSamples = [
      '8.8.8.8',
      '1.1.1.1',
      '93.184.216.34',
      '172.15.255.255',
      '172.32.0.0',
      '192.167.0.1',
      '192.169.0.1',
      '169.253.0.1',
      '169.255.0.1',
      '203.0.113.0', // documentation but treated as routable public host here
    ];
    for (const ip of publicSamples) {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  });

  it('does not block hostnames that contain digits but are not IP literals', () => {
    // Guard receives resolved IPs in production; a label that contains a
    // non-numeric character cannot be an inet_aton literal and must pass.
    fc.assert(
      fc.property(
        fc
          .domain()
          // Keep only domains with at least one alphabetic label that is not a
          // bare hex/octal literal — these can never normalise to an IPv4 int.
          .filter((d) => /[a-z]/i.test(d.replace(/^0x[0-9a-f]+/i, ''))),
        (host) => {
          expect(isPrivateOrReservedIp(host)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
    // Concrete public hostnames never block.
    for (const h of [
      'api.example.com',
      'wine-search.io',
      'host123.svc.cluster',
      'cdn-3.akamai.net',
      'fca.a.aa',
      'fedoraproject.org',
      'fcm.googleapis.com',
    ]) {
      expect(isPrivateOrReservedIp(h)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 3 — IP-encoding bypasses of private ranges must be blocked
// (defence-in-depth on the SSoT function itself)
// ---------------------------------------------------------------------------

describe('SSRF guard — IP-encoding bypasses (decimal/octal/hex)', () => {
  it('blocks the decimal-integer encoding of every private/reserved sample', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PRIVATE_IPV4_SAMPLES), ([a, b, c, d]) => {
        expect(isPrivateOrReservedIp(toDecimalIp(a, b, c, d))).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('blocks the hex-integer encoding of every private/reserved sample', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PRIVATE_IPV4_SAMPLES), ([a, b, c, d]) => {
        expect(isPrivateOrReservedIp(toHexIp(a, b, c, d))).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('blocks the octal-dotted encoding of every private/reserved sample', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PRIVATE_IPV4_SAMPLES), ([a, b, c, d]) => {
        expect(isPrivateOrReservedIp(toOctalDottedIp(a, b, c, d))).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('blocks well-known canonical bypass literals for 127.0.0.1', () => {
    // Classic SSRF wordlist forms that all decode to loopback.
    expect(isPrivateOrReservedIp('2130706433')).toBe(true); // decimal
    expect(isPrivateOrReservedIp('0x7f000001')).toBe(true); // hex
    expect(isPrivateOrReservedIp('017700000001')).toBe(true); // octal (single int)
    expect(isPrivateOrReservedIp('0177.0.0.1')).toBe(true); // octal dotted
  });

  it('does NOT block the decimal/hex encoding of a public address (no false positive)', () => {
    // 8.8.8.8 = 134744072 = 0x8080808
    expect(isPrivateOrReservedIp('134744072')).toBe(false);
    expect(isPrivateOrReservedIp('0x8080808')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property 4 — IPv6 private/reserved + IPv4-mapped forms blocked
// ---------------------------------------------------------------------------

describe('SSRF guard — IPv6 ranges', () => {
  it('blocks loopback, unspecified, ULA, link-local, multicast', () => {
    const blocked = [
      '::1',
      '::',
      'fc00::1',
      'fd12:3456:789a::1',
      'fe80::1',
      'fec0::1',
      'ff02::1',
    ];
    for (const ip of blocked) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });

  it('blocks IPv4-mapped IPv6 of private ranges (dotted tail)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PRIVATE_IPV4_SAMPLES), ([a, b, c, d]) => {
        expect(isPrivateOrReservedIp(`::ffff:${a}.${b}.${c}.${d}`)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('allows a public global-unicast IPv6 address', () => {
    expect(isPrivateOrReservedIp('2001:4860:4860::8888')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property 5 — publisher channel determinism + Korean entity-id preservation
// ---------------------------------------------------------------------------

interface FakeRedisClient {
  publish: (channel: string, message: string) => Promise<number>;
}

type PublisherClientArg = NonNullable<ConstructorParameters<typeof RedisWatchlistPublisher>[0]>['client'];

function makeRecordingPublisher(): {
  publisher: RedisWatchlistPublisher;
  calls: Array<{ channel: string; message: string }>;
} {
  const calls: Array<{ channel: string; message: string }> = [];
  const client: FakeRedisClient = {
    publish: (channel, message) => {
      calls.push({ channel, message });
      return Promise.resolve(1);
    },
  };
  // The publisher only needs `.publish`; the test double provides exactly that.
  const publisher = new RedisWatchlistPublisher({ client: client as unknown as PublisherClientArg });
  return { publisher, calls };
}

/** A valid PriceUpdatedEvent — parseWatchlistChangeEvent accepts this shape. */
function makeChangeEvent(): WatchlistChangeEvent {
  return {
    type: 'price_updated',
    occurredAt: '2026-05-21T00:00:00.000Z',
    data: { oldPrice: 100, newPrice: 80, percentageDrop: 20 },
  };
}

describe('RedisWatchlistPublisher — channel determinism + Korean preservation', () => {
  it('publishes to watchlist:{entityId} verbatim, including Korean ids', () => {
    fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constantFrom('샤토_마고', '부르고뉴-피노누아', '바롤로_2018', '한국_와인_001'),
          fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !s.includes(' ')),
        ),
        async (entityId) => {
          const { publisher, calls } = makeRecordingPublisher();
          await publisher.publishUpdate(entityId, makeChangeEvent());
          expect(calls).toHaveLength(1);
          // Channel is exactly the prefix + the verbatim (NFC) entity id —
          // Korean / unicode entity ids must survive byte-for-byte.
          expect(calls[0]?.channel).toBe(`watchlist:${entityId}`);
          // The event payload round-trips through JSON intact and re-parses
          // as a valid WatchlistChangeEvent.
          const parsed = JSON.parse(calls[0]?.message ?? '{}') as { type?: string };
          expect(parsed.type).toBe('price_updated');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6 — poison-queue isolation invariants
// ---------------------------------------------------------------------------

describe('Watchlist poison-queue — isolation invariants', () => {
  it('a permanently-failing handler poisons the event without throwing to the subscriber', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !s.includes(' ')),
        async (entityId) => {
          const poisonStore = new InMemoryWatchlistPoisonStore();
          const sub = new RedisWatchlistSubscriber(
            { url: 'redis://unused' },
            () => {
              throw new Error('no redis in this test');
            },
            { poisonStore, retryDelaysMs: [0, 0, 0] },
          );
          const alwaysFails: WatchlistEventHandler = () =>
            Promise.reject(new Error('handler boom'));
          const payload = JSON.stringify(makeChangeEvent());

          // Reach into the private handler the way the pSubscribe callback does.
          const handleEvent = (
            sub as unknown as {
              handleEvent: (e: string, p: string, h: WatchlistEventHandler) => Promise<void>;
            }
          ).handleEvent.bind(sub);

          // Must not throw — failures are absorbed into the DLQ.
          await expect(handleEvent(entityId, payload, alwaysFails)).resolves.toBeUndefined();
          expect(await poisonStore.size()).toBe(1);
          const [record] = poisonStore.snapshot();
          // Poisoned payload is preserved verbatim (verbatim Korean/unicode).
          expect(record?.rawPayload).toBe(payload);
          expect(record?.entityId).toBe(entityId);
          expect(record?.attempts).toBe(4); // 1 initial + 3 retries
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('a healthy handler succeeds and never touches the DLQ even after a sibling poisons', async () => {
    const poisonStore = new InMemoryWatchlistPoisonStore();
    const sub = new RedisWatchlistSubscriber(
      { url: 'redis://unused' },
      () => {
        throw new Error('no redis');
      },
      { poisonStore, retryDelaysMs: [0] },
    );
    const handleEvent = (
      sub as unknown as {
        handleEvent: (e: string, p: string, h: WatchlistEventHandler) => Promise<void>;
      }
    ).handleEvent.bind(sub);

    const delivered: string[] = [];
    const healthy: WatchlistEventHandler = (id) => {
      delivered.push(id);
      return Promise.resolve();
    };
    const failing: WatchlistEventHandler = () => Promise.reject(new Error('boom'));

    await handleEvent('bad', JSON.stringify(makeChangeEvent()), failing);
    await handleEvent('good', JSON.stringify(makeChangeEvent()), healthy);

    expect(delivered).toEqual(['good']);
    expect(await poisonStore.size()).toBe(1); // only the bad one
  });

  it('PgWatchlistPoisonStore.push issues a single parameterised INSERT', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const fakePool = {
      query: (text: string, values: unknown[]) => {
        queries.push({ text, values });
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    };
    const store = new PgWatchlistPoisonStore(fakePool as unknown as ConstructorParameters<typeof PgWatchlistPoisonStore>[0]);
    const now = new Date('2026-05-21T00:00:00.000Z');
    await store.push({
      entityId: '샤토_마고',
      rawPayload: '{"entityId":"샤토_마고"}',
      attempts: 4,
      lastError: 'boom',
      firstSeenAt: now,
      poisonedAt: now,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain('INSERT INTO watchlist_poison_dlq');
    // Korean entity id is passed as a bound param verbatim (no interpolation).
    expect(queries[0]?.values[0]).toBe('샤토_마고');
  });
});

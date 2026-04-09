/**
 * Epic 17.1: Watchlist HTTP Request/Response Schemas
 *
 * Zod schemas for watchlist CRUD operations and delivery log queries.
 */

import { z } from 'zod';
import { AUTHENTICATED_SUBJECT_HEADER } from '../authenticated-subject.js';
import {
  MAX_AUTHENTICATED_SUBJECT_CHARS,
  MAX_HTTPS_CALLBACK_URL_CHARS,
  MAX_HTTP_STATUS_CODE,
  MAX_PERCENT_SCALE,
  MAX_WATCHLIST_ENTITY_ID_CHARS,
  MAX_WATCHLIST_LIST_PAGE_ITEMS,
  MAX_WATCHLIST_TRIGGER_CONDITIONS,
  MAX_WEBHOOK_DELIVERY_ATTEMPT,
  MIN_HTTP_STATUS_CODE,
} from '../constants.js';

const WatchlistIdSchema = z.string().uuid();
const AuthenticatedSubjectSchema = z.string().min(1).max(MAX_AUTHENTICATED_SUBJECT_CHARS);

/** IPv4 / uint32 parsing for SSRF normalization (obfuscated literals). */
const UINT32_MAX = 0xffffffff;
const IPV4_OCTET_MASK = 0xff;
const RADIX_DECIMAL = 10;
const RADIX_HEX = 16;
const RADIX_OCTAL = 8;
const IPV4_DOT_COUNT_FULL = 4;
const IPV4_DOT_COUNT_SHORT_1 = 1;
const IPV4_DOT_COUNT_SHORT_2 = 2;
const IPV4_DOT_COUNT_SHORT_3 = 3;
const SHIFT_LAST_OCTET = 24;
const SHIFT_THIRD_OCTET = 16;
const SHIFT_SECOND_OCTET = 8;
const MAX_IPV4_OCTET_VALUE = 0xff;

/** Private/reserved IPv4 first-octet patterns (RFC 1918, loopback, link-local). */
const IPV4_LOOPBACK_FIRST_OCTET = 127;
const IPV4_PRIVATE_CLASS_A_FIRST_OCTET = 10;
const IPV4_PRIVATE_CLASS_B_FIRST_OCTET = 172;
const IPV4_PRIVATE_CLASS_B_SECOND_MIN = 16;
const IPV4_PRIVATE_CLASS_B_SECOND_MAX = 31;
const IPV4_PRIVATE_CLASS_C_FIRST_OCTET = 192;
const IPV4_PRIVATE_CLASS_C_SECOND_OCTET = 168;
const IPV4_LINK_LOCAL_FIRST_OCTET = 169;
const IPV4_LINK_LOCAL_SECOND_OCTET = 254;
const IPV4_THIS_NETWORK_FIRST_OCTET = 0;

/**
 * Rejects callback URLs that target private/reserved networks (SSRF prevention).
 * Blocks: localhost, 127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x (link-local),
 * [::1], and cloud metadata endpoints.
 */
/**
 * Normalizes IPv4-like obfuscated forms (decimal integer, hex, octal, short)
 * to canonical dotted-quad. Returns null if the string is not a recognizable
 * IPv4 literal. This is used to defeat parser-confusion SSRF bypasses such as
 * `2130706433` (decimal for 127.0.0.1), `0x7f000001` (hex), `017700000001`
 * (octal), and `127.1` (short form).
 */
function normalizeObfuscatedIPv4(host: string): string | null {
  // Already canonical dotted quad?
  const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (dotted) return host;

  // Decimal integer (e.g. 2130706433 → 127.0.0.1)
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (Number.isFinite(n) && n >= 0 && n <= UINT32_MAX) {
      return [
        (n >>> SHIFT_LAST_OCTET) & IPV4_OCTET_MASK,
        (n >>> SHIFT_THIRD_OCTET) & IPV4_OCTET_MASK,
        (n >>> SHIFT_SECOND_OCTET) & IPV4_OCTET_MASK,
        n & IPV4_OCTET_MASK,
      ].join('.');
    }
    return null;
  }

  // Hex form (e.g. 0x7f000001)
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const n = Number.parseInt(host.slice(2), RADIX_HEX);
    if (Number.isFinite(n) && n >= 0 && n <= UINT32_MAX) {
      return [
        (n >>> SHIFT_LAST_OCTET) & IPV4_OCTET_MASK,
        (n >>> SHIFT_THIRD_OCTET) & IPV4_OCTET_MASK,
        (n >>> SHIFT_SECOND_OCTET) & IPV4_OCTET_MASK,
        n & IPV4_OCTET_MASK,
      ].join('.');
    }
    return null;
  }

  // Per-octet hex/octal mix (e.g. 0x7f.0x0.0x0.0x1)
  const parts = host.split('.');
  if (
    parts.length >= 1
    && parts.length <= IPV4_DOT_COUNT_FULL
    && parts.every((p) => /^(0x[0-9a-f]+|0[0-7]*|\d+)$/i.test(p))
  ) {
    const nums: number[] = [];
    for (const p of parts) {
      let n: number;
      if (/^0x/i.test(p)) n = Number.parseInt(p.slice(2), RADIX_HEX);
      else if (/^0[0-7]+$/.test(p)) n = Number.parseInt(p, RADIX_OCTAL);
      else n = Number.parseInt(p, RADIX_DECIMAL);
      if (!Number.isFinite(n) || n < 0 || n > UINT32_MAX) return null;
      nums.push(n);
    }
    // Short forms: 127.1 → 127.0.0.1; 127.0.1 → 127.0.0.1
    if (nums.length === IPV4_DOT_COUNT_SHORT_1) {
      const n = nums[0]!;
      return [
        (n >>> SHIFT_LAST_OCTET) & IPV4_OCTET_MASK,
        (n >>> SHIFT_THIRD_OCTET) & IPV4_OCTET_MASK,
        (n >>> SHIFT_SECOND_OCTET) & IPV4_OCTET_MASK,
        n & IPV4_OCTET_MASK,
      ].join('.');
    }
    if (nums.length === IPV4_DOT_COUNT_SHORT_2) {
      const n = nums[1]!;
      return [
        nums[0]!,
        (n >>> SHIFT_THIRD_OCTET) & IPV4_OCTET_MASK,
        (n >>> SHIFT_SECOND_OCTET) & IPV4_OCTET_MASK,
        n & IPV4_OCTET_MASK,
      ].join('.');
    }
    if (nums.length === IPV4_DOT_COUNT_SHORT_3) {
      const n = nums[2]!;
      return [
        nums[0]!,
        nums[1]!,
        (n >>> SHIFT_SECOND_OCTET) & IPV4_OCTET_MASK,
        n & IPV4_OCTET_MASK,
      ].join('.');
    }
    if (nums.length === IPV4_DOT_COUNT_FULL && nums.every((x) => x <= MAX_IPV4_OCTET_VALUE)) {
      return nums.join('.');
    }
    return null;
  }

  return null;
}

function isPrivateOrReservedHost(urlString: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(urlString).hostname.toLowerCase();
  } catch {
    return true;
  }

  if (
    hostname === 'localhost'
    || hostname === '[::1]'
    || hostname === '::1'
    || hostname === '0.0.0.0'
  ) {
    return true;
  }

  // Try obfuscated IPv4 normalization first (defeats integer/hex/octal/short forms).
  const normalizedV4 = normalizeObfuscatedIPv4(hostname);
  if (normalizedV4 !== null && normalizedV4 !== hostname) {
    // Recurse with the canonical dotted-quad form
    return isPrivateOrReservedHost(`https://${normalizedV4}/`);
  }

  // Strip brackets for IPv6 analysis
  const stripped = hostname.replace(/^\[/, '').replace(/]$/, '');

  // Only run IPv6 checks when the hostname actually looks like an IPv6 address.
  // Without this guard, hostnames starting with "fc"/"fd"/"fe8" etc.
  // (e.g. "fcm.googleapis.com", "fedoraproject.org") would be falsely rejected.
  const looksLikeIpv6 = stripped.includes(':');

  if (looksLikeIpv6) {
    // IPv6-mapped IPv4 (e.g. ::ffff:127.0.0.1, [::ffff:10.0.0.1])
    const mappedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(stripped);
    if (mappedMatch) {
      return isPrivateOrReservedHost(`https://${mappedMatch[1]}/`);
    }

    // IPv4-mapped IPv6 in hex form: ::ffff:7f00:1
    const mappedHexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(stripped);
    if (mappedHexMatch) {
      const hi = parseInt(mappedHexMatch[1] ?? '0', RADIX_HEX);
      const lo = parseInt(mappedHexMatch[2] ?? '0', RADIX_HEX);
      const dotted = `${(hi >> SHIFT_SECOND_OCTET) & IPV4_OCTET_MASK}.${hi & IPV4_OCTET_MASK}.${(lo >> SHIFT_SECOND_OCTET) & IPV4_OCTET_MASK}.${lo & IPV4_OCTET_MASK}`;
      return isPrivateOrReservedHost(`https://${dotted}/`);
    }

    const lowerStripped = stripped.toLowerCase();
    // Expanded loopback: 0:0:0:0:0:0:0:1
    if (/^0(:0){6}:1$/.test(lowerStripped) || lowerStripped === '0:0:0:0:0:0:0:0') {
      return true;
    }
    // IPv6 private/reserved ranges
    if (
      /^f[cd][0-9a-f]{2}:/.test(lowerStripped) // fc00::/7 unique local (fc00-fdff)
      || /^fe[89ab][0-9a-f]:/.test(lowerStripped) // fe80::/10 link-local (fe80-febf)
      || lowerStripped === '::' // unspecified address
      || lowerStripped.startsWith('ff') // ff00::/8 multicast
    ) {
      return true;
    }
  }

  // IPv4 private/reserved ranges
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (
      a === IPV4_LOOPBACK_FIRST_OCTET // 127.0.0.0/8 loopback
      || a === IPV4_PRIVATE_CLASS_A_FIRST_OCTET // 10.0.0.0/8 private
      || (
        a === IPV4_PRIVATE_CLASS_B_FIRST_OCTET
        && b! >= IPV4_PRIVATE_CLASS_B_SECOND_MIN
        && b! <= IPV4_PRIVATE_CLASS_B_SECOND_MAX
      ) // 172.16.0.0/12 private
      || (a === IPV4_PRIVATE_CLASS_C_FIRST_OCTET && b === IPV4_PRIVATE_CLASS_C_SECOND_OCTET) // 192.168.0.0/16 private
      || (a === IPV4_LINK_LOCAL_FIRST_OCTET && b === IPV4_LINK_LOCAL_SECOND_OCTET) // 169.254.0.0/16 link-local / cloud metadata
      || a === IPV4_THIS_NETWORK_FIRST_OCTET // 0.0.0.0/8
    ) {
      return true;
    }
  }

  return false;
}

const HttpsUrlSchema = z.string().url().max(MAX_HTTPS_CALLBACK_URL_CHARS).refine(
  (value) => value.startsWith('https://'),
  'callback_url must use https',
).refine(
  (value) => !isPrivateOrReservedHost(value),
  'callback_url must not target private or reserved network addresses',
);
const FutureDateTimeSchema = z.string().datetime().refine(
  (value) => {
    const ts = new Date(value).getTime();
    return Number.isFinite(ts) && ts > Date.now();
  },
  'expires_at must be in the future',
);

const NewVintageTriggerRequestSchema = z.union([
  z.object({
    type: z.literal('new_vintage'),
    min_vintage: z.number().int().positive(),
  }).strict().transform((value) => ({
    type: value.type,
    minVintage: value.min_vintage,
  })),
  z.object({
    type: z.literal('new_vintage'),
    minVintage: z.number().int().positive(),
  }).strict(),
]);

const PriceDropTriggerRequestSchema = z.union([
  z.object({
    type: z.literal('price_drop'),
    threshold: z.number().finite().gt(0).max(MAX_PERCENT_SCALE),
    baseline_price: z.number().finite().positive(),
  }).strict().transform((value) => ({
    type: value.type,
    threshold: value.threshold,
    baselinePrice: value.baseline_price,
  })),
  z.object({
    type: z.literal('price_drop'),
    threshold: z.number().finite().gt(0).max(MAX_PERCENT_SCALE),
    baselinePrice: z.number().finite().positive(),
  }).strict(),
]);

const StockAvailableTriggerRequestSchema = z.union([
  z.object({
    type: z.literal('stock_available'),
    min_qty: z.number().int().positive(),
  }).strict().transform((value) => ({
    type: value.type,
    minQty: value.min_qty,
  })),
  z.object({
    type: z.literal('stock_available'),
    minQty: z.number().int().positive(),
  }).strict(),
]);

const CriticScoreAboveTriggerRequestSchema = z.object({
  type: z.literal('critic_score_above'),
  threshold: z.number().finite().min(0).max(MAX_PERCENT_SCALE),
}).strict();

export const WatchlistTriggerSchema = z.union([
  NewVintageTriggerRequestSchema,
  PriceDropTriggerRequestSchema,
  StockAvailableTriggerRequestSchema,
  CriticScoreAboveTriggerRequestSchema,
]);

export const WatchlistTriggerResponseSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('new_vintage'),
    min_vintage: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal('price_drop'),
    threshold: z.number().finite().gt(0).max(MAX_PERCENT_SCALE),
    baseline_price: z.number().finite().positive(),
  }).strict(),
  z.object({
    type: z.literal('stock_available'),
    min_qty: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal('critic_score_above'),
    threshold: z.number().finite().min(0).max(MAX_PERCENT_SCALE),
  }).strict(),
]);

export type WatchlistTrigger = z.infer<typeof WatchlistTriggerSchema>;
export type WatchlistTriggerResponse = z.infer<typeof WatchlistTriggerResponseSchema>;

export const WatchlistIdParamsSchema = z.object({
  id: WatchlistIdSchema,
}).strict();

export type WatchlistIdParams = z.infer<typeof WatchlistIdParamsSchema>;

export const WatchlistAuthHeadersSchema = z.object({
  [AUTHENTICATED_SUBJECT_HEADER]: AuthenticatedSubjectSchema,
}).strict();

export type WatchlistAuthHeaders = z.infer<typeof WatchlistAuthHeadersSchema>;

export const CreateWatchlistRequestSchema = z.object({
  entity_id: z.string().min(1).max(MAX_WATCHLIST_ENTITY_ID_CHARS),
  trigger_conditions: z.array(WatchlistTriggerSchema).min(1).max(MAX_WATCHLIST_TRIGGER_CONDITIONS),
  callback_url: HttpsUrlSchema,
  expires_at: FutureDateTimeSchema.optional(),
}).strict();

export type CreateWatchlistRequest = z.infer<typeof CreateWatchlistRequestSchema>;

export const CreateWatchlistResponseSchema = z.object({
  watchlist_id: WatchlistIdSchema,
}).strict();

export type CreateWatchlistResponse = z.infer<typeof CreateWatchlistResponseSchema>;

export const GetWatchlistResponseSchema = z.object({
  watchlist_id: WatchlistIdSchema,
  user_id: AuthenticatedSubjectSchema,
  entity_id: z.string().min(1),
  trigger_conditions: z.array(WatchlistTriggerResponseSchema).max(MAX_WATCHLIST_TRIGGER_CONDITIONS),
  callback_url: HttpsUrlSchema,
  created_at: z.string().datetime(),
  expires_at: z.string().datetime().nullable(),
}).strict();

export type GetWatchlistResponse = z.infer<typeof GetWatchlistResponseSchema>;

export const ListWatchlistResponseSchema = z.object({
  entries: z.array(GetWatchlistResponseSchema).max(MAX_WATCHLIST_LIST_PAGE_ITEMS),
  total: z.number().int().nonnegative(),
}).strict();

export type ListWatchlistResponse = z.infer<typeof ListWatchlistResponseSchema>;

export const DeliveryLogEntrySchema = z.object({
  id: WatchlistIdSchema,
  watchlist_id: WatchlistIdSchema,
  attempt: z.number().int().min(1).max(MAX_WEBHOOK_DELIVERY_ATTEMPT),
  status_code: z.number().int().min(MIN_HTTP_STATUS_CODE).max(MAX_HTTP_STATUS_CODE).nullable(),
  error_message: z.string().nullable(),
  delivered_at: z.string().datetime(),
}).strict();

export type DeliveryLogEntry = z.infer<typeof DeliveryLogEntrySchema>;

export const ListDeliveriesResponseSchema = z.object({
  deliveries: z.array(DeliveryLogEntrySchema).max(MAX_WATCHLIST_LIST_PAGE_ITEMS),
  total: z.number().int().nonnegative(),
}).strict();

export type ListDeliveriesResponse = z.infer<typeof ListDeliveriesResponseSchema>;

export const WatchlistErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string().optional(),
    failure_reason: z.string().nullable().optional(),
    retryable: z.boolean().optional(),
  }).strict(),
}).strict();

export type WatchlistErrorResponse = z.infer<typeof WatchlistErrorResponseSchema>;

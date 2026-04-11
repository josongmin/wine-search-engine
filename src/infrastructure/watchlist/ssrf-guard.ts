/**
 * SSRF guard: IP-range rejection for webhook callback URLs.
 *
 * Shared between webhook-delivery.ts (delivery-time DNS rebinding check)
 * and watchlist.route.ts (creation-time pre-validation).  Extracting to a
 * shared module ensures both sites use identical logic and cannot drift.
 *
 * RFC-014 / Epic 17.1: defence-in-depth — check at both create and deliver
 * time so that a DNS-rebinding attack (public hostname → internal IP after TTL)
 * is blocked at creation *and* at each delivery attempt.
 */

import { toFiniteNumber } from '../../domain/shared/utils/safe-number.js';

/** Private/reserved IPv4 first-octet / pair patterns (SSRF guard). */
const IPV4_LOOPBACK_FIRST_OCTET = 127;
const IPV4_PRIVATE_CLASS_A_FIRST_OCTET = 10;
const IPV4_THIS_NETWORK_FIRST_OCTET = 0;
const IPV4_PRIVATE_CLASS_B_FIRST_OCTET = 172;
const IPV4_PRIVATE_CLASS_B_SECOND_MIN = 16;
const IPV4_PRIVATE_CLASS_B_SECOND_MAX = 31;
const IPV4_PRIVATE_CLASS_C_FIRST_OCTET = 192;
const IPV4_PRIVATE_CLASS_C_SECOND_OCTET = 168;
const IPV4_LINK_LOCAL_FIRST_OCTET = 169;
const IPV4_LINK_LOCAL_SECOND_OCTET = 254;

/**
 * Returns true if the given resolved IP address is private/reserved/loopback
 * and should be rejected as a webhook callback destination.
 *
 * Defends against DNS rebinding where a public hostname check passes at
 * creation time but DNS later returns an internal address (cloud metadata,
 * RFC1918, link-local, loopback).
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  // IPv4
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    // The regex guarantees 1-3 digit strings; toFiniteNumber so semgrep
    // wine-number-without-finite-guard does not flag this code path.
    const a = toFiniteNumber(v4[1]);
    const b = toFiniteNumber(v4[2]);
    if (a === null || b === null) return false;
    return (
      a === IPV4_LOOPBACK_FIRST_OCTET
      || a === IPV4_PRIVATE_CLASS_A_FIRST_OCTET
      || a === IPV4_THIS_NETWORK_FIRST_OCTET
      || (
        a === IPV4_PRIVATE_CLASS_B_FIRST_OCTET
        && b >= IPV4_PRIVATE_CLASS_B_SECOND_MIN
        && b <= IPV4_PRIVATE_CLASS_B_SECOND_MAX
      )
      || (a === IPV4_PRIVATE_CLASS_C_FIRST_OCTET && b === IPV4_PRIVATE_CLASS_C_SECOND_OCTET)
      || (a === IPV4_LINK_LOCAL_FIRST_OCTET && b === IPV4_LINK_LOCAL_SECOND_OCTET)
    );
  }
  // IPv6 (collapsed forms accepted; check well-known prefixes)
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(lower)) return true; // link-local fe80::/10
  if (lower.startsWith('ff')) return true;   // multicast
  // IPv4-mapped IPv6
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped) return isPrivateOrReservedIp(mapped[1]!);
  return false;
}

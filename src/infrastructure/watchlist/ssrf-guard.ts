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

/** Radix/bound constants for IPv4 octet decoding (decimal/octal/hex literals). */
const OCTET_MAX = 255;
const IPV4_OCTET_COUNT = 4;
const IPV4_UINT32_MAX = 0xff_ff_ff_ff;
const RADIX_OCTAL = 8;
const RADIX_DECIMAL = 10;
const RADIX_HEX = 16;
const BYTE_BITS = 8;

/**
 * True iff the four canonical octets (each 0-255) describe a
 * private/reserved/loopback IPv4 address per RFC1918 + loopback + link-local
 * + "this network".
 */
function octetsArePrivateOrReserved(a: number, b: number): boolean {
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

/**
 * Parse a single IPv4 component (octet OR a whole-address integer literal)
 * honouring the C/inet_aton encodings an attacker can use to smuggle a
 * private address past a naive dotted-decimal-only check:
 *   - hex:     0x7f, 0X7F000001
 *   - octal:   0177 (leading zero), 017700000001
 *   - decimal: 127, 2130706433
 * Returns the numeric value, or null if the component is not a valid literal.
 */
function parseIpv4Component(part: string): number | null {
  if (part.length === 0) return null;
  let radix = RADIX_DECIMAL;
  let digits = part;
  const lower = part.toLowerCase();
  if (lower.startsWith('0x')) {
    radix = RADIX_HEX;
    digits = lower.slice(2);
    if (!/^[0-9a-f]+$/.test(digits)) return null;
  } else if (part.length > 1 && part.startsWith('0')) {
    radix = RADIX_OCTAL;
    digits = part.slice(1);
    if (!/^[0-7]+$/.test(digits)) return null;
  } else {
    if (!/^[0-9]+$/.test(part)) return null;
  }
  const n = parseInt(digits, radix);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise any IPv4 literal (1-4 components, any radix) to four canonical
 * octets, mirroring inet_aton semantics:
 *   - 4 parts: a.b.c.d           (each must be 0-255)
 *   - 3 parts: a.b.(c)           (last spans 16 bits)
 *   - 2 parts: a.(b)             (last spans 24 bits)
 *   - 1 part:  (n)               (whole 32-bit address)
 * Returns [a,b,c,d] or null if the literal is invalid / out of range.
 */
function normalizeIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length === 0 || parts.length > IPV4_OCTET_COUNT) return null;

  const values: number[] = [];
  for (const part of parts) {
    const v = parseIpv4Component(part);
    if (v === null || v < 0) return null;
    values.push(v);
  }

  // Every component except the final one must fit in a single octet.
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i]! > OCTET_MAX) return null;
  }

  const last = values[values.length - 1]!;
  const restOctets = IPV4_OCTET_COUNT - (values.length - 1);
  const maxLast = restOctets >= IPV4_OCTET_COUNT ? IPV4_UINT32_MAX : (2 ** (restOctets * BYTE_BITS)) - 1;
  if (last > maxLast) return null;

  // Assemble the canonical 32-bit address.
  const octets: number[] = [];
  for (let i = 0; i < values.length - 1; i++) octets.push(values[i]!);
  // Spread the final component across the remaining octets, big-endian.
  for (let shift = (restOctets - 1) * BYTE_BITS; shift >= 0; shift -= BYTE_BITS) {
    octets.push(Math.floor(last / 2 ** shift) % (OCTET_MAX + 1));
  }
  if (octets.length !== IPV4_OCTET_COUNT) return null;
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/**
 * Returns true if the given resolved IP address is private/reserved/loopback
 * and should be rejected as a webhook callback destination.
 *
 * Defends against DNS rebinding where a public hostname check passes at
 * creation time but DNS later returns an internal address (cloud metadata,
 * RFC1918, link-local, loopback). Also defends — as defence-in-depth on this
 * SSoT — against IPv4 encoding bypasses (decimal/octal/hex inet_aton forms)
 * that smuggle a private address past a dotted-decimal-only check.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  // IPv4 (any inet_aton encoding: dotted decimal/octal/hex, or whole-integer).
  const octets = normalizeIpv4(ip);
  if (octets !== null) {
    return octetsArePrivateOrReserved(octets[0], octets[1]);
  }
  const lower = ip.toLowerCase();
  // Only run IPv6 prefix checks when the input is actually IPv6-shaped.
  // Without this guard, public hostnames like "fca.a.aa" or
  // "fedoraproject.org" are misclassified as private because they begin with
  // fc/fd/fe even though they are not IP literals.
  if (!lower.includes(':')) return false;
  // IPv6 (collapsed forms accepted; check well-known prefixes)
  if (lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // Link-local fe80::/10 AND site-local fec0::/10 (deprecated but still
  // reachable): the /10 covers fe80–febf, i.e. the 'fe' high byte with the
  // top two bits of the next nibble set → nibble in {8,9,a,b,c,d,e,f}.
  if (/^fe[89abcdef]/.test(lower)) return true;
  if (lower.startsWith('ff')) return true;   // multicast
  // IPv4-mapped IPv6
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped) return isPrivateOrReservedIp(mapped[1]!);
  return false;
}

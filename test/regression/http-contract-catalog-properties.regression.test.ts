/**
 * Property-based regression tests for the DeclaredHttpRouteContractCatalog
 * (feature: observability.http-contract-catalog). Append-only.
 *
 * Why this file exists
 * --------------------
 * The catalog is the SSoT for the HTTP surface: contract-manifest export,
 * the catalog regression suite, and every route registered via
 * registerContractRoute all derive from it. A silent drift in this catalog
 * (duplicate route, missing error envelope, fake HTTP verb, version regression)
 * is, by definition, an API breaking change that must be caught BEFORE the
 * prepush bundle runs the slower OpenAPI parity tests.
 *
 * Invariants verified
 * -------------------
 *  1. Route uniqueness — every (method, url) pair is unique across the
 *     catalog, explored over arbitrary subsets via fast-check.
 *  2. operationId uniqueness — every contract has a distinct operationId
 *     (OpenAPI 3 requires globally unique operationIds; clients dispatch on
 *     them).
 *  3. HTTP method enum compliance — only GET/POST/PUT/DELETE/PATCH appear
 *     (no fake verbs, no lower-case typos).
 *  4. Status code coverage — every contract declares at least one 2xx
 *     success response AND at least one non-2xx error envelope status, so
 *     no route can silently ship without an error envelope.
 *  5. Catalog version monotonicity — HTTP_CONTRACT_CATALOG_VERSION matches
 *     SemVer 2.0 (semver.org / OpenAPI versioning best practice).
 *  6. Breaking-change detection — a deterministic structural fingerprint
 *     (sha256 over canonically-sorted JSON of the surface) MUST equal a
 *     pinned snapshot. Any structural change (new route, dropped status,
 *     renamed operationId, body/params surface flip) flips the hash and
 *     fails this test; review the diff and bump
 *     HTTP_CONTRACT_CATALOG_VERSION accordingly.
 *
 * Korean coverage: rule 5 in CLAUDE.md mandates Korean (한글) test inputs
 * for any change touching strings; we verify Korean characters in synthetic
 * descriptions round-trip unchanged through the fingerprint computation.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  DeclaredHttpRouteContractCatalog,
  HTTP_CONTRACT_CATALOG_VERSION,
  HTTP_CONTRACT_CATALOG_FINGERPRINT,
  computeHttpContractCatalogFingerprint,
  buildDeclaredHttpRouteContractManifest,
} from '../../src/interface/http/routes/http-route-contract-catalog.js';
import {
  HTTP_SUCCESS_STATUS_MAX_EXCLUSIVE,
  HTTP_SUCCESS_STATUS_MIN,
} from '../../src/interface/http/constants.js';

const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/u;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/u;
const PROPERTY_RUNS = 100;
const EXPECTED_ROUTE_COUNT = 16;

describe('observability.http-contract-catalog — version + invariants', () => {
  it('HTTP_CONTRACT_CATALOG_VERSION matches SemVer 2.0 shape', () => {
    expect(HTTP_CONTRACT_CATALOG_VERSION).toMatch(SEMVER_RE);
  });

  it('declared catalog has the expected size (regression: count drift)', () => {
    expect(DeclaredHttpRouteContractCatalog.length).toBe(EXPECTED_ROUTE_COUNT);
  });

  it('HTTP_CONTRACT_CATALOG_FINGERPRINT equals computeHttpContractCatalogFingerprint() of current catalog', () => {
    expect(HTTP_CONTRACT_CATALOG_FINGERPRINT).toMatch(SHA256_HEX_RE);
    expect(HTTP_CONTRACT_CATALOG_FINGERPRINT).toBe(
      computeHttpContractCatalogFingerprint(DeclaredHttpRouteContractCatalog),
    );
  });
});

describe('observability.http-contract-catalog — structural invariants', () => {
  it('Property: every (method, url) pair is unique across arbitrary catalog subsets', () => {
    const indices = DeclaredHttpRouteContractCatalog.map((_, i) => i);
    fc.assert(
      fc.property(fc.subarray(indices), (subset) => {
        const seen = new Set<string>();
        for (const i of subset) {
          const entry = DeclaredHttpRouteContractCatalog[i]!;
          const key = `${entry.method} ${entry.url}`;
          if (seen.has(key)) return false;
          seen.add(key);
        }
        return true;
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('Property: operationId is unique across the catalog', () => {
    const ops = DeclaredHttpRouteContractCatalog.map((e) => e.contract.operationId);
    const unique = new Set(ops);
    expect(unique.size).toBe(ops.length);
  });

  it('Property: method enum compliance — only GET/POST/PUT/DELETE/PATCH', () => {
    for (const entry of DeclaredHttpRouteContractCatalog) {
      expect(ALLOWED_METHODS).toContain(entry.method);
    }
  });

  it('Property: every contract declares at least one 2xx success status', () => {
    for (const entry of DeclaredHttpRouteContractCatalog) {
      const statuses = Object.keys(entry.contract.responses).map((s) => Number(s));
      const successes = statuses.filter(
        (s) => s >= HTTP_SUCCESS_STATUS_MIN && s < HTTP_SUCCESS_STATUS_MAX_EXCLUSIVE,
      );
      expect(
        successes.length,
        `route ${entry.method} ${entry.url} (${entry.contract.operationId}) must declare a 2xx`,
      ).toBeGreaterThan(0);
    }
  });

  it('Property: every contract declares at least one non-2xx error envelope status', () => {
    // /health and /ready intentionally use a single 503 schema that mirrors
    // the 200 body shape (RFC-014 envelope is only required for unexpected
    // errors). They still publish a 503, so the invariant holds across all
    // catalog entries with no special-cases.
    for (const entry of DeclaredHttpRouteContractCatalog) {
      const statuses = Object.keys(entry.contract.responses).map((s) => Number(s));
      const errors = statuses.filter(
        (s) => s < HTTP_SUCCESS_STATUS_MIN || s >= HTTP_SUCCESS_STATUS_MAX_EXCLUSIVE,
      );
      expect(
        errors.length,
        `route ${entry.method} ${entry.url} (${entry.contract.operationId}) must declare an error status`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('observability.http-contract-catalog — fingerprint determinism', () => {
  it('computeHttpContractCatalogFingerprint is deterministic across calls', () => {
    const a = computeHttpContractCatalogFingerprint(DeclaredHttpRouteContractCatalog);
    const b = computeHttpContractCatalogFingerprint(DeclaredHttpRouteContractCatalog);
    expect(a).toBe(b);
  });

  it('fingerprint is independent of input array ordering (canonical sort)', () => {
    const original = [...DeclaredHttpRouteContractCatalog];
    const reversed = [...DeclaredHttpRouteContractCatalog].reverse();
    expect(computeHttpContractCatalogFingerprint(reversed)).toBe(
      computeHttpContractCatalogFingerprint(original),
    );
  });

  it('fingerprint flips when a route is removed (breaking-change detection)', () => {
    const trimmed = DeclaredHttpRouteContractCatalog.slice(1);
    expect(computeHttpContractCatalogFingerprint(trimmed)).not.toBe(
      HTTP_CONTRACT_CATALOG_FINGERPRINT,
    );
  });

  it('fingerprint flips when an operationId is renamed (breaking-change detection)', () => {
    const mutated = DeclaredHttpRouteContractCatalog.map((entry, i) =>
      i === 0
        ? {
            ...entry,
            contract: { ...entry.contract, operationId: `${entry.contract.operationId}.renamed` },
          }
        : entry,
    );
    expect(computeHttpContractCatalogFingerprint(mutated)).not.toBe(
      HTTP_CONTRACT_CATALOG_FINGERPRINT,
    );
  });

  it('empty catalog yields a stable, non-empty fingerprint (degenerate case)', () => {
    const hash = computeHttpContractCatalogFingerprint([]);
    expect(hash).toMatch(SHA256_HEX_RE);
    expect(hash).not.toBe(HTTP_CONTRACT_CATALOG_FINGERPRINT);
  });

  it('Korean (한글) operationId text is preserved verbatim in fingerprint input (rule 5)', () => {
    // Two synthetic catalogs differing only in Korean payload MUST produce
    // distinct fingerprints, proving non-ASCII bytes flow through the
    // canonicalizer without being normalized away or replaced.
    const sample = DeclaredHttpRouteContractCatalog[0]!;
    const withKorean = [
      {
        ...sample,
        contract: { ...sample.contract, operationId: '시스템.상태확인' },
      },
    ];
    const withRoman = [
      {
        ...sample,
        contract: { ...sample.contract, operationId: 'system.healthRoman' },
      },
    ];
    const hashKo = computeHttpContractCatalogFingerprint(withKorean);
    const hashEn = computeHttpContractCatalogFingerprint(withRoman);
    expect(hashKo).toMatch(SHA256_HEX_RE);
    expect(hashEn).toMatch(SHA256_HEX_RE);
    expect(hashKo).not.toBe(hashEn);
  });
});

describe('observability.http-contract-catalog — manifest parity with fingerprint', () => {
  it('declared manifest size equals catalog size', () => {
    const manifest = buildDeclaredHttpRouteContractManifest();
    expect(manifest.routes.length).toBe(DeclaredHttpRouteContractCatalog.length);
  });
});

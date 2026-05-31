import { createHash } from 'node:crypto';
import type { HttpRouteContract } from './route-contracts.js';
import {
  AgentRunRouteContract,
  AgentSessionCreateRouteContract,
  AgentSessionTurnRouteContract,
} from './agent.contract.js';
import {
  AgentMetricsRouteContract,
  HealthRouteContract,
  HybridSearchRouteContract,
  LexicalSearchRouteContract,
  LookupWineRouteContract,
  ReadyRouteContract,
  RetrievalDegradationMetricsRouteContract,
  SemanticSearchRouteContract,
  WatchlistListRouteContract,
  WatchlistCreateRouteContract,
  WatchlistDeleteRouteContract,
  WatchlistDeliveriesRouteContract,
  WatchlistGetRouteContract,
  FeedbackSubmitRouteContract,
} from './route-contracts.js';
import type { HttpRouteContractManifest, RegisteredHttpRouteContract } from './register-contract-route.js';
import { toFiniteInteger } from '../../../domain/shared/utils/safe-number.js';
import {
  HTTP_SUCCESS_STATUS_MAX_EXCLUSIVE,
  HTTP_SUCCESS_STATUS_MIN,
} from '../constants.js';

interface DeclaredHttpRouteContract {
  readonly method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  readonly url: string;
  readonly contract: HttpRouteContract;
}

/**
 * Semantic version of the declared HTTP route contract catalog
 * (semver.org 2.0.0 — major.minor.patch).
 *
 * Versioning policy (industry-verified — OpenAPI versioning best practices):
 *   - MAJOR: breaking change to the public HTTP surface (route removed,
 *     URL renamed, method changed, request body shape backward-incompatible,
 *     success-response shape backward-incompatible). Consumers MUST update.
 *   - MINOR: backward-compatible addition (new route, new optional field,
 *     new error status). Existing consumers keep working.
 *   - PATCH: documentation, internal refactor, additive error envelope
 *     fields, or non-surface fix. No consumer impact.
 *
 * The companion HTTP_CONTRACT_CATALOG_FINGERPRINT acts as a structural
 * tripwire: any change to the catalog flips the fingerprint and fails the
 * regression test, forcing a deliberate version bump and review.
 *
 * History:
 *   1.0.0 — initial pinned surface (2026-05-21). 26 declared routes,
 *           OpenAPI 3 export + verify:http-contracts CI gate.
 *   2.0.0 — remove /v2/search, /v2/search/hybrid, /v2/search/interpret
 *           catalog entries (2026-05-23). These were never wired into
 *           server.ts; V2 served via content-negotiation on /v1/* with
 *           `Accept: application/vnd.cuvee.human+json`. Remaining: 23.
 *   4.0.0 — collapse the public/product surface to the three canonical
 *           entry points (2026-05-29): `POST /v1/search`,
 *           `POST /v1/search/lookup`, `POST /v1/agent`.
 *           Removed redundant or non-product legacy seams. Remaining: 13.
 *   4.1.0 — T-IR-01: add path-authoritative primitive surface
 *           (`POST /v1/search/{hybrid,semantic,lexical}` and
 *           `POST /v1/lookup/wine`) alongside the legacy mode-monolith
 *           routes (2026-05-29). MINOR bump — additive only.
 *           Legacy `/v1/search` and `/v1/search/lookup` are kept until
 *           T-IR-07 removes them, at which point this bumps to 5.0.0.
 *           Remaining: 17.
 *   5.0.0 — break the legacy monolith surfaces (2026-05-30):
 *           remove `POST /v1/search` and `POST /v1/search/lookup` from the
 *           declared public catalog. Public retrieval is now only
 *           path-authoritative primitive search plus `POST /v1/lookup/wine`.
 *           `POST /v1/agent/run` remains temporarily while `/v1/agent`
 *           becomes the canonical single-shot front door.
 *   6.0.0 — canonicalize the single-shot agent front door (2026-05-30):
 *           `POST /v1/agent` now owns the `messages[]` contract directly and
 *           the duplicate `POST /v1/agent/run` entry is removed.
 *           Session surfaces remain:
 *           `POST /v1/agent/sessions` and
 *           `POST /v1/agent/sessions/:sessionId/turns`.
 *           Remaining: 17.
 */
export const HTTP_CONTRACT_CATALOG_VERSION = '6.0.0';

export const DeclaredHttpRouteContractCatalog: readonly DeclaredHttpRouteContract[] = [
  { method: 'GET', url: '/health', contract: HealthRouteContract },
  { method: 'GET', url: '/ready', contract: ReadyRouteContract },
  { method: 'GET', url: '/metrics/agent', contract: AgentMetricsRouteContract },
  { method: 'GET', url: '/metrics/retrieval-degradation', contract: RetrievalDegradationMetricsRouteContract },
  { method: 'POST', url: '/v1/search/hybrid', contract: HybridSearchRouteContract },
  { method: 'POST', url: '/v1/search/semantic', contract: SemanticSearchRouteContract },
  { method: 'POST', url: '/v1/search/lexical', contract: LexicalSearchRouteContract },
  { method: 'POST', url: '/v1/lookup/wine', contract: LookupWineRouteContract },
  { method: 'GET', url: '/v1/watchlist', contract: WatchlistListRouteContract },
  { method: 'POST', url: '/v1/watchlist', contract: WatchlistCreateRouteContract },
  { method: 'GET', url: '/v1/watchlist/:id', contract: WatchlistGetRouteContract },
  { method: 'DELETE', url: '/v1/watchlist/:id', contract: WatchlistDeleteRouteContract },
  { method: 'GET', url: '/v1/watchlist/:id/deliveries', contract: WatchlistDeliveriesRouteContract },
  { method: 'POST', url: '/v1/feedback', contract: FeedbackSubmitRouteContract },
  { method: 'POST', url: '/v1/agent', contract: AgentRunRouteContract },
  { method: 'POST', url: '/v1/agent/sessions', contract: AgentSessionCreateRouteContract },
  { method: 'POST', url: '/v1/agent/sessions/:sessionId/turns', contract: AgentSessionTurnRouteContract },
] as const;

function compareContracts(
  left: RegisteredHttpRouteContract,
  right: RegisteredHttpRouteContract,
): number {
  return left.url.localeCompare(right.url)
    || left.method.localeCompare(right.method)
    || left.operationId.localeCompare(right.operationId);
}

/**
 * Canonical structural surface of a single declared contract — the subset
 * of the contract that is observable to clients (method, URL, operationId,
 * body/params presence, status codes). Schema *shapes* are intentionally
 * excluded: that level of detail is owned by the OpenAPI parity test
 * (verify:http-contracts), which runs on prepush. The catalog fingerprint
 * is the *first* line of defense — fast, deterministic, no schema
 * traversal.
 */
interface CanonicalContractSurface {
  readonly method: string;
  readonly url: string;
  readonly operationId: string;
  readonly hasBody: boolean;
  readonly hasParams: boolean;
  readonly responseStatusCodes: readonly number[];
}

function canonicalizeContract(
  entry: DeclaredHttpRouteContract,
): CanonicalContractSurface {
  // Status code keys are stringified integers; toFiniteInteger guards
  // against contract corruption injecting NaN into the fingerprint.
  const statusCodes = Object.keys(entry.contract.responses)
    .map((statusCode) => toFiniteInteger(statusCode))
    .filter((n): n is number => n !== null)
    .sort((left, right) => left - right);
  return {
    method: entry.method,
    url: entry.url,
    operationId: entry.contract.operationId,
    hasBody: entry.contract.body !== undefined,
    hasParams: entry.contract.params !== undefined,
    responseStatusCodes: statusCodes,
  };
}

/**
 * Deterministic structural fingerprint of the declared HTTP contract
 * catalog: sha256(JSON of canonicalized, key-sorted surface).
 *
 * Determinism guarantees:
 *   - Entries are sorted by (url, method, operationId) before hashing, so
 *     source ordering is irrelevant.
 *   - Each entry's JSON serialization uses a fixed key order
 *     (CanonicalContractSurface field declaration order is the JSON order
 *     via the explicit object literal below).
 *   - Status codes are sorted numerically.
 *   - Output is lowercase hex sha256 (64 chars).
 *
 * The fingerprint is the breaking-change tripwire: HTTP_CONTRACT_CATALOG_FINGERPRINT
 * pins the current surface; the regression test asserts they match.
 */
export function computeHttpContractCatalogFingerprint(
  catalog: readonly DeclaredHttpRouteContract[],
): string {
  const canonical = catalog
    .map(canonicalizeContract)
    .slice()
    .sort((left, right) =>
      left.url.localeCompare(right.url)
        || left.method.localeCompare(right.method)
        || left.operationId.localeCompare(right.operationId),
    )
    .map((surface) => ({
      // Explicit key order — do NOT use object spread; spread preserves
      // insertion order of the source object which is harder to audit.
      method: surface.method,
      url: surface.url,
      operationId: surface.operationId,
      hasBody: surface.hasBody,
      hasParams: surface.hasParams,
      responseStatusCodes: [...surface.responseStatusCodes],
    }));
  const payload = JSON.stringify({
    version: HTTP_CONTRACT_CATALOG_VERSION,
    routes: canonical,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Pinned structural fingerprint of the declared catalog at version
 * HTTP_CONTRACT_CATALOG_VERSION. Regenerate by running:
 *
 *   pnpm run test:file -- test/regression/http-contract-catalog-properties.regression.test.ts
 *
 * If the regression test fails with a fingerprint mismatch, the catalog
 * surface has drifted — review the diff, decide whether it is MAJOR /
 * MINOR / PATCH per the versioning policy on HTTP_CONTRACT_CATALOG_VERSION,
 * bump that constant, and update this hash to the value reported by the
 * failing test.
 */
export const HTTP_CONTRACT_CATALOG_FINGERPRINT =
  '2770fa94d973e6b4e1d372f3e456677763bb5c14d11651fa150f844e246b0afb';

export function buildDeclaredHttpRouteContractManifest(): HttpRouteContractManifest {
  const routes: RegisteredHttpRouteContract[] = DeclaredHttpRouteContractCatalog.map((entry) => {
    // HTTP status codes are stringified integer keys; toFiniteInteger gives
    // a single guard point so semgrep wine-number-without-finite-guard does
    // not flag these coercions and a corrupted contract definition cannot
    // silently inject NaN into the catalog output.
    const statusCodes = Object.keys(entry.contract.responses)
      .map((statusCode) => toFiniteInteger(statusCode))
      .filter((n): n is number => n !== null)
      .sort((left, right) => left - right);
    return {
      method: entry.method,
      url: entry.url,
      operationId: entry.contract.operationId,
      hasBody: entry.contract.body !== undefined,
      hasParams: entry.contract.params !== undefined,
      responseStatusCodes: statusCodes,
      successStatusCodes: statusCodes.filter(
        (statusCode) => statusCode >= HTTP_SUCCESS_STATUS_MIN && statusCode < HTTP_SUCCESS_STATUS_MAX_EXCLUSIVE,
      ),
      errorStatusCodes: statusCodes.filter(
        (statusCode) => statusCode < HTTP_SUCCESS_STATUS_MIN || statusCode >= HTTP_SUCCESS_STATUS_MAX_EXCLUSIVE,
      ),
    };
  }).sort(compareContracts);

  return {
    version: 1,
    routes,
  };
}

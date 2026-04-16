import type { CanonicalEntityId } from '../../shared/types/index.js';
import { identityHash } from '../../shared/utils/hash.js';
import { DomainError } from '../../shared/error/domain-error.js';
import { MIN_ALIAS_LENGTH } from '../service/alias-filter.js';

/**
 * Alias types ordered by trust/authority.
 * See RFC-003 §4.3.
 */
export const ALIAS_TYPES = [
  'canonical',
  'translation',
  'phonetic',
  'misspelling',
  'observed_query_alias',
  'catalog_noise_alias',
] as const;

export type AliasType = (typeof ALIAS_TYPES)[number];

/**
 * Scoping dimensions that control alias visibility.
 * See RFC-003 §4.3.
 */
export const ALIAS_SCOPES = [
  'global',
  'locale_ko',
  'locale_en',
  'locale_fr',
  'marketplace_specific',
  'retailer_specific',
  'temporal',
] as const;

export type AliasScope = (typeof ALIAS_SCOPES)[number];

/**
 * An alias maps a surface-form string to an entity in the Identity Graph.
 * Immutable value object.
 */
export interface Alias {
  /** Deterministic ID derived from (entityId, normalizedValue, type, scope). */
  readonly aliasId: string;
  /** The entity this alias points to. */
  readonly entityId: CanonicalEntityId;
  /** Original surface form (preserves casing and diacritics). */
  readonly value: string;
  /** Lowercased, accent-stripped, whitespace-collapsed form used for matching. */
  readonly normalizedValue: string;
  /** Classification of how this alias was derived. */
  readonly type: AliasType;
  /**
   * Prior confidence that this alias correctly maps to the entity.
   * Range [0, 1]. This is a prior estimate, NOT a calibrated decision confidence C.
   */
  readonly confidencePrior: number;
  /** Provenance identifier (e.g. 'vivino_crawl', 'manual_curation', 'transliterator'). */
  readonly source: string;
  /** Visibility scope. */
  readonly scope: AliasScope;
  /** Date from which this alias becomes active. */
  readonly effectiveFrom?: Date | undefined;
  /** Whether the alias has been suppressed (soft-deleted). */
  readonly suppressed: boolean;
  /** Optional reference to the upstream lineage that produced this alias. */
  readonly lineageRef?: string | undefined;
}

/**
 * Parameters for creating a new Alias.
 * The factory auto-generates `aliasId` and `normalizedValue`.
 */
interface CreateAliasParams {
  readonly entityId: CanonicalEntityId;
  readonly value: string;
  readonly type: AliasType;
  /**
   * Prior confidence in [0, 1].
   * This is NOT a calibrated decision confidence C.
   */
  readonly confidencePrior: number;
  readonly source: string;
  readonly scope: AliasScope;
  readonly effectiveFrom?: Date | undefined;
  readonly lineageRef?: string | undefined;
}

/**
 * Normalizes a string for alias matching: lowercases, strips combining
 * diacritical marks, and collapses contiguous whitespace to a single space.
 */
function normalizeValue(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Factory that creates a new {@link Alias} value object.
 *
 * - Deterministically generates `aliasId` from (entityId, normalizedValue, type, scope).
 * - Computes `normalizedValue` from the raw value.
 * - Validates invariants.
 *
 * @param params - Creation parameters.
 * @returns A fully initialized Alias.
 * @throws {DomainError} if invariants are violated.
 */
export function createAlias(params: CreateAliasParams): Alias {
  if (params.value.trim().length === 0) {
    throw new DomainError('INVARIANT_VIOLATION', 'Alias value cannot be empty');
  }
  // SCAN4-16: enforce MIN_ALIAS_LENGTH at the domain factory — single-char aliases
  // produce massive false positives in matching (e.g. "A" matches any query with "A").
  if (params.value.trim().length < MIN_ALIAS_LENGTH) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      `Alias value must be ≥ ${String(MIN_ALIAS_LENGTH)} characters, got "${params.value.trim()}"`,
    );
  }
  if (params.confidencePrior < 0 || params.confidencePrior > 1) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      `confidencePrior must be in [0, 1], got ${String(params.confidencePrior)}`,
    );
  }

  const normalizedValue = normalizeValue(params.value);

  const aliasId = identityHash(
    params.entityId,
    normalizedValue,
    params.type,
    params.scope,
  );

  return {
    aliasId,
    entityId: params.entityId,
    value: params.value,
    normalizedValue,
    type: params.type,
    confidencePrior: params.confidencePrior,
    source: params.source,
    scope: params.scope,
    effectiveFrom: params.effectiveFrom,
    suppressed: false,
    lineageRef: params.lineageRef,
  };
}

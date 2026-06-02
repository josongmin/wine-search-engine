/**
 * Entity Lookup V2 — graph-backed clarification (T-ELV2-06).
 *
 * When a lookup is `ambiguous`, the caller needs to disambiguate. Rather than
 * returning a bare list of labels (ad-hoc — ticket forbidden: "ambiguity를
 * string list 수준으로만 유지"), this derives, from the candidate CLUSTER, a
 * structured clarification: the ambiguity KIND and a per-option distinguishing
 * feature (what actually differs between the siblings).
 *
 * This is the in-process, label-graph core of T-ELV2-06: it diffs the candidate
 * canonical labels to find the discriminating dimension (vintage vs varietal/
 * producer variant). The deeper persisted producer/label family graph + the
 * ambiguity-cluster registry substrate (ETL-built) is the next step behind this
 * contract — the response shape here is stable across that deepening.
 */

import type { AmbiguityType } from '../model/ambiguity-state.js';

/** A candidate participating in an ambiguous cluster. */
export interface ClarificationCandidate {
  readonly entityId: string;
  readonly canonicalLabel: string;
}

export interface ClarificationOption {
  readonly entityId: string;
  readonly label: string;
  /** What distinguishes this option from its siblings (vintage, variant, …). */
  readonly distinguishingFeature?: string | undefined;
}

/** Graph-backed clarification kinds (maps onto the ambiguity taxonomy). */
export const CLARIFICATION_KINDS = ['multi_vintage', 'variant_or_collision', 'single'] as const;
export type ClarificationKind = (typeof CLARIFICATION_KINDS)[number];

export interface ClarificationResult {
  readonly kind: ClarificationKind;
  readonly options: readonly ClarificationOption[];
  /** Ambiguity types implied by the cluster shape (subset of AMBIGUITY_TYPES). */
  readonly ambiguityTypes: readonly AmbiguityType[];
}

/** A 4-digit vintage year token (1900–2099) — the dominant discriminator. */
const VINTAGE_TOKEN = /^(?:19|20)\d{2}$/u;

function tokenize(label: string): readonly string[] {
  return label
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

function extractVintage(label: string): string | undefined {
  for (const token of tokenize(label)) {
    if (VINTAGE_TOKEN.test(token)) {
      return token;
    }
  }
  return undefined;
}

/** Label with its vintage token(s) removed — the "base" identity. */
function labelWithoutVintage(label: string): string {
  return tokenize(label)
    .filter((t) => !VINTAGE_TOKEN.test(t))
    .join(' ');
}

/** Tokens in `label` not present in the cluster's shared (common) token set. */
function distinguishingTokens(label: string, sharedTokens: ReadonlySet<string>): readonly string[] {
  return tokenize(label).filter((t) => !sharedTokens.has(t) && !VINTAGE_TOKEN.test(t));
}

/**
 * Build a graph-backed clarification from an ambiguous candidate cluster.
 * Pure: derives the discriminator by diffing the candidates' canonical labels.
 */
export function buildClarification(candidates: readonly ClarificationCandidate[]): ClarificationResult {
  if (candidates.length <= 1) {
    return {
      kind: 'single',
      options: candidates.map((c) => ({ entityId: c.entityId, label: c.canonicalLabel })),
      ambiguityTypes: [],
    };
  }

  // multi_vintage: every candidate shares the same vintage-stripped base AND at
  // least two distinct vintages are present.
  const bases = new Set(candidates.map((c) => labelWithoutVintage(c.canonicalLabel)));
  const vintages = candidates.map((c) => extractVintage(c.canonicalLabel));
  const distinctVintages = new Set(vintages.filter((v): v is string => v !== undefined));
  const isMultiVintage = bases.size === 1 && distinctVintages.size >= 2;

  if (isMultiVintage) {
    return {
      kind: 'multi_vintage',
      ambiguityTypes: ['multi_vintage'],
      options: candidates.map((c) => {
        const vintage = extractVintage(c.canonicalLabel);
        return {
          entityId: c.entityId,
          label: c.canonicalLabel,
          ...(vintage !== undefined ? { distinguishingFeature: `vintage ${vintage}` } : {}),
        };
      }),
    };
  }

  // variant / collision: distinguish by the tokens unique to each candidate
  // relative to the cluster's shared tokens (e.g. producer or cuvée variant).
  const tokenCounts = new Map<string, number>();
  for (const c of candidates) {
    for (const t of new Set(tokenize(c.canonicalLabel))) {
      tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
    }
  }
  const sharedTokens = new Set(
    [...tokenCounts.entries()].filter(([, n]) => n === candidates.length).map(([t]) => t),
  );

  const sharesProducerPrefix = sharedTokens.size > 0;
  const ambiguityTypes: AmbiguityType[] = sharesProducerPrefix
    ? ['producer_family_collision']
    : ['alias_collision'];

  return {
    kind: 'variant_or_collision',
    ambiguityTypes,
    options: candidates.map((c) => {
      const unique = distinguishingTokens(c.canonicalLabel, sharedTokens);
      const vintage = extractVintage(c.canonicalLabel);
      const feature = unique.length > 0
        ? unique.join(' ')
        : vintage !== undefined
          ? `vintage ${vintage}`
          : undefined;
      return {
        entityId: c.entityId,
        label: c.canonicalLabel,
        ...(feature !== undefined ? { distinguishingFeature: feature } : {}),
      };
    }),
  };
}

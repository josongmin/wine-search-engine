import { normalizeForMatch } from '../../alias/service/normalize.js';
import type { NormalizedQueryViews } from '../../query/model/query-views.js';
import { buildNormalizedQueryViews } from '../../query/service/query-normalizer.js';
import { compactForLookup } from '../../query/service/phonetic-skeleton.js';
import { extractQueryVintageYear } from '../../shared/utils/vintage.js';
import type { LookupEntityProjectionDocument } from '../../shared/types/search-snapshot-lookup-runtime.js';

export const LOOKUP_SEMANTIC_SCOPE_AXES = ['family', 'line'] as const;
export type LookupSemanticScopeAxis = (typeof LOOKUP_SEMANTIC_SCOPE_AXES)[number];

export const LOOKUP_SEMANTIC_SURFACE_FORM_KINDS = [
  'bare',
  'qualified',
  'compact',
  'mixed_script',
] as const;
export type LookupSemanticSurfaceFormKind = (typeof LOOKUP_SEMANTIC_SURFACE_FORM_KINDS)[number];

export interface LookupSemanticScope {
  readonly semanticScopeKey: string;
  readonly scopeAxis: LookupSemanticScopeAxis;
  readonly familyKey: string;
  readonly lineKey?: string | undefined;
  readonly regionKey?: string | undefined;
  readonly appellationKey?: string | undefined;
  readonly vintage?: number | undefined;
  readonly surfaceFormKind: LookupSemanticSurfaceFormKind;
  readonly locale: 'ko' | 'global';
}

export interface LookupSemanticScopeMatch extends LookupSemanticScope {
  readonly entityId: string;
}

export interface LookupSemanticScopeRegistryPort {
  findMatches(args: {
    readonly query: string;
    readonly views: NormalizedQueryViews;
    readonly locale: 'ko' | 'global';
  }): readonly LookupSemanticScopeMatch[];
  /**
   * The set of entityIds that are reviewed APPROVED scope-target anchors. Used
   * to break a reviewed family collision by candidate identity when the query
   * surface (e.g. Korean) cannot be text-matched to the latin-keyed scope:
   * if exactly one colliding candidate is a reviewed anchor, it is the answer.
   */
  getReviewedTargetEntityIds(): ReadonlySet<string>;
}

export interface LookupSemanticEntityDescriptor {
  readonly familyKey: string;
  readonly producerKey?: string | undefined;
  readonly lineKey?: string | undefined;
  readonly regionKey?: string | undefined;
  readonly appellationKey?: string | undefined;
  readonly vintage?: number | undefined;
}

export interface LookupQuerySemanticProbe {
  readonly rawQuery: string;
  readonly locale: 'ko' | 'global';
  readonly normalizedQuery: string;
  readonly compactQuery: string;
  readonly transliteratedQuery?: string | undefined;
  readonly vintage?: number | undefined;
  readonly isCompactish: boolean;
  readonly isMixedScript: boolean;
}

export function resolveLookupSemanticLocale(args: {
  readonly query: string;
  readonly locale?: string | undefined;
}): 'ko' | 'global' {
  if (args.locale !== undefined && args.locale.toLowerCase().startsWith('ko')) {
    return 'ko';
  }
  return HANGUL_RE.test(args.query) ? 'ko' : 'global';
}

export function buildLookupSemanticDescriptorMapFromProjectionDocuments(
  projectionDocuments: readonly LookupEntityProjectionDocument[],
): ReadonlyMap<string, LookupSemanticEntityDescriptor> {
  const descriptors = new Map<string, LookupSemanticEntityDescriptor>();
  for (const document of projectionDocuments) {
    const entityId = document.entityId.trim();
    if (entityId.length === 0) {
      continue;
    }
    descriptors.set(entityId, deriveLookupSemanticEntityDescriptor({
      canonicalLabel: document.canonicalLabel,
      producer: document.producer,
      region: document.region,
      appellation: typeof document['appellation'] === 'string' ? document['appellation'] : undefined,
      vintage: typeof document['vintageYear'] === 'number' ? document['vintageYear'] : undefined,
      familyCoreKeys: document.familyCoreKeys,
    }));
  }
  return descriptors;
}

const HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/u;
const LATIN_RE = /[a-z]/iu;

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function tokenize(value: string): readonly string[] {
  return value
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function normalizeSemanticKey(value: string): string {
  const views = buildNormalizedQueryViews(value);
  return normalizeForMatch(views.vintageStripped.replace(/[^\p{L}\p{N}\s]+/gu, ' '));
}

function compactSemanticKey(value: string): string {
  return compactForLookup(normalizeSemanticKey(value));
}

function containsNormalizedSurface(
  probe: LookupQuerySemanticProbe,
  surface: string | undefined,
): boolean {
  if (surface === undefined) {
    return false;
  }
  const normalized = normalizeSemanticKey(surface);
  if (normalized.length === 0) {
    return false;
  }
  const paddedQuery = ` ${probe.normalizedQuery} `;
  const paddedSurface = ` ${normalized} `;
  if (paddedQuery.includes(paddedSurface)) {
    return true;
  }
  const compactSurface = compactSemanticKey(surface);
  if (compactSurface.length === 0) {
    return false;
  }
  if (probe.compactQuery.includes(compactSurface)) {
    return true;
  }
  if (probe.transliteratedQuery !== undefined) {
    return ` ${probe.transliteratedQuery} `.includes(paddedSurface);
  }
  return false;
}

function removeCommonPrefixTokens(
  fullValue: string,
  prefixValue: string,
): string {
  const fullTokens = tokenize(fullValue);
  const prefixTokens = tokenize(prefixValue);
  let shared = 0;
  while (
    shared < fullTokens.length
    && shared < prefixTokens.length
    && fullTokens[shared] === prefixTokens[shared]
  ) {
    shared += 1;
  }
  return fullTokens.slice(shared).join(' ').trim();
}

function chooseFamilyKey(args: {
  readonly producerKey: string;
  readonly canonicalLabelKey: string;
  readonly familyCoreKeys?: readonly string[] | undefined;
}): string {
  const normalizedFamilyCoreKeys = unique(
    (args.familyCoreKeys ?? [])
      .map(normalizeSemanticKey)
      .filter((value) => value.length > 0),
  );
  const producerKey = normalizeSemanticKey(args.producerKey);
  const canonicalKey = normalizeSemanticKey(args.canonicalLabelKey);
  const embeddedCoreKeys = normalizedFamilyCoreKeys
    .filter((value) =>
      value.length > 0
      && (
        producerKey.includes(value)
        || canonicalKey.includes(value)
      ),
    )
    .sort((left, right) =>
      tokenize(left).length - tokenize(right).length
      || left.length - right.length
      || left.localeCompare(right),
    );
  if (embeddedCoreKeys[0] !== undefined) {
    return embeddedCoreKeys[0];
  }
  if (producerKey.length > 0) {
    return producerKey;
  }
  if (normalizedFamilyCoreKeys[0] !== undefined) {
    return normalizedFamilyCoreKeys
      .slice()
      .sort((left, right) =>
        tokenize(left).length - tokenize(right).length
        || left.length - right.length
        || left.localeCompare(right),
      )[0]!;
  }
  return canonicalKey;
}

function chooseLineKey(args: {
  readonly familyKey: string;
  readonly producerKey: string;
  readonly canonicalLabelKey: string;
  readonly familyCoreKeys?: readonly string[] | undefined;
}): string | undefined {
  const familyKey = normalizeSemanticKey(args.familyKey);
  const producerKey = normalizeSemanticKey(args.producerKey);
  const canonicalKey = normalizeSemanticKey(args.canonicalLabelKey);
  const normalizedFamilyCoreKeys = unique(
    (args.familyCoreKeys ?? [])
      .map(normalizeSemanticKey)
      .filter((value) => value.length > 0 && value !== familyKey),
  );
  const remainderCandidates = unique([
    removeCommonPrefixTokens(canonicalKey, familyKey),
    removeCommonPrefixTokens(canonicalKey, producerKey),
    ...normalizedFamilyCoreKeys,
  ]).filter((value) => value.length > 0 && value !== familyKey);
  if (remainderCandidates.length === 0) {
    return undefined;
  }
  return remainderCandidates
    .slice()
    .sort((left, right) =>
      tokenize(right).length - tokenize(left).length
      || right.length - left.length
      || left.localeCompare(right),
    )[0];
}

export function buildLookupQuerySemanticProbe(args: {
  readonly query: string;
  readonly locale: 'ko' | 'global';
  readonly views?: NormalizedQueryViews | undefined;
}): LookupQuerySemanticProbe {
  const views = args.views ?? buildNormalizedQueryViews(args.query);
  const normalizedQuery = normalizeForMatch(views.vintageStripped.replace(/[^\p{L}\p{N}\s]+/gu, ' '));
  const transliteratedQuery = views.transliterated !== undefined
    ? normalizeForMatch(views.transliterated.replace(/[^\p{L}\p{N}\s]+/gu, ' '))
    : undefined;
  const rawCompact = args.query.replace(/[^\p{L}\p{N}]+/gu, '');
  const vintage = extractQueryVintageYear(args.query);
  return {
    rawQuery: args.query,
    locale: args.locale,
    normalizedQuery,
    compactQuery: compactForLookup(views.vintageStripped),
    ...(transliteratedQuery !== undefined && transliteratedQuery.length > 0
      ? { transliteratedQuery }
      : {}),
    ...(vintage !== null ? { vintage } : {}),
    isCompactish: !/\s/u.test(args.query.trim()) && rawCompact.length >= 4,
    isMixedScript: HANGUL_RE.test(args.query) && LATIN_RE.test(args.query),
  };
}

export function deriveLookupSemanticEntityDescriptor(args: {
  readonly canonicalLabel: string;
  readonly producer: string;
  readonly region?: string | undefined;
  readonly appellation?: string | undefined;
  readonly vintage?: number | undefined;
  readonly familyCoreKeys?: readonly string[] | undefined;
}): LookupSemanticEntityDescriptor {
  const producerKey = normalizeSemanticKey(args.producer);
  const canonicalLabelKey = normalizeSemanticKey(args.canonicalLabel);
  const familyKey = chooseFamilyKey({
    producerKey,
    canonicalLabelKey,
    familyCoreKeys: args.familyCoreKeys,
  });
  const lineKey = chooseLineKey({
    familyKey,
    producerKey,
    canonicalLabelKey,
    familyCoreKeys: args.familyCoreKeys,
  });
  return {
    familyKey,
    ...(producerKey.length > 0 ? { producerKey } : {}),
    ...(lineKey !== undefined ? { lineKey } : {}),
    ...(args.region !== undefined ? { regionKey: normalizeSemanticKey(args.region) } : {}),
    ...(args.appellation !== undefined ? { appellationKey: normalizeSemanticKey(args.appellation) } : {}),
    ...(args.vintage !== undefined ? { vintage: args.vintage } : {}),
  };
}

export function buildLookupSemanticScopeKey(scope: Omit<LookupSemanticScope, 'semanticScopeKey'>): string {
  return [
    scope.scopeAxis,
    scope.familyKey,
    scope.lineKey ?? '',
    scope.regionKey ?? '',
    scope.appellationKey ?? '',
    scope.vintage?.toString() ?? '',
    scope.surfaceFormKind,
    scope.locale,
  ].join('::');
}

export function buildLookupSemanticConflictKey(
  scope: Omit<LookupSemanticScope, 'semanticScopeKey'>,
): string {
  return buildLookupSemanticScopeKey(scope);
}

export function buildLookupSemanticScopeFromProbe(args: {
  readonly probe: LookupQuerySemanticProbe;
  readonly descriptor: LookupSemanticEntityDescriptor;
}): LookupSemanticScope {
  const hasLine = containsNormalizedSurface(args.probe, args.descriptor.lineKey);
  const hasRegion = containsNormalizedSurface(args.probe, args.descriptor.regionKey);
  const hasAppellation = containsNormalizedSurface(args.probe, args.descriptor.appellationKey);
  const hasExactVintage =
    args.probe.vintage !== undefined
    && args.descriptor.vintage !== undefined
    && args.probe.vintage === args.descriptor.vintage;
  const scopeAxis: LookupSemanticScopeAxis =
    hasLine || hasRegion || hasAppellation || hasExactVintage ? 'line' : 'family';
  const surfaceFormKind: LookupSemanticSurfaceFormKind =
    args.probe.isMixedScript
      ? 'mixed_script'
      : args.probe.isCompactish
        ? 'compact'
        : scopeAxis === 'line'
          ? 'qualified'
          : 'bare';
  const scope = {
    scopeAxis,
    familyKey: args.descriptor.familyKey,
    ...(hasLine && args.descriptor.lineKey !== undefined ? { lineKey: args.descriptor.lineKey } : {}),
    ...(hasRegion && args.descriptor.regionKey !== undefined ? { regionKey: args.descriptor.regionKey } : {}),
    ...(hasAppellation && args.descriptor.appellationKey !== undefined ? { appellationKey: args.descriptor.appellationKey } : {}),
    ...(hasExactVintage && args.descriptor.vintage !== undefined ? { vintage: args.descriptor.vintage } : {}),
    surfaceFormKind,
    locale: args.probe.locale,
  } satisfies Omit<LookupSemanticScope, 'semanticScopeKey'>;
  return {
    ...scope,
    semanticScopeKey: buildLookupSemanticScopeKey(scope),
  };
}

/**
 * Reviewed component-surface index (final architecture L1, runtime-facing):
 * componentKind::componentKey::locale -> reviewed normalized surfaces. Lets the
 * scope matcher recognise multilingual surfaces ("샤또 앙젤뤼스") that the
 * latin-literal token path can never see, by COMPOSING component surfaces.
 */
export type LookupSemanticScopeComponentKind = 'family' | 'line' | 'region' | 'appellation';
export interface LookupSemanticScopeSurfaceIndex {
  readonly componentSurfaces: ReadonlyMap<string, ReadonlySet<string>>;
}

export function buildLookupSemanticScopeComponentSurfaceKey(args: {
  readonly componentKind: LookupSemanticScopeComponentKind;
  readonly componentKey: string;
  readonly locale: 'ko' | 'global';
}): string {
  return `${args.componentKind}::${args.componentKey}::${args.locale}`;
}

function componentMatches(
  probe: LookupQuerySemanticProbe,
  componentKind: LookupSemanticScopeComponentKind,
  componentKey: string,
  locale: 'ko' | 'global',
  surfaceIndex: LookupSemanticScopeSurfaceIndex | undefined,
): boolean {
  // 1) latin-literal token path (global queries, latin surfaces) — kept as a
  //    fallback so this is purely additive and never regresses.
  if (containsNormalizedSurface(probe, componentKey)) {
    return true;
  }
  // 2) reviewed multilingual surface path — any reviewed surface for this
  //    component that the query contains satisfies the component.
  const surfaces = surfaceIndex?.componentSurfaces.get(
    buildLookupSemanticScopeComponentSurfaceKey({ componentKind, componentKey, locale }),
  );
  if (surfaces !== undefined) {
    for (const surface of surfaces) {
      if (containsNormalizedSurface(probe, surface)) {
        return true;
      }
    }
  }
  return false;
}

export function queryMatchesLookupSemanticScope(args: {
  readonly probe: LookupQuerySemanticProbe;
  readonly scope: Omit<LookupSemanticScope, 'semanticScopeKey'>;
  readonly surfaceIndex?: LookupSemanticScopeSurfaceIndex | undefined;
}): boolean {
  const locale = args.scope.locale;
  if (!componentMatches(args.probe, 'family', args.scope.familyKey, locale, args.surfaceIndex)) {
    return false;
  }
  if (
    args.scope.lineKey !== undefined
    && !componentMatches(args.probe, 'line', args.scope.lineKey, locale, args.surfaceIndex)
  ) {
    return false;
  }
  if (
    args.scope.regionKey !== undefined
    && !componentMatches(args.probe, 'region', args.scope.regionKey, locale, args.surfaceIndex)
  ) {
    return false;
  }
  if (
    args.scope.appellationKey !== undefined
    && !componentMatches(args.probe, 'appellation', args.scope.appellationKey, locale, args.surfaceIndex)
  ) {
    return false;
  }
  if (args.scope.vintage !== undefined && args.probe.vintage !== args.scope.vintage) {
    return false;
  }
  if (args.scope.surfaceFormKind === 'mixed_script' && !args.probe.isMixedScript) {
    return false;
  }
  if (args.scope.surfaceFormKind === 'compact' && !args.probe.isCompactish) {
    return false;
  }
  if (
    args.scope.surfaceFormKind === 'bare'
    && (
      args.probe.vintage !== undefined
      || args.scope.lineKey !== undefined
      || args.scope.regionKey !== undefined
      || args.scope.appellationKey !== undefined
    )
  ) {
    return false;
  }
  return true;
}

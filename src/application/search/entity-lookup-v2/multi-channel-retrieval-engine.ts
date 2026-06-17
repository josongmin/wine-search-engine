/**
 * Entity Lookup V2 — independent multi-channel candidate retrieval runtime
 * (T-ELV2-04, real).
 *
 * Implements the frozen {@link LookupCandidateRetrievalPort}. Unlike the
 * post-hoc anchor re-projection (which carried `latencyMs: 0`), this runs each
 * declared channel as an INDEPENDENT, TIMED retrieval against the live alias
 * substrate ({@link AliasMatcher}) and reports REAL per-channel latency, hit
 * counts, and scores (RFC §5.4 — "candidate recall이 다채널 artifact로 분리").
 *
 * Recall widening: the query is fanned across DISTINCT normalized VIEWS
 * (strict / compact / transliterated / phonetic-compact) — that view fanout is
 * the recall mechanism and is unchanged. The per-candidate channel LABEL,
 * however, is derived from the matcher's REAL `lookupStrategy` (mapped via the
 * SSoT {@link mapLookupStrategyToChannel} after `index_`-strip + `+`-decompose),
 * NOT the view binding — so a `transliterated_fuzzy` / `lexical_exact` recall is
 * labeled honestly (fuzzy_alias) instead of forged as an exact channel (T-04
 * audit). The per-view-run coverage rail keeps the binding channel for latency
 * observability ("which view ran, how long").
 *
 * Honest scope: under the WIRED alias substrate (SearchIndex/SearchSnapshot/
 * Cascading matcher) the emitted strategies are exact / compact_exact /
 * lexical_exact / prefix_exact / transliterated_exact / transliterated_fuzzy /
 * phonetic_exact — NOT trigram/edit-distance fuzzy (those live in PgAliasMatcher,
 * which is NOT wired into the lookup lane). The graph channels (`family_graph`,
 * `line_graph`, `vintage_graph`) fire when an EntityScopeGraphPort is wired and
 * the snapshot-published scope graph runtime is available; `dense` remains
 * reserved (emitted only via the reuse-path blocker seed).
 *
 * Candidate recall is the UNION across channels; the final resolve authority
 * remains the reranker + calibrator (never a single channel's top-1).
 *
 * Lives in the application layer because it composes a domain matcher
 * ({@link AliasMatcher}) with {@link LookupResolverProjectionPort} for
 * resolver projection hydration — application → domain is the allowed direction.
 */

import {
  splitLookupStrategies,
  type AliasMatcher,
  type AliasMatchResult,
} from '../../../domain/query/service/anchor-extractor.js';
import type { CanonicalEntityId } from '../../../domain/shared/types/index.js';
import { clamp01 } from '../../../domain/shared/utils/clamp.js';
import { mapLookupStrategyToChannel } from '../../../domain/resolver/v2/channel-provenance.js';
import type {
  LookupCandidate,
  LookupCandidateRetrievalPort,
  LookupChannelCoverage,
  LookupChannelHit,
  LookupRetrievalChannel,
  LookupRetrievalInput,
  LookupRetrievalResult,
} from '../../../domain/resolver/v2/lookup-v2-types.js';
import type { LookupResolverProjectionPort } from '../port/search-pipeline-deps.port.js';
import type {
  EntityScopeGraphPort,
  LookupScopeGraphEdge,
  LookupScopeGraphRelationKind,
} from '../../../domain/resolver/v2/entity-scope-graph.port.js';
import {
  buildLookupQuerySemanticProbe,
  resolveLookupSemanticLocale,
} from '../../../domain/resolver/v2/lookup-semantic-scope.js';
import type { LookupReviewedFamilyRecallPort } from '../../../domain/resolver/v2/lookup-reviewed-family-recall.js';

export interface MultiChannelRetrievalDeps {
  readonly aliasMatcher: AliasMatcher;
  readonly resolverProjectionLookup: LookupResolverProjectionPort;
  readonly reviewedFamilyRecall?: LookupReviewedFamilyRecallPort | undefined;
  readonly entityScopeGraph?: EntityScopeGraphPort | undefined;
}

/**
 * Family siblings carry graph edge weights (~0.5–0.9) below exact alias anchors
 * (~1.0), so a pure best-score slice would truncate them. Reserve up to
 * `ceil(maxCandidates / DIVISOR)` (≥1) slots for family-ONLY siblings so
 * co-producer recall actually surfaces instead of being crowded out (rule 15).
 */
const FAMILY_SIBLING_BUDGET_DIVISOR = 3;
/** Sentinel matchedView for graph-derived (non-view) graph hits. */
const FAMILY_GRAPH_MATCHED_VIEW = 'family_graph';
const LINE_GRAPH_MATCHED_VIEW = 'line_graph';
const VINTAGE_GRAPH_MATCHED_VIEW = 'vintage_graph';
const REVIEWED_FAMILY_RECALL_MATCHED_VIEW = 'reviewed_family_recall';

/** A channel paired with the normalized view it independently queries. */
interface ChannelViewBinding {
  readonly channel: LookupRetrievalChannel;
  readonly view: string | undefined;
}

interface ChannelRunResult {
  readonly channel: LookupRetrievalChannel;
  readonly view: string;
  readonly latencyMs: number;
  readonly matches: readonly AliasMatchResult[];
}

function queryContainsSurface(
  probe: ReturnType<typeof buildLookupQuerySemanticProbe>,
  surface: string | undefined,
): boolean {
  if (surface === undefined || surface.length === 0) {
    return false;
  }
  const paddedQuery = ` ${probe.normalizedQuery} `;
  const paddedSurface = ` ${surface} `;
  if (paddedQuery.includes(paddedSurface)) {
    return true;
  }
  if (probe.transliteratedQuery !== undefined && ` ${probe.transliteratedQuery} `.includes(paddedSurface)) {
    return true;
  }
  return probe.compactQuery.includes(surface.replace(/\s+/gu, ''));
}

function computeScopeFeatureHints(args: {
  readonly probe: ReturnType<typeof buildLookupQuerySemanticProbe>;
  readonly descriptor: ReturnType<NonNullable<EntityScopeGraphPort['getSemanticDescriptor']>> | undefined;
  readonly channelHits: readonly LookupChannelHit[];
  readonly canonicalLabel?: string | undefined;
}): NonNullable<LookupCandidate['scopeFeatureHints']> | undefined {
  const descriptor = args.descriptor;
  if (descriptor === undefined) {
    return undefined;
  }
  const lineMatch = queryContainsSurface(args.probe, descriptor.lineKey);
  const regionMatch = queryContainsSurface(args.probe, descriptor.regionKey);
  const appellationMatch = queryContainsSurface(args.probe, descriptor.appellationKey);
  const vintageMatch =
    args.probe.vintage !== undefined
    && descriptor.vintage !== undefined
    && args.probe.vintage === descriptor.vintage;
  const qualifierMatches = [lineMatch, regionMatch, appellationMatch, vintageMatch].filter(Boolean).length;
  const queryHasQualifiedIntent =
    args.probe.vintage !== undefined
    || lineMatch
    || regionMatch
    || appellationMatch;
  const scopeAxisAgreement = queryHasQualifiedIntent ? (qualifierMatches > 0 ? 1 : 0) : 1;
  return {
    lineGraphProximity: channelBest(args.channelHits, 'line_graph'),
    vintageGraphProximity: channelBest(args.channelHits, 'vintage_graph'),
    scopeQualifierAgreement: qualifierMatches > 0 ? qualifierMatches / 4 : 0,
    scopeAxisAgreement,
  };
}

function channelBest(
  hits: readonly LookupChannelHit[],
  channel: LookupRetrievalChannel,
): number {
  return hits
    .filter((hit) => hit.channel === channel)
    .reduce((best, hit) => Math.max(best, hit.channelScore), 0);
}

export class MultiChannelRetrievalEngine implements LookupCandidateRetrievalPort {
  constructor(private readonly deps: MultiChannelRetrievalDeps) {}

  async retrieve(input: LookupRetrievalInput, _signal?: AbortSignal): Promise<LookupRetrievalResult> {
    const views = input.views;
    const stageTimer = input.stageTimer;
    const bindings: readonly ChannelViewBinding[] = [
      { channel: 'exact_alias', view: views.strict },
      { channel: 'compact_exact', view: views.compact },
      { channel: 'transliteration_exact', view: views.transliterated },
      { channel: 'jamo_phonetic', view: views.phoneticCompact },
    ];

    // Run each channel INDEPENDENTLY and TIMED. Distinct, non-empty views only
    // (a channel whose view is empty/duplicate of an already-run view is dormant).
    const seenViews = new Set<string>();
    const runnable = bindings.filter((b) => {
      if (b.view === undefined) return false;
      const v = b.view.trim();
      if (v.length === 0 || seenViews.has(v)) return false;
      seenViews.add(v);
      return true;
    });

    const runs = await Promise.all(
      runnable.map((b) => this.runChannel(b.channel, b.view as string, stageTimer)),
    );
    const semanticLocale = resolveLookupSemanticLocale({
      query: input.rawQuery,
      locale: input.locale,
    });
    const queryProbe = buildLookupQuerySemanticProbe({
      query: input.rawQuery,
      views: input.views,
      locale: semanticLocale,
    });

    // UNION + dedupe by entity. Per-candidate channel provenance is derived from
    // the matcher's REAL `lookupStrategy` (via the SSoT splitter + channel mapper),
    // NOT the binding view's channel — so a `transliterated_fuzzy`/`lexical_exact`
    // recall is labeled honestly (fuzzy_alias) instead of forged as an exact
    // channel (T-04 audit). Each match yields one hit per DISTINCT mapped channel;
    // hits dedupe per entity+channel keeping the max score. The coverage rail below
    // stays per-VIEW-RUN (binding channel = which view ran) so per-run latency
    // observability is preserved.
    interface ChannelAccum { matchedView: string; matchedAlias?: string; score: number }
    const byEntity = new Map<string, { id: CanonicalEntityId; key: string; byChannel: Map<LookupRetrievalChannel, ChannelAccum>; best: number }>();
    const coverage: LookupChannelCoverage[] = [];

    stageTimer?.start('retrieval.union');
    for (const run of runs) {
      let hitCount = 0;
      for (const match of run.matches) {
        const score = clamp01(match.matchConfidence);
        // Real algorithm(s) that recalled this match. Fall back to the binding
        // channel ONLY when the matcher emitted no usable strategy (legacy path).
        const mapped = [
          ...new Set(
            splitLookupStrategies(match.lookupStrategy)
              .map((token) => mapLookupStrategyToChannel(token))
              .filter((c): c is LookupRetrievalChannel => c !== undefined),
          ),
        ];
        const channels: readonly LookupRetrievalChannel[] = mapped.length > 0 ? mapped : [run.channel];
        for (const entityId of match.entityIds) {
          const key = String(entityId);
          let entry = byEntity.get(key);
          if (entry === undefined) {
            entry = { id: entityId, key, byChannel: new Map(), best: score };
            byEntity.set(key, entry);
          }
          for (const channel of channels) {
            const prev = entry.byChannel.get(channel);
            if (prev === undefined || score > prev.score) {
              entry.byChannel.set(channel, {
                matchedView: run.view,
                ...(match.surfaceForm.length > 0 ? { matchedAlias: match.surfaceForm } : {}),
                score,
              });
            }
          }
          if (score > entry.best) entry.best = score;
          hitCount += 1;
        }
      }
      coverage.push({
        channel: run.channel,
        firing: hitCount > 0,
        hitCount,
        latencyMs: run.latencyMs,
      });
    }
    stageTimer?.end('retrieval.union');

    if (this.deps.reviewedFamilyRecall !== undefined) {
      const startedAt = performance.now();
      let hitCount = 0;
      stageTimer?.start('retrieval.dense');
      try {
        const matches = this.deps.reviewedFamilyRecall.findMatches({
          query: input.rawQuery,
          views: input.views,
          locale: semanticLocale,
        });
        for (const match of matches) {
          for (const entityId of match.entityIds) {
            let entry = byEntity.get(entityId);
            if (entry === undefined) {
              entry = {
                id: entityId as CanonicalEntityId,
                key: entityId,
                byChannel: new Map(),
                best: clamp01(match.recallWeight),
              };
              byEntity.set(entityId, entry);
            }
            const prev = entry.byChannel.get('dense');
            if (prev === undefined || match.recallWeight > prev.score) {
              entry.byChannel.set('dense', {
                matchedView: REVIEWED_FAMILY_RECALL_MATCHED_VIEW,
                matchedAlias: match.normalizedSurface,
                score: clamp01(match.recallWeight),
              });
            }
            if (match.recallWeight > entry.best) {
              entry.best = clamp01(match.recallWeight);
            }
            hitCount += 1;
          }
        }
      } finally {
        stageTimer?.end('retrieval.dense');
      }
      coverage.push({
        channel: 'dense',
        firing: hitCount > 0,
        hitCount,
        latencyMs: Math.max(0, performance.now() - startedAt),
      });
    }

    // Snapshot-published entity scope graph expansion. Every graph lane is
    // degradation-safe: a missing/broken artifact yields a dormant channel,
    // never a sunk request.
    const aliasRecalledKeys = [...byEntity.keys()];
    const familyOnlyKeys = new Set<string>();
    if (
      this.deps.entityScopeGraph !== undefined
      && aliasRecalledKeys.length > 0
      && input.suppressFamilyGraphExpansion !== true
    ) {
      const graphRuns = [
        {
          channel: 'family_graph' as const,
          relationKind: 'family' as const,
          matchedView: FAMILY_GRAPH_MATCHED_VIEW,
          familyOnly: true,
        },
        {
          channel: 'line_graph' as const,
          relationKind: 'line' as const,
          matchedView: LINE_GRAPH_MATCHED_VIEW,
          familyOnly: false,
        },
        {
          channel: 'vintage_graph' as const,
          relationKind: 'vintage' as const,
          matchedView: VINTAGE_GRAPH_MATCHED_VIEW,
          familyOnly: false,
        },
      ];
      for (const graphRun of graphRuns) {
        const startedAt = performance.now();
        let hitCount = 0;
        stageTimer?.start(`retrieval.${graphRun.channel}`);
        try {
          const relatedByAnchor = this.deps.entityScopeGraph.getRelatedEntitiesBatch !== undefined
            ? await this.deps.entityScopeGraph.getRelatedEntitiesBatch(aliasRecalledKeys, graphRun.relationKind, _signal)
            : await this.fanoutScopeGraph(aliasRecalledKeys, graphRun.relationKind, _signal);
          for (const [, relatedEntities] of relatedByAnchor) {
            for (const related of relatedEntities) {
              const score = clamp01(related.weight);
              let entry = byEntity.get(related.targetEntityId);
              if (entry === undefined) {
                entry = {
                  id: related.targetEntityId as CanonicalEntityId,
                  key: related.targetEntityId,
                  byChannel: new Map(),
                  best: score,
                };
                byEntity.set(related.targetEntityId, entry);
                if (graphRun.familyOnly) {
                  familyOnlyKeys.add(related.targetEntityId);
                }
              }
              const prev = entry.byChannel.get(graphRun.channel);
              if (prev === undefined || score > prev.score) {
                entry.byChannel.set(graphRun.channel, {
                  matchedView: graphRun.matchedView,
                  score,
                });
              }
              if (score > entry.best) {
                entry.best = score;
              }
              hitCount += 1;
            }
          }
        } catch (err) {
          void err;
        } finally {
          stageTimer?.end(`retrieval.${graphRun.channel}`);
        }
        coverage.push({
          channel: graphRun.channel,
          firing: hitCount > 0,
          hitCount,
          latencyMs: Math.max(0, performance.now() - startedAt),
        });
      }
      for (const key of aliasRecalledKeys) familyOnlyKeys.delete(key);
    }

    // Cap the union to maxCandidates by best per-entity channel score, but RESERVE
    // a budget for family-ONLY siblings (edge weights sit below alias anchors, so a
    // pure best-score slice would truncate them — the channel would fire yet never
    // hydrate).
    const max = Math.max(1, input.maxCandidates);
    const byScore = (a: { best: number; key: string }, b: { best: number; key: string }): number =>
      b.best - a.best || a.key.localeCompare(b.key);
    const allEntries = [...byEntity.values()].sort(byScore);
    let ranked: typeof allEntries;
    if (familyOnlyKeys.size === 0) {
      ranked = allEntries.slice(0, max);
    } else {
      const reserve = Math.min(familyOnlyKeys.size, Math.max(1, Math.ceil(max / FAMILY_SIBLING_BUDGET_DIVISOR)));
      const primary = allEntries.filter((e) => !familyOnlyKeys.has(e.key)).slice(0, Math.max(1, max - reserve));
      const reserved = allEntries.filter((e) => familyOnlyKeys.has(e.key)).slice(0, reserve);
      const seen = new Set(primary.map((e) => e.key));
      ranked = [...primary, ...reserved.filter((e) => !seen.has(e.key))].sort(byScore).slice(0, max);
    }

    stageTimer?.start('retrieval.hydration');
    const docs = await this.deps.resolverProjectionLookup.getResolverProjections(ranked.map((e) => e.id));
    stageTimer?.end('retrieval.hydration');

    const candidates: LookupCandidate[] = ranked.map((entry) => {
      const doc = docs.get(entry.id);
      // Deterministic per-candidate channel hits: one row per distinct real
      // channel, ranked by descending score (channel name breaks ties).
      const channelHits: LookupChannelHit[] = [...entry.byChannel.entries()]
        .map(([channel, accum]) => ({
          channel,
          matchedView: accum.matchedView,
          ...(accum.matchedAlias !== undefined ? { matchedAlias: accum.matchedAlias } : {}),
          channelScore: accum.score,
          channelRank: 0,
        }))
        .sort((a, b) => b.channelScore - a.channelScore || a.channel.localeCompare(b.channel))
        .map((hit, index) => ({ ...hit, channelRank: index + 1 }));
      return {
        entityId: entry.id,
        canonicalLabel: doc?.canonicalLabel ?? entry.key,
        entityType: doc?.entityType ?? 'unknown',
        channelHits,
        ...(this.deps.entityScopeGraph?.getSemanticDescriptor !== undefined
          ? {
              scopeFeatureHints: computeScopeFeatureHints({
                probe: queryProbe,
                descriptor: this.deps.entityScopeGraph.getSemanticDescriptor(String(entry.id)),
                channelHits,
                canonicalLabel: doc?.canonicalLabel,
              }),
            }
          : {}),
      };
    });

    return { candidates, coverage };
  }

  /** Fallback scope-graph lookup when the port has no batch variant. */
  private async fanoutScopeGraph(
    anchorKeys: readonly string[],
    relationKind: LookupScopeGraphRelationKind,
    signal: AbortSignal | undefined,
  ): Promise<ReadonlyMap<string, readonly LookupScopeGraphEdge[]>> {
    const out = new Map<string, readonly LookupScopeGraphEdge[]>();
    if (this.deps.entityScopeGraph === undefined) return out;
    for (const key of anchorKeys) {
      out.set(key, await this.deps.entityScopeGraph.getRelatedEntities(key, relationKind, signal));
    }
    return out;
  }

  private async runChannel(
    channel: LookupRetrievalChannel,
    view: string,
    stageTimer?: LookupRetrievalInput['stageTimer'],
  ): Promise<ChannelRunResult> {
    const startedAt = performance.now();
    let matches: readonly AliasMatchResult[] = [];
    try {
      matches = await this.deps.aliasMatcher.findMatches(view, {
        scope: 'span',
        ...(stageTimer !== undefined ? { stageTimer } : {}),
      });
    } catch {
      // A single channel failure must not sink the union — record an empty,
      // timed run (firing=false) and let the other channels stand.
      matches = [];
    }
    return { channel, view, latencyMs: Math.max(0, performance.now() - startedAt), matches };
  }
}

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
 * which is NOT wired into the lookup lane). `family_graph` and `dense` channels
 * are reserved (no family-graph port; dense only via the reuse-path blocker seed).
 *
 * Candidate recall is the UNION across channels; the final resolve authority
 * remains the reranker + calibrator (never a single channel's top-1).
 *
 * Lives in the application layer because it composes a domain matcher
 * (AliasMatcher) with the application {@link EntityDocumentLookupPort} for
 * hydration — application → domain is the allowed direction.
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
import type { EntityDocumentLookupPort } from '../port/search-pipeline-deps.port.js';

export interface MultiChannelRetrievalDeps {
  readonly aliasMatcher: AliasMatcher;
  readonly entityLookup: EntityDocumentLookupPort;
}

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

export class MultiChannelRetrievalEngine implements LookupCandidateRetrievalPort {
  constructor(private readonly deps: MultiChannelRetrievalDeps) {}

  async retrieve(input: LookupRetrievalInput, _signal?: AbortSignal): Promise<LookupRetrievalResult> {
    const views = input.views;
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
      runnable.map((b) => this.runChannel(b.channel, b.view as string)),
    );

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

    // Cap the union to maxCandidates by best per-entity channel score (the
    // reranker/calibrator is the final authority over this pool).
    const ranked = [...byEntity.values()]
      .sort((a, b) => b.best - a.best || a.key.localeCompare(b.key))
      .slice(0, Math.max(1, input.maxCandidates));

    const docs = await this.deps.entityLookup.getDocuments(ranked.map((e) => e.id));

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
      };
    });

    return { candidates, coverage };
  }

  private async runChannel(
    channel: LookupRetrievalChannel,
    view: string,
  ): Promise<ChannelRunResult> {
    const startedAt = performance.now();
    let matches: readonly AliasMatchResult[] = [];
    try {
      matches = await this.deps.aliasMatcher.findMatches(view);
    } catch {
      // A single channel failure must not sink the union — record an empty,
      // timed run (firing=false) and let the other channels stand.
      matches = [];
    }
    return { channel, view, latencyMs: Math.max(0, performance.now() - startedAt), matches };
  }
}

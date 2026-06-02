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
 * Each channel queries a DISTINCT normalized view, so the channels are
 * genuinely independent recall strategies:
 *   - exact_alias            ← strict view
 *   - compact_exact          ← compact (whitespace/punct-folded) view
 *   - transliteration_exact  ← transliterated view
 *   - jamo_phonetic          ← phonetic-compact view
 *
 * Candidate recall is the UNION across channels; the final resolve authority
 * remains the reranker + calibrator (never a single channel's top-1). Fuzzy /
 * dense / family-graph channels are the next step behind this same port.
 *
 * Lives in the application layer because it composes a domain matcher
 * (AliasMatcher) with the application {@link EntityDocumentLookupPort} for
 * hydration — application → domain is the allowed direction.
 */

import type { AliasMatcher, AliasMatchResult } from '../../../domain/query/service/anchor-extractor.js';
import type { CanonicalEntityId } from '../../../domain/shared/types/index.js';
import { clamp01 } from '../../../domain/shared/utils/clamp.js';
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

    // UNION + dedupe by entity, accumulating per-channel provenance. Keyed by
    // the stringified id for dedupe, but the branded CanonicalEntityId is kept.
    const byEntity = new Map<string, { id: CanonicalEntityId; key: string; hits: LookupChannelHit[]; best: number }>();
    const coverage: LookupChannelCoverage[] = [];

    for (const run of runs) {
      let hitCount = 0;
      for (const match of run.matches) {
        for (const entityId of match.entityIds) {
          const key = String(entityId);
          const score = clamp01(match.matchConfidence);
          const hit: LookupChannelHit = {
            channel: run.channel,
            matchedView: run.view,
            ...(match.surfaceForm.length > 0 ? { matchedAlias: match.surfaceForm } : {}),
            channelScore: score,
            channelRank: hitCount + 1,
          };
          const existing = byEntity.get(key);
          if (existing === undefined) {
            byEntity.set(key, { id: entityId, key, hits: [hit], best: score });
          } else {
            existing.hits.push(hit);
            if (score > existing.best) existing.best = score;
          }
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
      return {
        entityId: entry.id,
        canonicalLabel: doc?.canonicalLabel ?? entry.key,
        entityType: doc?.entityType ?? 'unknown',
        channelHits: entry.hits,
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

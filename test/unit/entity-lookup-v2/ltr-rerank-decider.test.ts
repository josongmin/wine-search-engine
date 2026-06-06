import { describe, expect, it } from 'vitest';
import { LtrRerankDecider } from '../../../src/domain/resolver/v2/ltr-rerank-decider.js';
import { extractLookupFeatures } from '../../../src/domain/resolver/v2/lookup-feature-extractor.js';
import { LTR_FEATURE_DIMENSION, LTR_FEATURE_SCHEMA_HASH, type QueryClassWeights } from '../../../src/domain/ranking/service/lambdamart-ranker.js';
import type { LookupCandidateFeatures, LookupScoredCandidate, LookupChannelHit } from '../../../src/domain/resolver/v2/lookup-v2-types.js';

function features(over: Partial<LookupCandidateFeatures> = {}): LookupCandidateFeatures {
  return {
    exactAliasEvidence: 0, normalizedAliasEvidence: 0, transliterationConsistency: 0,
    editDistanceScore: 0, phoneticConsistency: 0, familyGraphProximity: 0,
    lineGraphProximity: 0, vintageGraphProximity: 0,
    scopeQualifierAgreement: 0, scopeAxisAgreement: 0,
    popularityPrior: 0, scriptLanguageConsistency: 0, ambiguityClusterMembership: 0,
    channelAgreement: 0, ...over,
  };
}

function scored(id: string, calibratedScore: number, f: Partial<LookupCandidateFeatures> = {}): LookupScoredCandidate {
  return { entityId: id, canonicalLabel: id, entityType: 'wine', calibratedScore, rank: 1, features: features(f), channelHits: [] };
}

// Model that rewards attributeMatchScore (index 5 = exactAliasEvidence proxy).
function attributeModel(): QueryClassWeights {
  const weights = Array.from({ length: LTR_FEATURE_DIMENSION }, (_, i) => (i === 5 ? 10 : 0));
  return { queryClass: 'known-item', featureSchemaHash: LTR_FEATURE_SCHEMA_HASH, weights, bias: -5, trainingExampleCount: 100, ndcg5ValidationScore: 0.9, trainedAt: new Date('2026-01-01') };
}

describe('LtrRerankDecider (T-ELV2-05) — learned reranker + downgrade-only decision', () => {
  it('reranks by the learned model and resolves a clear winner', async () => {
    const model = new Map([['known-item', attributeModel()]]);
    const decider = new LtrRerankDecider({ ltrModels: model });
    const out = await decider.decide({
      queryClass: 'known-item',
      scored: [
        scored('weak', 0.9, { exactAliasEvidence: 0 }),
        scored('strong', 0.1, { exactAliasEvidence: 1 }),
      ],
    });
    // 'strong' has exact evidence → wins under the learned model despite lower calibratedScore
    expect(out.status).toBe('resolved');
    expect(out.reasonCode).toBe('learned_rerank');
    expect(out.calibrationTrusted).toBe(false);
  });

  it('falls back to lexical (calibrated) ordering when no model exists for the class', async () => {
    const decider = new LtrRerankDecider({ ltrModels: new Map() });
    const out = await decider.decide({ queryClass: 'known-item', scored: [scored('a', 0.95), scored('b', 0.2, {}), ] });
    expect(out.status).toBe('resolved');
    expect(out.reasonCode).toBe('no_ltr_model');
  });

  it('falls back when the model feature-schema does not match (scorer throws)', async () => {
    const bad: QueryClassWeights = { ...attributeModel(), featureSchemaHash: 'deadbeefdeadbeef' };
    const decider = new LtrRerankDecider({ ltrModels: new Map([['known-item', bad]]) });
    const out = await decider.decide({ queryClass: 'known-item', scored: [scored('a', 0.9, { exactAliasEvidence: 1 })] });
    expect(out.reasonCode).toBe('ltr_unavailable');
    expect(out.status).toBe('resolved');
  });

  it('falls back when the model is saturated (all scores ~equal)', async () => {
    const flat: QueryClassWeights = { ...attributeModel(), weights: Array.from({ length: LTR_FEATURE_DIMENSION }, () => 0), bias: 0 };
    const decider = new LtrRerankDecider({ ltrModels: new Map([['known-item', flat]]) });
    // clear calibrated gap so the lexical fallback resolves; reason carries the saturation cause
    const out = await decider.decide({ queryClass: 'known-item', scored: [scored('a', 0.9), scored('b', 0.4)] });
    expect(out.reasonCode).toContain('ltr_saturated');
  });

  it('downgrades to failed when the top learned score is below the resolve threshold', async () => {
    const model = new Map([['known-item', attributeModel()]]);
    const decider = new LtrRerankDecider({ ltrModels: model });
    // no exact evidence → low learned score → failed
    const out = await decider.decide({ queryClass: 'known-item', scored: [scored('a', 0.9, { exactAliasEvidence: 0 })] });
    expect(out.status).toBe('failed');
  });

  it('returns no_match for an empty candidate set', async () => {
    const out = await new LtrRerankDecider().decide({ queryClass: 'known-item', scored: [] });
    expect(out.status).toBe('failed');
    expect(out.reasonCode).toBe('no_match');
  });
});

describe('extractLookupFeatures (T-ELV2-05)', () => {
  it('derives feature signals from per-channel hits', () => {
    const hits: LookupChannelHit[] = [
      { channel: 'exact_alias', matchedView: 'opus one', channelScore: 0.97, channelRank: 1 },
      { channel: 'transliteration_exact', matchedView: 'opus one', channelScore: 0.9, channelRank: 1 },
    ];
    const f = extractLookupFeatures(hits, 0.8);
    expect(f.exactAliasEvidence).toBe(0.97);
    expect(f.transliterationConsistency).toBe(0.9);
    expect(f.scriptLanguageConsistency).toBe(1);
    expect(f.channelAgreement).toBe(2);
    expect(f.popularityPrior).toBe(0.8);
  });

  it('reports zero evidence + channelAgreement 0 for an empty hit set', () => {
    const f = extractLookupFeatures([], 0);
    expect(f.exactAliasEvidence).toBe(0);
    expect(f.channelAgreement).toBe(0);
    expect(f.scriptLanguageConsistency).toBe(0);
  });
});

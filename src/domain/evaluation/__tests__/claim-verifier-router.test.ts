import { describe, it, expect } from 'vitest';
import { routeAndVerify } from '../service/claim-verifier-router.js';
import type { EvidenceRecord } from '../service/claim-verifier-router.js';
import type { ExtractedClaim } from '../model/claim.js';

function makeClaim(category: ExtractedClaim['category'], field: string, value: string): ExtractedClaim {
  return {
    id: `${category}-${field}-${value}`,
    category,
    field: field as any,
    value,
    normalizedValue: value.toLowerCase(),
    sourceText: value,
  };
}

describe('routeAndVerify', () => {
  it('routes identity_claim to deterministic', async () => {
    const claims: ExtractedClaim[] = [makeClaim('identity_claim', 'canonical_label', 'Opus One')];
    const evidence: EvidenceRecord[] = [{ canonical_label: 'opus one' }];
    const results = await routeAndVerify(claims, evidence, '', null);
    expect(results[0]?.verifierUsed).toBe('deterministic');
  });

  it('routes core_structured_claim to deterministic', async () => {
    const claims: ExtractedClaim[] = [makeClaim('core_structured_claim', 'vintage_year', '2015')];
    const evidence: EvidenceRecord[] = [{ vintage_year: 2015 }];
    const results = await routeAndVerify(claims, evidence, '', null);
    expect(results[0]?.verifierUsed).toBe('deterministic');
    expect(results[0]?.verdict).toBe('entailed');
  });

  it('semantic_claim with no LLM falls back gracefully', async () => {
    const claims: ExtractedClaim[] = [makeClaim('semantic_claim', 'tasting_notes', 'rich blackberry')];
    const results = await routeAndVerify(claims, [], '', null);
    expect(results[0]?.verifierUsed).toBe('llm_semantic');
    expect(results[0]?.verdict).toBe('not_entailed');
  });

  it('anchors entailed semantic claims to profile evidence when available', async () => {
    const claims: ExtractedClaim[] = [makeClaim('semantic_claim', 'style_description', 'sweet and fruit-forward')];
    const evidence: EvidenceRecord[] = [{
      entity_id: 'wine-1',
      profile_evidence: ['sweet_light', 'fruit_forward'],
      claimable_attributes: ['profile_evidence:sweet_light', 'profile_evidence:fruit_forward'],
    }];
    const llm = {
      complete: async () => ({
        text: JSON.stringify([
          { claim_id: claims[0]!.id, verdict: 'entailed', explanation: 'supported by profile_evidence' },
        ]),
      }),
    } as any;

    const results = await routeAndVerify(claims, evidence, 'GROUNDING_JSON evidence', llm);

    expect(results[0]?.verdict).toBe('entailed');
    expect(results[0]?.evidenceAnchor?.field).toBe('profile_evidence');
    expect(results[0]?.evidenceAnchor?.value).toBe('sweet_light, fruit_forward');
  });

  it('returns results in same order as input', async () => {
    const claims: ExtractedClaim[] = [
      makeClaim('identity_claim', 'canonical_label', 'A'),
      makeClaim('identity_claim', 'canonical_label', 'B'),
      makeClaim('identity_claim', 'canonical_label', 'C'),
    ];
    const results = await routeAndVerify(claims, [], '', null);
    expect(results.map((r) => r.claimId)).toEqual(claims.map((c) => c.id));
  });

  it('hybrid claim uses deterministic when evidence available', async () => {
    const claims: ExtractedClaim[] = [makeClaim('derived_structured_claim', 'body', '0.7')];
    const evidence: EvidenceRecord[] = [{ body: 0.8 }];
    const results = await routeAndVerify(claims, evidence, '', null);
    expect(results[0]?.verifierUsed).toBe('hybrid');
    expect(results[0]?.matchType).toBe('range_match');
  });

  it('handles empty claim list', async () => {
    const results = await routeAndVerify([], [], '', null);
    expect(results).toEqual([]);
  });
});

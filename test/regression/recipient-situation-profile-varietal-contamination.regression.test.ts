/**
 * recipient-situation-profile query-classifier varietal-contamination regression.
 *
 * Bug: UNKNOWN_PREFERENCE_RECIPIENT_QUERY_SIGNALS included specific grape
 * varieties ('merlot', 'pinot noir'). Naming a specific grape in the QUERY is
 * a *preference expression* — the opposite of "I don't know their preference".
 * A bare "merlot 추천" / "pinot noir recommendation" therefore mis-classified as
 * the unknown-preference recipient profile (domain contamination of the
 * situation classifier).
 *
 * Fix: drop the grape-variety tokens from the QUERY-string signal vocabulary.
 * The genuine crowd-pleaser cues ('crowd pleasing', 'safe', 'prosecco',
 * 'cava', 'pinot grigio', Korean '무난'/'안전한'/...) remain. The CANDIDATE-side
 * evidence axes (a wine that *is* a Merlot/Pinot-Noir → crowd_pleasing_red) and
 * the retrieval-term expansion are unchanged — those operate on wine attributes,
 * not on the user's stated intent.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyRecipientSituationProfile,
  recipientProfileEvidenceAxes,
  recipientProfileToRetrievalTerms,
} from '../../src/domain/query/service/recipient-situation-profile.js';

describe('recipient-situation-profile — grape variety is not an unknown-preference signal', () => {
  it('a bare grape-variety query does NOT classify as unknown_preference_recipient', () => {
    for (const q of [
      'merlot 추천해줘',
      'recommend a merlot',
      'pinot noir for dinner',
      '피노누아 와인 추천',
    ]) {
      const result = classifyRecipientSituationProfile(q);
      expect(result.profile).not.toBe('unknown_preference_recipient');
    }
  });

  it('genuine crowd-pleaser cues still classify as unknown_preference_recipient', () => {
    for (const q of [
      "crowd pleasing safe wine for someone whose taste I don't know",
      'cava prosecco for the crowd',
      '취향을 잘 모르는 사람한테 줄 무난한 와인',
    ]) {
      const result = classifyRecipientSituationProfile(q);
      expect(result.profile).toBe('unknown_preference_recipient');
      expect(result.confidence).toBeGreaterThan(0);
    }
  });

  it('candidate-side crowd_pleasing_red axis (wine IS a Merlot/Pinot Noir) is unchanged', () => {
    const axes = recipientProfileEvidenceAxes(
      { wineType: 'red', grapePrimary: 'Merlot' },
      'unknown_preference_recipient',
    );
    expect(axes).toContain('crowd_pleasing_red');
  });

  it('retrieval-term expansion for unknown preference still includes crowd-pleasing reds', () => {
    const terms = recipientProfileToRetrievalTerms('unknown_preference_recipient');
    expect(terms).toContain('merlot');
    expect(terms).toContain('pinot noir');
  });
});

/**
 * recipient-situation-profile query-classifier: grape-variety vs wine-style
 * consistency in the unknown-preference signal vocabulary.
 *
 * Background: an earlier change (W4) dropped the grape varieties 'merlot' /
 * 'pinot noir' from UNKNOWN_PREFERENCE_RECIPIENT_QUERY_SIGNALS on the principle
 * "naming a specific grape in the QUERY is a preference expression, not the
 * absence of one". But the same list still carried OTHER grape varieties —
 * 'pinot grigio' and 'pinot gris' — leaving the rule self-contradictory: a bare
 * "merlot 추천" was correctly NOT unknown-preference, yet a bare "pinot grigio
 * 추천" still classified AS unknown-preference.
 *
 * Fix (consistent application of the W4 principle): grape-variety tokens are
 * removed from the QUERY-string signal vocabulary across the board — 'pinot
 * grigio' and 'pinot gris' join 'merlot' / 'pinot noir' in being excluded.
 *
 * Style / category cues that name a CROWD-PLEASING WINE CATEGORY (not a grape)
 * stay, because naming a category for an unknown recipient is a genuine
 * crowd-pleaser cue, not a precise varietal preference:
 *   - 'prosecco', 'cava'  → sparkling-wine styles / appellations (not grapes)
 *   - 'crowd pleasing', 'safe', 'universal', Korean '무난'/'안전한'/...
 *
 * Candidate-side evidence axes (a wine that IS a Pinot Grigio →
 * crowd_pleasing_white) and the retrieval-term expansion are UNCHANGED — those
 * operate on wine attributes, not on the user's stated intent.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyRecipientSituationProfile,
  recipientProfileEvidenceAxes,
  recipientProfileToRetrievalTerms,
} from '../../src/domain/query/service/recipient-situation-profile.js';

describe('recipient-situation-profile — grape varieties (incl. pinot grigio/gris) are not unknown-preference signals', () => {
  it('a bare pinot-grigio / pinot-gris query does NOT classify as unknown_preference_recipient', () => {
    for (const q of [
      'recommend a pinot grigio',
      'pinot grigio 추천해줘',
      'pinot gris for dinner',
      '피노 그리지오 와인',
    ]) {
      const result = classifyRecipientSituationProfile(q);
      expect(result.profile).not.toBe('unknown_preference_recipient');
    }
  });

  it('grape varieties are treated consistently: merlot and pinot grigio behave the same way', () => {
    const merlot = classifyRecipientSituationProfile('recommend a merlot');
    const pinotGrigio = classifyRecipientSituationProfile('recommend a pinot grigio');
    // Neither names a recipient situation; both must avoid the
    // unknown-preference profile. (Same outcome = the consistency this test
    // guards.)
    expect(merlot.profile).not.toBe('unknown_preference_recipient');
    expect(pinotGrigio.profile).not.toBe('unknown_preference_recipient');
  });

  it('style/category crowd-pleaser cues (prosecco/cava) still classify as unknown_preference_recipient', () => {
    for (const q of [
      'cava prosecco for the crowd',
      "a safe crowd pleasing prosecco for someone whose taste I don't know",
    ]) {
      const result = classifyRecipientSituationProfile(q);
      expect(result.profile).toBe('unknown_preference_recipient');
      expect(result.confidence).toBeGreaterThan(0);
    }
  });

  it('candidate-side crowd_pleasing_white axis (wine IS a Pinot Grigio) is unchanged', () => {
    const axes = recipientProfileEvidenceAxes(
      { wineType: 'white', grapePrimary: 'Pinot Grigio' },
      'unknown_preference_recipient',
    );
    expect(axes).toContain('crowd_pleasing_white');
  });

  it('retrieval-term expansion for unknown preference still includes crowd-pleasing whites', () => {
    const terms = recipientProfileToRetrievalTerms('unknown_preference_recipient');
    expect(terms).toContain('pinot grigio');
  });
});

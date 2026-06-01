/**
 * Entity Lookup V2 — front-door admission / concept gate (T-ELV2-02 seam).
 *
 * This is the *baseline* gate landed with T-ELV2-01: it owns the port and
 * closes the obviously-non-entity inputs (empty / pure-noise / under-specified)
 * BEFORE any retrieval runs. T-ELV2-02 deepens it with the concept/facet
 * lexicon so grape/style/region concept queries (e.g. `까쇼`) redirect to
 * discovery instead of attempting entity resolution.
 *
 * Hard rule (RFC §forbidden): the gate decides from the normalized views, NOT
 * by running the resolver and inspecting the result. It must never be a
 * post-hoc reject.
 */

import type {
  LookupAdmissionGatePort,
  LookupAdmissionInput,
  LookupAdmissionVerdict,
} from './lookup-v2-types.js';
import { classifyConcept } from './concept-lexicon.js';

/**
 * Minimum number of alphanumeric (incl. CJK) characters for a query to be a
 * plausible entity reference. Shorter inputs ("a", "?", "  ") carry no
 * resolvable identity signal and would only invite wrong-positives — closing
 * them is the precision-first default (RFC §4.4 under-specified short reject).
 *
 * 2 is intentional: single-character queries are never an entity reference in
 * this domain, while 2-character producer initialisms (e.g. "CM", "DRC"→3) do
 * occur and must still be admitted to the alias/abbreviation channel.
 */
export const LOOKUP_ADMISSION_MIN_SIGNAL_CHARS = 2;

/** Counts letters/digits across scripts (Latin, Hangul, CJK, etc.). */
function countSignalChars(value: string): number {
  let count = 0;
  for (const ch of value) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
      count += 1;
    }
  }
  return count;
}

export class ConceptAdmissionGate implements LookupAdmissionGatePort {
  classify(input: LookupAdmissionInput): LookupAdmissionVerdict {
    const probe = input.views.strict.trim();

    if (probe.length === 0) {
      return {
        decision: 'reject',
        reasonCode: 'empty_query',
        detail: 'The query contains no resolvable content.',
      };
    }

    if (countSignalChars(probe) < LOOKUP_ADMISSION_MIN_SIGNAL_CHARS) {
      return {
        decision: 'reject',
        reasonCode: 'under_specified',
        detail: 'The query is too short to reference a specific wine entity.',
      };
    }

    // Concept / facet gate: a query composed ENTIRELY of concept tokens
    // (grape / region / style / occasion) carries no entity signal and must
    // redirect to discovery search rather than attempt entity resolution.
    const concept = classifyConcept(input.views);
    if (concept.isConceptOnly) {
      if (concept.hasConceptTerm) {
        return {
          decision: 'redirect_discovery',
          reasonCode: 'concept_query',
          detail: `This describes a class of wines (${concept.terms.join(', ')}) — redirected to discovery search.`,
          conceptTermsMatched: concept.terms,
        };
      }
      // No concept term and no residual proper-name token: a bare generic
      // ("wine", "와인 추천") with no resolvable identity. Still a discovery
      // intent, not an entity reference.
      return {
        decision: 'redirect_discovery',
        reasonCode: 'generic_non_entity_query',
        detail: 'The query is generic and does not reference a specific wine — redirected to discovery search.',
      };
    }

    // A residual proper-name token remains → plausible entity reference. Admit
    // it to resolution; the calibrated decision layer (T-ELV2-05) closes noisy
    // non-matches as failed/ambiguous rather than wrong-resolving.
    return {
      decision: 'admit',
      reasonCode: 'admitted_entity_reference',
      detail: 'The query carries an entity-reference signal.',
      ...(concept.terms.length > 0 ? { conceptTermsMatched: concept.terms } : {}),
    };
  }
}

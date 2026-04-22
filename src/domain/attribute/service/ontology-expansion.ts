/**
 * RFC-019 Stage 3: Ontology Expansion
 *
 * Takes direct constraints from NL Mapper and expands them using wine-domain
 * ontology (region hierarchy, grape family, producer-region, etc.) to produce
 * additional soft/inferred constraints.
 *
 * Example:
 *   input:  hard [{region: 'Pauillac'}]
 *   output: hard [{region: 'Pauillac'}]
 *           inferred [{region: 'Haut-Médoc'}, {region: 'Médoc'}, {region: 'Bordeaux'}, {country: 'France'}]
 *
 * Design constraints (RFC-004 §3.1):
 *   - Deterministic (no LLM)
 *   - Versioned (mappingVersion)
 *   - Hard constraints are PRESERVED (never demoted)
 *   - Soft/inferred are ADDED (never replace hard)
 *   - Provenance recorded in source_phrase and mapping_version
 */

import type {
  ConstraintBundle,
  NormalizedConstraint,
} from '../../shared/types/constraint-bundle.js';
import { regionAncestors, REGION_PARENTS } from '../../evaluation/service/wine-ontology.js';
import { wineTitleCase } from '../../shared/utils/title-case.js';
import { canonicalJsonStringify } from '../../shared/utils/canonical-json.js';

/** Version identifier embedded in generated constraints for replay parity. */
const ONTOLOGY_EXPANSION_VERSION = 'ontology-v1.0';

/** Confidence discount applied to inferred expansions (weakest tier). */
const ONTOLOGY_INFERRED_CONFIDENCE = 0.7;

/**
 * Country-only words that can appear as the last element of a region hierarchy.
 * These are emitted as inferred country constraints during expansion.
 *
 * The hierarchy arrays in wine-ontology.ts always end in a country name, so we
 * detect it structurally rather than maintaining a separate country list here.
 * This keeps the two tables in sync automatically.
 */
const KNOWN_COUNTRY_ROOTS: ReadonlySet<string> = (() => {
  const roots = new Set<string>();
  for (const parents of REGION_PARENTS.values()) {
    const last = parents[parents.length - 1];
    if (last !== undefined) {
      roots.add(last);
    }
  }
  return roots;
})();

/**
 * Expand a constraint bundle with ontology-derived constraints.
 *
 * Preserves all existing hard/soft/inferred entries unchanged. Additions are
 * appended — never modifies or removes existing ones. Duplicates (same
 * attribute+operator+value) are deduplicated against the original bundle.
 */
export function expandWithOntology(bundle: ConstraintBundle): ConstraintBundle {
  const newSoft: NormalizedConstraint[] = [...bundle.soft];
  const newInferred: NormalizedConstraint[] = [...bundle.inferred];
  // Build a dedup key set from the existing bundle to prevent re-adding the
  // same (attribute, operator, value) triple from a different layer.
  const seenKeys = new Set<string>([
    ...bundle.hard.map(keyOf),
    ...bundle.soft.map(keyOf),
    ...bundle.inferred.map(keyOf),
  ]);

  const pushIfNew = (target: NormalizedConstraint[], c: NormalizedConstraint): void => {
    const key = keyOf(c);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    target.push(c);
  };

  // ── Region hierarchy expansion ─────────────────────────────────
  // A hard `region=Pauillac` generates inferred constraints for each ancestor
  // in the chain. These are true ontology entailments, not user-stated soft
  // preferences; downstream can use them as contextual boosts without polluting
  // the explicit slot layer.
  for (const hard of bundle.hard) {
    if (hard.attribute !== 'region' || hard.operator !== '=' || typeof hard.value !== 'string') {
      continue;
    }
    const ancestors = regionAncestors(hard.value);
    if (ancestors.length === 0) continue;

    for (let i = 0; i < ancestors.length; i++) {
      const ancestor = ancestors[i]!;
      const isCountry = i === ancestors.length - 1 && KNOWN_COUNTRY_ROOTS.has(ancestor);
      if (isCountry) {
        pushIfNew(newInferred, {
          attribute: 'country',
          operator: '=',
          value: wineTitleCase(ancestor),
          source_phrase: `ontology(${hard.value}→${ancestor})`,
          confidence: hard.confidence * ONTOLOGY_INFERRED_CONFIDENCE,
          mapping_version: ONTOLOGY_EXPANSION_VERSION,
        });
      } else {
        // Intermediate region ancestors → inferred (weakest tier) because the
        // user asked about the child region, not the parent — retrieval boost
        // is desirable but hard filter would over-match.
        pushIfNew(newInferred, {
          attribute: 'region',
          operator: '=',
          value: wineTitleCase(ancestor),
          source_phrase: `ontology(${hard.value}⊂${ancestor})`,
          confidence: hard.confidence * ONTOLOGY_INFERRED_CONFIDENCE,
          mapping_version: ONTOLOGY_EXPANSION_VERSION,
        });
      }
    }
  }

  // ── Appellation → region expansion ─────────────────────────────
  // `appellation=Pauillac` implies `region=Bordeaux` (via ancestors lookup).
  // Same mechanism: appellations are registered in REGION_PARENTS too.
  for (const hard of bundle.hard) {
    if (hard.attribute !== 'appellation' || hard.operator !== '=' || typeof hard.value !== 'string') {
      continue;
    }
    const ancestors = regionAncestors(hard.value);
    if (ancestors.length === 0) continue;

    for (let i = 0; i < ancestors.length; i++) {
      const ancestor = ancestors[i]!;
      const isCountry = i === ancestors.length - 1 && KNOWN_COUNTRY_ROOTS.has(ancestor);
      pushIfNew(newInferred, {
        attribute: isCountry ? 'country' : 'region',
        operator: '=',
        value: wineTitleCase(ancestor),
        source_phrase: `ontology(appellation:${hard.value}→${ancestor})`,
        confidence: hard.confidence * ONTOLOGY_INFERRED_CONFIDENCE,
        mapping_version: ONTOLOGY_EXPANSION_VERSION,
      });
    }
  }

  return {
    hard: bundle.hard,
    soft: newSoft,
    inferred: newInferred,
  };
}

function keyOf(c: NormalizedConstraint): string {
  // canonicalJsonStringify sorts object keys so range constraints
  // ({min,max} vs {max,min}) produce the same dedup key. (Bugbash Round 18)
  return `${c.attribute}|${c.operator}|${canonicalJsonStringify(c.value)}`;
}

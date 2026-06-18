import { describe, expect, it } from 'vitest';
import {
  CurationAliasEvidenceSchema,
  CurationAmbiguityEvidenceSchema,
  normalizeLegacyCurationEvidence,
  parseCurationAliasEvidence,
  parseCurationAmbiguityEvidence,
  parseCurationSuppressionEvidence,
  readCanonicalCurationEvidence,
  wireCurationEvidenceFromDomain,
} from '../../../src/domain/curation/model/curation-proposal-evidence.js';

describe('curation-proposal-evidence', () => {
  it('accepts minimal alias evidence and rejects unknown keys', () => {
    expect(parseCurationAliasEvidence({})).toEqual({});
    expect(() => CurationAliasEvidenceSchema.parse({ extra: true })).toThrow();
  });

  it('normalizes legacy ops-console note into operatorNote', () => {
    expect(parseCurationAliasEvidence({
      source: 'ops_console',
      note: 'verified on menu',
    })).toEqual({
      source: 'ops_console',
      operatorNote: 'verified on menu',
    });
    expect(parseCurationAmbiguityEvidence({
      source: 'ops_console',
      note: 'cluster review',
    })).toEqual({
      source: 'ops_console',
      operatorNote: 'cluster review',
    });
    expect(parseCurationSuppressionEvidence({
      source: 'playground',
      note: 'bad mapping',
    })).toEqual({
      source: 'playground',
      operatorNote: 'bad mapping',
    });
  });

  it('normalizes RFC-014 snake_case operator_note into operatorNote', () => {
    expect(parseCurationAliasEvidence({
      source: 'ops_console',
      operator_note: 'wire verified',
    })).toEqual({
      source: 'ops_console',
      operatorNote: 'wire verified',
    });
    expect(parseCurationAliasEvidence({
      source: 'ops_console',
      operatorNote: 'canonical wins',
      operator_note: 'ignored',
      note: 'ignored too',
    })).toEqual({
      source: 'ops_console',
      operatorNote: 'canonical wins',
    });
  });

  it('normalizes snake_case alias evidence wire keys', () => {
    expect(parseCurationAliasEvidence({
      source: 'ops_console',
      source_trust: 0.8,
      alias_scope: 'locale_ko',
    })).toEqual({
      source: 'ops_console',
      sourceTrust: 0.8,
      aliasScope: 'locale_ko',
    });
  });

  it('drops empty legacy note without fabricating operatorNote', () => {
    expect(normalizeLegacyCurationEvidence({ source: 'playground', note: '' })).toEqual({
      source: 'playground',
    });
    expect(parseCurationAliasEvidence({ source: 'playground', note: '' })).toEqual({
      source: 'playground',
    });
  });

  it('drops unknown evidence keys before strict validation', () => {
    expect(parseCurationAliasEvidence({
      source: 'ops_console',
      note: 'verified',
      extra: true,
    })).toEqual({
      source: 'ops_console',
      operatorNote: 'verified',
    });
  });

  it('accepts ambiguity severity and types', () => {
    const parsed = parseCurationAmbiguityEvidence({
      ambiguityTypes: ['operator_curation'],
      severity: 'high',
    });
    expect(parsed.severity).toBe('high');
    expect(() => CurationAmbiguityEvidenceSchema.parse({ severity: 'critical' })).toThrow();
  });

  it('readCanonicalCurationEvidence normalizes snake_case wire keys per kind', () => {
    expect(readCanonicalCurationEvidence('alias', {
      source: 'ops_console',
      source_trust: 0.75,
      alias_scope: 'global',
      reason: 'dropped',
    })).toEqual({
      source: 'ops_console',
      sourceTrust: 0.75,
      aliasScope: 'global',
    });
    expect(readCanonicalCurationEvidence('ambiguity', {
      ambiguity_types: ['operator_curation'],
      severity: 'medium',
    })).toEqual({
      ambiguityTypes: ['operator_curation'],
      severity: 'medium',
    });
  });

  it('wireCurationEvidenceFromDomain maps canonical domain keys to RFC-014 wire keys', () => {
    expect(wireCurationEvidenceFromDomain({
      source: 'ops_console',
      sourceTrust: 0.8,
      aliasScope: 'locale_ko',
      operatorNote: 'verified',
    })).toEqual({
      source: 'ops_console',
      source_trust: 0.8,
      alias_scope: 'locale_ko',
      operator_note: 'verified',
    });
  });
});

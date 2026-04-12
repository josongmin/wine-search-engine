import { normalizeForMatch } from '../../src/domain/alias/service/alias-matcher.js';
import { Transliterator } from '../../src/domain/alias/service/transliterator.js';
import type { EnrichedSilverRecord } from './types.js';
import { inferTransliterationSourceLang } from './transliteration-helpers.js';
import type { CanonicalEntityId, SourceRecordId } from '../../src/domain/shared/types/entity-id.js';
import { hashText, type AliasSnapshotRecord } from './search-snapshot-schema.js';

export function hasHangul(text: string): boolean {
  return /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/u.test(text);
}

function buildAliasId(
  entityId: CanonicalEntityId,
  normalizedValue: string,
  type: string,
  scope: string,
): string {
  return hashText([entityId, normalizedValue, type, scope].join('\n'));
}

function buildAliasRecord(
  entityId: CanonicalEntityId,
  value: string,
  type: string,
  source: string,
  confidencePrior: number,
  scope: string,
): AliasSnapshotRecord {
  const normalizedValue = normalizeForMatch(value);
  return {
    aliasId: buildAliasId(entityId, normalizedValue, type, scope),
    entityId,
    value,
    normalizedValue,
    type,
    scope,
    source,
    sourceTrust: 1.0,
    confidencePrior,
  };
}

function buildBaseAliases(
  record: EnrichedSilverRecord,
  entityId: CanonicalEntityId,
): readonly AliasSnapshotRecord[] {
  return [
    buildAliasRecord(
      entityId,
      record.canonicalLabel,
      'canonical',
      'snapshot:canonical_label_v1',
      1.0,
      'global',
    ),
    ...record.aliases.proposed.map((proposal) =>
      buildAliasRecord(
        entityId,
        proposal.value,
        proposal.type,
        proposal.source,
        proposal.confidencePrior,
        hasHangul(proposal.value) ? 'locale_ko' : 'global',
      )),
  ];
}

export function buildAliasArtifact(
  records: readonly EnrichedSilverRecord[],
  entityIdBySourceId: ReadonlyMap<SourceRecordId, CanonicalEntityId>,
): readonly AliasSnapshotRecord[] {
  const transliterator = new Transliterator();
  const aliases = new Map<string, AliasSnapshotRecord>();

  for (const record of records) {
    const entityId = entityIdBySourceId.get(record.sourceId);
    if (entityId == null) {
      throw new Error(`Missing canonical entityId mapping for sourceId=${record.sourceId}`);
    }
    const baseAliases = buildBaseAliases(record, entityId);
    const lang = inferTransliterationSourceLang(record.country, record.region);

    for (const alias of baseAliases) {
      aliases.set(alias.aliasId, alias);
      if (alias.scope !== 'global' || hasHangul(alias.value)) {
        continue;
      }

      const transliterations = transliterator.generateAliases(alias.value, lang).map((variant) =>
        buildAliasRecord(
          entityId,
          variant.value,
          variant.type,
          `snapshot:transliterator_v1:${alias.source}`,
          variant.confidence,
          'locale_ko',
        ));

      for (const transliterated of transliterations) {
        aliases.set(transliterated.aliasId, transliterated);
      }
    }
  }

  return [...aliases.values()].sort((left, right) =>
    left.normalizedValue.localeCompare(right.normalizedValue)
    || left.entityId.localeCompare(right.entityId)
    || left.aliasId.localeCompare(right.aliasId),
  );
}

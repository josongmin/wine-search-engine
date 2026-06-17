import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import { computeAliasPhoneticKeys } from '../../src/domain/alias/service/alias-phonetic-keys.js';
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
  sourceTrust: number = 1.0,
): AliasSnapshotRecord {
  const normalizedValue = normalizeForMatch(value);
  const phoneticKeys = computeAliasPhoneticKeys(normalizedValue);
  return {
    aliasId: buildAliasId(entityId, normalizedValue, type, scope),
    entityId,
    value,
    normalizedValue,
    type,
    aliasType: type,
    scope,
    source,
    sourceTrust,
    confidencePrior,
    ...(phoneticKeys.length > 0 ? { phoneticKeys } : {}),
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

export interface SnapshotAliasOverlayProposal {
  readonly value: string;
  readonly type: string;
  readonly source: string;
  readonly confidencePrior: number;
  readonly scope: string;
  readonly sourceTrust: number;
}

export function buildAliasArtifact(
  records: readonly EnrichedSilverRecord[],
  entityIdBySourceId: ReadonlyMap<SourceRecordId, CanonicalEntityId>,
  overlayProposalsByEntityId: ReadonlyMap<CanonicalEntityId, readonly SnapshotAliasOverlayProposal[]> = new Map(),
): readonly AliasSnapshotRecord[] {
  const transliterator = new Transliterator();
  const aliases = new Map<string, AliasSnapshotRecord>();

  for (const record of records) {
    const entityId = entityIdBySourceId.get(record.sourceId);
    if (entityId == null) {
      throw new Error(`Missing canonical entityId mapping for sourceId=${record.sourceId}`);
    }
    const baseAliases = buildBaseAliases(record, entityId);
    const overlayAliases = (overlayProposalsByEntityId.get(entityId) ?? []).map((proposal) =>
      buildAliasRecord(
        entityId,
        proposal.value,
        proposal.type,
        proposal.source,
        proposal.confidencePrior,
        proposal.scope,
        proposal.sourceTrust,
      ),
    );
    const lang = inferTransliterationSourceLang(record.country, record.region);

    for (const alias of [...baseAliases, ...overlayAliases]) {
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
        ),
      );

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

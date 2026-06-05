import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildLookupAmbiguityRegistryEntries,
  buildLookupConceptRedirectRegistryEntries,
  loadLookupAmbiguityRegistry,
  loadLookupConceptRedirectRegistry,
} from '../../../scripts/etl/lookup-authority-registries.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lookup-authority-registries-'));
}

describe('lookup authority registries', () => {
  it('loads ambiguity registry rows and normalizes them into runtime entries', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'lookup-ambiguity-registry-v1.jsonl');
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          surface: '샤또',
          locale: 'ko',
          ambiguityTypes: ['broad_icon'],
          severity: 'high',
          sourceEvidence: 'test',
          reviewedAt: '2026-06-04T00:00:00.000Z',
        }),
      ].join('\n'),
    );

    const rows = await loadLookupAmbiguityRegistry(filePath);
    const entries = buildLookupAmbiguityRegistryEntries(rows);

    expect(entries).toEqual([
      {
        normalizedForm: '샤또',
        types: ['broad_icon'],
        severity: 'high',
      },
    ]);
  });

  it('fails closed on ambiguity normalized collisions', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'lookup-ambiguity-registry-v1.jsonl');
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          surface: '샤또',
          locale: 'ko',
          ambiguityTypes: ['broad_icon'],
          severity: 'high',
          sourceEvidence: 'test',
          reviewedAt: '2026-06-04T00:00:00.000Z',
        }),
        JSON.stringify({
          surface: ' 샤또 ',
          locale: 'ko',
          ambiguityTypes: ['producer_collision'],
          severity: 'high',
          sourceEvidence: 'test',
          reviewedAt: '2026-06-04T00:00:00.000Z',
        }),
      ].join('\n'),
    );

    await expect(loadLookupAmbiguityRegistry(filePath)).rejects.toThrow(/collision/);
  });

  it('fails closed on invalid ambiguity severity', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'lookup-ambiguity-registry-v1.jsonl');
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          surface: '샤또',
          locale: 'ko',
          ambiguityTypes: ['broad_icon'],
          severity: 'critical',
          sourceEvidence: 'test',
          reviewedAt: '2026-06-04T00:00:00.000Z',
        }),
      ].join('\n'),
    );

    await expect(loadLookupAmbiguityRegistry(filePath)).rejects.toThrow(/invalid severity/);
  });

  it('loads concept redirect registry rows and normalizes them into runtime entries', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'lookup-concept-redirect-registry-v1.jsonl');
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          surface: '샴페인 추천',
          locale: 'ko',
          conceptClass: 'recommendation',
          redirectReason: 'concept_query',
          sourceEvidence: 'test',
          reviewedAt: '2026-06-04T00:00:00.000Z',
        }),
      ].join('\n'),
    );

    const rows = await loadLookupConceptRedirectRegistry(filePath);
    const entries = buildLookupConceptRedirectRegistryEntries(rows);

    expect(entries).toEqual([
      {
        normalizedForm: '샴페인 추천',
        locale: 'ko',
        conceptClass: 'recommendation',
        redirectReason: 'concept_query',
        sourceEvidence: 'test',
      },
    ]);
  });

  it('fails closed on concept redirect normalized collisions', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'lookup-concept-redirect-registry-v1.jsonl');
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          surface: '샴페인 추천',
          locale: 'ko',
          conceptClass: 'recommendation',
          redirectReason: 'concept_query',
          sourceEvidence: 'test',
          reviewedAt: '2026-06-04T00:00:00.000Z',
        }),
        JSON.stringify({
          surface: ' 샴페인 추천 ',
          locale: 'ko',
          conceptClass: 'pairing',
          redirectReason: 'concept_query',
          sourceEvidence: 'test',
          reviewedAt: '2026-06-04T00:00:00.000Z',
        }),
      ].join('\n'),
    );

    await expect(loadLookupConceptRedirectRegistry(filePath)).rejects.toThrow(/collision/);
  });

  it('fails closed on invalid concept redirect class', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'lookup-concept-redirect-registry-v1.jsonl');
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          surface: '샴페인 추천',
          locale: 'ko',
          conceptClass: 'food',
          redirectReason: 'concept_query',
          sourceEvidence: 'test',
          reviewedAt: '2026-06-04T00:00:00.000Z',
        }),
      ].join('\n'),
    );

    await expect(loadLookupConceptRedirectRegistry(filePath)).rejects.toThrow(/invalid conceptClass/);
  });
});

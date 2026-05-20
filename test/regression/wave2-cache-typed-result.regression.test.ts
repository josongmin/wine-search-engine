/**
 * Wave 2 — Cache typed result regression.
 *
 * Contract:
 *   - CacheGetResult discriminated union distinguishes hit / miss /
 *     breaker_open / infra_error / corrupt_entry.
 *   - Redis circuit-breaker wrapper exposes typed methods (getTyped,
 *     setTyped, delTyped) alongside legacy `string | null` shims.
 *   - All adapter catch blocks that collapse to "miss" now increment a
 *     silent-skip counter tagged with the real error class so dashboards
 *     can alert on infra failures separately from legitimate misses.
 */
import { describe, expect, it } from 'vitest';
import {
  cacheBreakerOpen,
  cacheCorruptEntry,
  cacheHit,
  cacheInfraError,
  cacheMiss,
  toLegacyGetValue,
  writeBreakerOpen,
  writeInfraError,
  writeOk,
} from '../../src/domain/performance/port/cache-result.js';

describe('Wave 2 / CacheGetResult discriminant', () => {
  it('hit carries value', () => {
    const r = cacheHit('abc');
    expect(r.kind).toBe('hit');
    if (r.kind === 'hit') expect(r.value).toBe('abc');
  });

  it('miss has no value', () => {
    const r = cacheMiss<string>();
    expect(r.kind).toBe('miss');
  });

  it('breaker_open is distinct from miss', () => {
    const r = cacheBreakerOpen<string>();
    expect(r.kind).toBe('breaker_open');
    expect(r.kind).not.toBe('miss');
  });

  it('infra_error carries error class + message', () => {
    const err = new TypeError('network down');
    const r = cacheInfraError<string>(err);
    expect(r.kind).toBe('infra_error');
    if (r.kind === 'infra_error') {
      expect(r.errorClass).toBe('TypeError');
      expect(r.message).toBe('network down');
    }
  });

  it('corrupt_entry carries reason', () => {
    const r = cacheCorruptEntry<string>('schema_mismatch');
    expect(r.kind).toBe('corrupt_entry');
    if (r.kind === 'corrupt_entry') expect(r.reason).toBe('schema_mismatch');
  });

  it('toLegacyGetValue maps all non-hit kinds to null', () => {
    expect(toLegacyGetValue(cacheMiss<string>())).toBeNull();
    expect(toLegacyGetValue(cacheBreakerOpen<string>())).toBeNull();
    expect(toLegacyGetValue(cacheInfraError<string>(new Error('x')))).toBeNull();
    expect(toLegacyGetValue(cacheCorruptEntry<string>('x'))).toBeNull();
    expect(toLegacyGetValue(cacheHit('present'))).toBe('present');
  });
});

describe('Wave 2 / CacheWriteResult', () => {
  it('ok, breaker_open, infra_error are distinct', () => {
    const ok = writeOk();
    const bo = writeBreakerOpen();
    const infra = writeInfraError(new Error('pipe broken'));
    expect(ok.kind).toBe('ok');
    expect(bo.kind).toBe('breaker_open');
    expect(infra.kind).toBe('infra_error');
    if (infra.kind === 'infra_error') {
      expect(infra.errorClass).toBe('Error');
    }
  });
});

describe('Wave 2 / adapter source-level wiring', () => {
  it('redis-circuit-breaker-wrapper exposes getTyped/setTyped/delTyped', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/db/redis-circuit-breaker-wrapper.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/async getTyped\(/);
    expect(src).toMatch(/async setTyped\(/);
    expect(src).toMatch(/async delTyped\(/);
    // Breaker-open path increments silent-skip counter with reason:'breaker_open'.
    expect(src).toMatch(/cache_read_failure['"], \{ reason: ['"]breaker_open['"]/);
    expect(src).toMatch(/cache_write_failure['"], \{ reason: ['"]breaker_open['"]/);
  });

  it('redis-cache.getValidated tags corrupt_entry separately from miss', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/adapter/redis-cache.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/errorClass: ['"]corrupt_entry['"]/);
    expect(src).toMatch(/errorClass: ['"]corrupt_entry_json_parse['"]/);
    expect(src).toMatch(/errorClass: ['"]corrupt_entry_schema_mismatch['"]/);
  });

  it('redis-query-cache.stats tags infra_error on failure', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/cache/redis-query-cache.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/redis-query-cache\.stats/);
    expect(src).toMatch(/infra_error/);
  });

  it('redis-embedding-cache tags write/delete failures', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/cache/redis-embedding-cache.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/surface: ['"]embedding\.write['"]/);
    expect(src).toMatch(/surface: ['"]embedding\.delete['"]/);
  });

  it('llm-injection-judge distinguishes corrupt_entry from infra_error', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/domain/security/service/llm-injection-judge.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/surface: ['"]injection_judge['"]/);
    expect(src).toMatch(/corrupt_entry_json_parse/);
    expect(src).toMatch(/corrupt_entry_shape_mismatch/);
    expect(src).toMatch(/cache poisoning/i);
  });

  it('search-usecase-cache-lookup separates infra_error from miss in logs', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/application/search/search-usecase-cache-lookup.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/surface: ['"]search_response['"]/);
    expect(src).toMatch(/infra_error/);
    expect(src).toMatch(/corrupt_entry/);
  });
});

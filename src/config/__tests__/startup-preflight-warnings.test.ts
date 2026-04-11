/**
 * E3-T7: RCA-03 — Startup pre-flight validation warnings.
 *
 * Verifies that warnStartupMisconfigurations() logs the appropriate
 * warning messages when essential config is missing.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { warnStartupMisconfigurations } from '../startup-preflight.js';
import { bootstrapLogger } from '../bootstrap-logger.js';

describe('warnStartupMisconfigurations (E3-T7)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs VESPA_URL warning when vespa url is missing', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn');

    warnStartupMisconfigurations({
      vespa: { url: undefined },
      embedding: { url: undefined },
      openai: { apiKey: undefined },
      cohere: { apiKey: undefined },
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('VESPA_URL'),
    );
  });

  it('logs embedding warning when neither embedding.url nor openai.apiKey is set', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn');

    warnStartupMisconfigurations({
      vespa: { url: 'http://vespa:8080' },
      embedding: { url: undefined },
      openai: { apiKey: undefined },
      cohere: { apiKey: undefined },
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('embedding'),
    );
  });

  it('logs reranker warning when cohere.apiKey is not set', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn');

    warnStartupMisconfigurations({
      vespa: { url: 'http://vespa:8080' },
      embedding: { url: 'http://embedding:8080' },
      openai: { apiKey: undefined },
      cohere: { apiKey: undefined },
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('reranker'),
    );
  });

  it('logs no warnings when all required config is present', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn');

    warnStartupMisconfigurations({
      vespa: { url: 'http://vespa:8080' },
      embedding: { url: undefined },
      openai: { apiKey: 'sk-test' },
      cohere: { apiKey: 'co-test' },
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not log embedding warning when openai.apiKey is present', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn');

    warnStartupMisconfigurations({
      vespa: { url: 'http://vespa:8080' },
      embedding: { url: undefined },
      openai: { apiKey: 'sk-test' },
      cohere: { apiKey: 'co-test' },
    });

    // embedding warning should NOT be logged because openai.apiKey is provided
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    const embeddingWarn = warnCalls.find((msg) => msg.includes('embedding'));
    expect(embeddingWarn).toBeUndefined();
  });
});

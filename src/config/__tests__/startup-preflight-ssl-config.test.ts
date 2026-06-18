/**
 * FIX #6: PG SSL startup sanity check.
 *
 * Verifies pgConfigSanityCheck() warns when PG_SSL is disabled while
 * connecting to a non-local host, and stays silent for local hosts, for
 * SSL-enabled connections, and for unparseable connection strings.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { pgConfigSanityCheck } from '../startup-preflight.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';

function warnedAboutSsl(spy: ReturnType<typeof vi.spyOn>): boolean {
  return spy.mock.calls.some((c) => JSON.stringify(c).includes('PG_SSL is disabled'));
}

describe('pgConfigSanityCheck (FIX #6)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns when PG_SSL is false and host is remote (discrete host)', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn');
    pgConfigSanityCheck({ ssl: false, host: 'db.prod.internal' });
    expect(warnedAboutSsl(warnSpy)).toBe(true);
  });

  it('warns when PG_SSL is false and connectionString host is remote', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn');
    pgConfigSanityCheck({
      ssl: false,
      connectionString: 'postgresql://wine:secret@my-rds.amazonaws.com:5432/wine_engine',
    });
    expect(warnedAboutSsl(warnSpy)).toBe(true);
  });

  it('does NOT warn when host is localhost', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn');
    pgConfigSanityCheck({ ssl: false, host: 'localhost' });
    expect(warnedAboutSsl(warnSpy)).toBe(false);
  });

  it('does NOT warn when host is 127.0.0.1', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn');
    pgConfigSanityCheck({ ssl: false, host: '127.0.0.1' });
    expect(warnedAboutSsl(warnSpy)).toBe(false);
  });

  it('does NOT warn when connectionString host is localhost', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn');
    pgConfigSanityCheck({
      ssl: false,
      connectionString: 'postgresql://wine:secret@localhost:5432/wine_engine',
    });
    expect(warnedAboutSsl(warnSpy)).toBe(false);
  });

  it('does NOT warn when PG_SSL is true even for a remote host', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn');
    pgConfigSanityCheck({ ssl: true, host: 'db.prod.internal' });
    expect(warnedAboutSsl(warnSpy)).toBe(false);
  });

  // CLAUDE.md rule 23: false-positive guard. 'local_admin' username contains
  // 'localhost'-ish substring, but the HOST is remote → MUST still warn.
  it('FALSE-POSITIVE GUARD: localhost-like substring in credentials, remote host → still warns', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn');
    pgConfigSanityCheck({
      ssl: false,
      connectionString: 'postgresql://local_admin:localhostpw@remote-db.example.com:5432/db',
    });
    expect(warnedAboutSsl(warnSpy)).toBe(true);
  });

  it('does NOT crash and does NOT warn on a malformed connection string', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn');
    expect(() =>
      pgConfigSanityCheck({ ssl: false, connectionString: 'not a valid url ::: @@@' }),
    ).not.toThrow();
    expect(warnedAboutSsl(warnSpy)).toBe(false);
  });

  it('does NOT crash and does NOT warn on empty connection string with no host', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn');
    expect(() => pgConfigSanityCheck({ ssl: false, connectionString: '' })).not.toThrow();
    expect(warnedAboutSsl(warnSpy)).toBe(false);
  });

  it('connectionString host takes precedence over discrete host field', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn');
    // discrete host says localhost, but the DSN points at a remote host →
    // the effective connection is remote → warn.
    pgConfigSanityCheck({
      ssl: false,
      host: 'localhost',
      connectionString: 'postgresql://u:p@remote-db.example.com:5432/db',
    });
    expect(warnedAboutSsl(warnSpy)).toBe(true);
  });
});

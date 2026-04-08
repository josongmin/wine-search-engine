import { describe, expect, it } from 'vitest';
import { abortError, isAbortError, throwIfAborted } from '../cooperative-abort.js';

describe('cooperative-abort', () => {
  describe('isAbortError', () => {
    it('returns true for Error with name AbortError', () => {
      const e = new Error('x');
      e.name = 'AbortError';
      expect(isAbortError(e)).toBe(true);
    });

    it('returns true for DOMException AbortError', () => {
      expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
    });

    it('returns false for other errors', () => {
      expect(isAbortError(new Error('boom'))).toBe(false);
      expect(isAbortError(new DOMException('x', 'NotFoundError'))).toBe(false);
      expect(isAbortError(null)).toBe(false);
    });
  });

  describe('throwIfAborted', () => {
    it('throws AbortError when signal is aborted', () => {
      const ac = new AbortController();
      ac.abort();
      expect(() => throwIfAborted(ac.signal, 'gone')).toThrowError(/gone/);
      try {
        throwIfAborted(ac.signal, 'gone');
      } catch (e) {
        expect(isAbortError(e)).toBe(true);
      }
    });

    it('no-ops when signal is undefined or not aborted', () => {
      expect(() => throwIfAborted(undefined, 'x')).not.toThrow();
      const ac = new AbortController();
      expect(() => throwIfAborted(ac.signal, 'x')).not.toThrow();
    });
  });

  describe('abortError', () => {
    it('sets cause when cause is Error', () => {
      const inner = new Error('inner');
      const e = abortError('outer', inner);
      expect(e.name).toBe('AbortError');
      expect(e.cause).toBe(inner);
    });
  });
});

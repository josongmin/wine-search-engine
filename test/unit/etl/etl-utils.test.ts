import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  atomicWriteFile,
  atomicWriteFileSync,
  backupFile,
  acquireLock,
  appendDeadLetter,
  Checkpoint,
  contentHash,
} from '../../../scripts/etl/etl-utils.js';

describe('etl-utils', () => {
  const tmpDir = path.join(os.tmpdir(), 'etl-utils-test');
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    for (const p of cleanupPaths) {
      await fs.rm(p, { recursive: true, force: true }).catch(() => {});
    }
    cleanupPaths.length = 0;
  });

  describe('atomicWriteFile', () => {
    it('writes content that can be read back', async () => {
      const dir = path.join(tmpDir, `atomic-${Date.now()}`);
      await fs.mkdir(dir, { recursive: true });
      cleanupPaths.push(dir);

      const filePath = path.join(dir, 'test.ndjson');
      await atomicWriteFile(filePath, 'hello\nworld\n');

      const content = await fs.readFile(filePath, 'utf8');
      expect(content).toBe('hello\nworld\n');
    });

    it('does not leave temp files on success', async () => {
      const dir = path.join(tmpDir, `atomic-clean-${Date.now()}`);
      await fs.mkdir(dir, { recursive: true });
      cleanupPaths.push(dir);

      const filePath = path.join(dir, 'test.json');
      await atomicWriteFile(filePath, '{}');

      const entries = await fs.readdir(dir);
      expect(entries).toEqual(['test.json']);
    });
  });

  describe('atomicWriteFileSync', () => {
    it('writes content synchronously', async () => {
      const dir = path.join(tmpDir, `sync-${Date.now()}`);
      await fs.mkdir(dir, { recursive: true });
      cleanupPaths.push(dir);

      const filePath = path.join(dir, 'sync.txt');
      atomicWriteFileSync(filePath, 'sync content');

      const content = await fs.readFile(filePath, 'utf8');
      expect(content).toBe('sync content');
    });
  });

  describe('Checkpoint', () => {
    it('tracks completed IDs and persists to disk', async () => {
      const dir = path.join(tmpDir, `ckpt-${Date.now()}`);
      await fs.mkdir(dir, { recursive: true });
      cleanupPaths.push(dir);

      const ckptPath = path.join(dir, 'checkpoint.json');
      const ckpt = await Checkpoint.load(ckptPath);

      expect(ckpt.isDone('a')).toBe(false);
      ckpt.markDone('a');
      ckpt.markDone('b');
      expect(ckpt.isDone('a')).toBe(true);
      expect(ckpt.completedCount()).toBe(2);
      expect(ckpt.dirtyCount()).toBe(2);

      await ckpt.flush();
      expect(ckpt.dirtyCount()).toBe(0);

      // Reload from disk
      const ckpt2 = await Checkpoint.load(ckptPath);
      expect(ckpt2.isDone('a')).toBe(true);
      expect(ckpt2.isDone('b')).toBe(true);
      expect(ckpt2.isDone('c')).toBe(false);
    });

    it('loads empty checkpoint when file does not exist', async () => {
      const ckpt = await Checkpoint.load('/tmp/nonexistent-checkpoint.json');
      expect(ckpt.completedCount()).toBe(0);
    });

    it('clear removes file and resets state', async () => {
      const dir = path.join(tmpDir, `ckpt-clear-${Date.now()}`);
      await fs.mkdir(dir, { recursive: true });
      cleanupPaths.push(dir);

      const ckptPath = path.join(dir, 'checkpoint.json');
      const ckpt = await Checkpoint.load(ckptPath);
      ckpt.markDone('x');
      await ckpt.flush();
      await ckpt.clear();

      expect(ckpt.completedCount()).toBe(0);
      // File should be removed
      const exists = await fs.access(ckptPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });
  });

  describe('contentHash', () => {
    it('returns consistent SHA-256 for same input', () => {
      const h1 = contentHash('hello');
      const h2 = contentHash('hello');
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(64); // hex SHA-256
    });

    it('returns different hash for different input', () => {
      expect(contentHash('a')).not.toBe(contentHash('b'));
    });

    it('handles empty string', () => {
      const h = contentHash('');
      expect(h).toHaveLength(64);
    });
  });

  describe('backupFile', () => {
    it('creates a timestamped backup', async () => {
      const dir = path.join(tmpDir, `backup-${Date.now()}`);
      await fs.mkdir(dir, { recursive: true });
      cleanupPaths.push(dir);

      const filePath = path.join(dir, 'data.ndjson');
      await fs.writeFile(filePath, 'original content', 'utf8');

      const backupPath = await backupFile(filePath);
      expect(backupPath).not.toBeNull();
      expect(backupPath!).toContain('data.ndjson.bak.');

      const backupContent = await fs.readFile(backupPath!, 'utf8');
      expect(backupContent).toBe('original content');
    });

    it('returns null for non-existent file', async () => {
      const result = await backupFile('/tmp/nonexistent-backup-test.json');
      expect(result).toBeNull();
    });

    it('prunes old backups beyond maxBackups', async () => {
      const dir = path.join(tmpDir, `backup-prune-${Date.now()}`);
      await fs.mkdir(dir, { recursive: true });
      cleanupPaths.push(dir);

      const filePath = path.join(dir, 'data.ndjson');
      await fs.writeFile(filePath, 'content', 'utf8');

      // Create 4 backups with maxBackups=2
      await backupFile(filePath, 2);
      await new Promise((r) => setTimeout(r, 10)); // ensure different timestamps
      await backupFile(filePath, 2);
      await new Promise((r) => setTimeout(r, 10));
      await backupFile(filePath, 2);

      const entries = await fs.readdir(dir);
      const backups = entries.filter((e) => e.includes('.bak.'));
      expect(backups.length).toBeLessThanOrEqual(2);
    });
  });

  describe('acquireLock', () => {
    it('acquires and releases a lock', async () => {
      const dir = path.join(tmpDir, `lock-${Date.now()}`);
      await fs.mkdir(dir, { recursive: true });
      cleanupPaths.push(dir);

      const lockPath = path.join(dir, 'test.lock');
      const unlock = await acquireLock(lockPath);

      // Lock file should exist
      const exists = await fs.access(lockPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      // Release lock
      await unlock();

      // Lock file should be gone
      const existsAfter = await fs.access(lockPath).then(() => true).catch(() => false);
      expect(existsAfter).toBe(false);
    });

    it('throws when lock is held by current process', async () => {
      const dir = path.join(tmpDir, `lock-held-${Date.now()}`);
      await fs.mkdir(dir, { recursive: true });
      cleanupPaths.push(dir);

      const lockPath = path.join(dir, 'held.lock');
      const unlock = await acquireLock(lockPath);

      try {
        await expect(acquireLock(lockPath)).rejects.toThrow(/lock/i);
      } finally {
        await unlock();
      }
    });
  });

  describe('appendDeadLetter', () => {
    it('appends entries as NDJSON lines', async () => {
      const dir = path.join(tmpDir, `dl-${Date.now()}`);
      await fs.mkdir(dir, { recursive: true });
      cleanupPaths.push(dir);

      const dlPath = path.join(dir, 'dead-letter.ndjson');

      await appendDeadLetter(dlPath, {
        sourceId: 'wine-1',
        step: 'critic-proxy',
        error: 'LLM timeout',
      });
      await appendDeadLetter(dlPath, {
        sourceId: 'wine-2',
        step: 'critic-proxy',
        error: 'Rate limited',
      });

      const content = await fs.readFile(dlPath, 'utf8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);

      const entry1 = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(entry1['sourceId']).toBe('wine-1');
      expect(entry1['step']).toBe('critic-proxy');
      expect(entry1['timestamp']).toBeDefined();
    });

    it('creates directory if needed', async () => {
      const dir = path.join(tmpDir, `dl-nested-${Date.now()}`, 'sub');
      cleanupPaths.push(path.join(tmpDir, `dl-nested-${Date.now()}`));

      const dlPath = path.join(dir, 'dead-letter.ndjson');
      await appendDeadLetter(dlPath, {
        sourceId: 'test',
        step: 'test',
        error: 'test',
      });

      const exists = await fs.access(dlPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
  });
});

import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendPrivateFile, ensurePrivateDirectory, PrivateArtifactContentWriteFailedError, PrivateArtifactPublicationConflictError,
  readPrivateFileState, writeNewPrivateFileWithMode, writePrivateFile, writePrivateFileWithMode,
  writePrivateFileWithModeExpected, writePrivateFileWithModeExpectedGuarded, writePrivateFileWithModeGuarded,
} from '../shared/utils/private-file.js';
import { runPrivateFileExclusive, runPrivateFileExclusiveAsync } from '../shared/utils/private-file-lock.js';

const failures = vi.hoisted(() => ({ write: false, rename: false, unlink: false }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (failures.write) { failures.write = false; throw Object.assign(new Error('write failed'), { code: 'ENOSPC' }); }
      return fs.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (failures.rename) { failures.rename = false; throw Object.assign(new Error('rename failed'), { code: 'EIO' }); }
      return fs.renameSync(...args);
    },
    unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
      if (failures.unlink) { failures.unlink = false; throw Object.assign(new Error('cleanup failed'), { code: 'EIO' }); }
      return fs.unlinkSync(...args);
    },
  };
});

const directories: string[] = [];
function fixture(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'takt-private-file-'));
  directories.push(directory);
  return { directory, path: join(directory, 'data.json') };
}
afterEach(() => {
  failures.write = false; failures.rename = false; failures.unlink = false;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('direct private file persistence', () => {
  it('writes and replaces complete content with private modes', () => {
    const { directory, path } = fixture();
    const nested = join(directory, 'a', 'b');
    ensurePrivateDirectory(nested);
    writePrivateFile(path, 'first');
    writePrivateFile(path, 'second');
    expect(readFileSync(path, 'utf8')).toBe('second');
    expect(readdirSync(directory).sort()).toEqual(['a', 'data.json']);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(nested).mode & 0o777).toBe(0o700);
      expect(statSync(join(directory, 'a')).mode & 0o777).toBe(0o700);
    }
  });

  it('retains an explicitly requested file mode and replaces read-only content', () => {
    const { path } = fixture();
    writePrivateFileWithMode(path, 'first', 0o400);
    writePrivateFileWithMode(path, 'second', 0o600);
    expect(readFileSync(path, 'utf8')).toBe('second');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('appends without a helper process and repairs file permissions', () => {
    const { path } = fixture();
    appendPrivateFile(path, 'a');
    chmodSync(path, 0o666);
    appendPrivateFile(path, 'b');
    expect(readFileSync(path, 'utf8')).toBe('ab');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('rejects an existing file when creating a new private file', () => {
    const { directory, path } = fixture();
    writeNewPrivateFileWithMode(path, 'first', 0o600);
    expect(() => writeNewPrivateFileWithMode(path, 'second', 0o600)).toThrow(PrivateArtifactPublicationConflictError);
    expect(readFileSync(path, 'utf8')).toBe('first');
    expect(readdirSync(directory)).toEqual(['data.json']);
  });

  it('checks absent, changed, and matching expected states', () => {
    const { path } = fixture();
    const absent = readPrivateFileState(path).state;
    writePrivateFileWithModeExpected(path, 'first', 0o600, absent);
    expect(() => writePrivateFileWithModeExpected(path, 'lost', 0o600, absent)).toThrow(PrivateArtifactPublicationConflictError);
    const saved = readPrivateFileState(path).state;
    writeFileSync(path, 'changed');
    expect(() => writePrivateFileWithModeExpected(path, 'lost', 0o600, saved)).toThrow(PrivateArtifactPublicationConflictError);
    writePrivateFileWithModeExpected(path, 'last', 0o600, readPrivateFileState(path).state);
    expect(readFileSync(path, 'utf8')).toBe('last');
  });

  it('discards a rejected publication and supports replacement content from its guard', () => {
    const { directory, path } = fixture();
    expect(writePrivateFileWithModeGuarded(path, 'unused', 0o600, () => false)).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(writePrivateFileWithModeGuarded(path, 'initial', 0o600, () => ({ publish: true, content: 'final' }))).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('final');
    expect(readdirSync(directory)).toEqual(['data.json']);
  });

  it('rechecks expected content after the publication guard', () => {
    const { path } = fixture();
    writePrivateFile(path, 'first');
    const expected = readPrivateFileState(path).state;
    expect(() => writePrivateFileWithModeExpectedGuarded(path, 'lost', 0o600, expected, () => {
      writeFileSync(path, 'other'); return true;
    })).toThrow(PrivateArtifactPublicationConflictError);
    expect(readFileSync(path, 'utf8')).toBe('other');
  });

  it.each(['write', 'rename'] as const)('retains original data and cleans temporary content after %s failure', (stage) => {
    const { directory, path } = fixture();
    writePrivateFile(path, 'original');
    failures[stage] = true;
    expect(() => writePrivateFile(path, 'lost')).toThrow(stage === 'write' ? PrivateArtifactContentWriteFailedError : Error);
    expect(readFileSync(path, 'utf8')).toBe('original');
    expect(readdirSync(directory)).toEqual(['data.json']);
  });

  it('rejects a concurrently created leaf before publication', () => {
    const { path } = fixture();
    expect(() => writePrivateFileWithModeGuarded(path, 'lost', 0o600, () => {
      writeFileSync(path, 'other'); return true;
    })).toThrow(PrivateArtifactPublicationConflictError);
    expect(readFileSync(path, 'utf8')).toBe('other');
  });

  it('retains both operation and cleanup errors', () => {
    const { path } = fixture();
    failures.write = true; failures.unlink = true;
    expect(() => writePrivateFile(path, 'lost')).toThrow(AggregateError);
    expect(existsSync(path)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('rejects a symlink leaf', () => {
    const { directory, path } = fixture();
    const other = join(directory, 'other');
    writeFileSync(other, 'other');
    symlinkSync(other, path);
    expect(() => writePrivateFile(path, 'lost')).toThrow();
    expect(readFileSync(other, 'utf8')).toBe('other');
  });

  it('releases synchronous locks after failure', () => {
    const { directory } = fixture();
    const lock = join(directory, 'lock');
    expect(() => runPrivateFileExclusive(lock, () => { throw new Error('failed'); })).toThrow();
    expect(runPrivateFileExclusive(lock, () => 42)).toBe(42);
    expect(existsSync(lock)).toBe(false);
  });

  it('holds the existing async lock until its action settles', async () => {
    const { directory } = fixture();
    const lock = join(directory, 'lock');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const operation = runPrivateFileExclusiveAsync(lock, async () => { entered(); await gate; return 42; });
    await started;
    expect(existsSync(lock)).toBe(true);
    release();
    expect(await operation).toBe(42);
    expect(existsSync(lock)).toBe(false);
  });
});

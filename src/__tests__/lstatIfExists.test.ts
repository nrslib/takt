import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstatIfExists } from '../shared/utils/index.js';

describe('lstatIfExists', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'takt-lstatIfExists-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return stats for an existing file', () => {
    const filePath = join(tmpDir, 'test.txt');
    writeFileSync(filePath, 'hello');

    const stats = lstatIfExists(filePath);

    expect(stats).not.toBeNull();
    expect(stats?.isFile()).toBe(true);
  });

  it('should return null for a non-existent path', () => {
    const result = lstatIfExists(join(tmpDir, 'missing.txt'));

    expect(result).toBeNull();
  });

  it('should return stats for a directory', () => {
    const dirPath = join(tmpDir, 'subdir');
    mkdirSync(dirPath);

    const stats = lstatIfExists(dirPath);

    expect(stats).not.toBeNull();
    expect(stats?.isDirectory()).toBe(true);
  });

  it('should identify symlinks without following them', () => {
    const target = join(tmpDir, 'target.txt');
    const link = join(tmpDir, 'link.txt');
    writeFileSync(target, 'content');
    symlinkSync(target, link);

    const stats = lstatIfExists(link);

    expect(stats).not.toBeNull();
    expect(stats?.isSymbolicLink()).toBe(true);
  });

  it('should return symlink stats for a broken symlink without following it', () => {
    const brokenLink = join(tmpDir, 'broken-link');
    symlinkSync(join(tmpDir, 'nonexistent-target'), brokenLink);

    const stats = lstatIfExists(brokenLink);
    expect(stats).not.toBeNull();
    expect(stats?.isSymbolicLink()).toBe(true);
  });
});

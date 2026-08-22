import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertPathSegmentsAreSafe, type BoundaryViolation } from '../shared/utils/index.js';

function buildTestError(violation: BoundaryViolation, segmentPath: string): Error {
  return new Error(`${violation}: ${segmentPath}`);
}

describe('assertPathSegmentsAreSafe', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'takt-pathBoundary-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return stats for a safe file path', () => {
    const filePath = join(tmpDir, 'safe.txt');
    writeFileSync(filePath, 'content');

    const stats = assertPathSegmentsAreSafe(tmpDir, filePath, buildTestError);

    expect(stats).not.toBeNull();
    expect(stats?.isFile()).toBe(true);
  });

  it('should return null when target does not exist', () => {
    const stats = assertPathSegmentsAreSafe(tmpDir, join(tmpDir, 'missing.txt'), buildTestError);

    expect(stats).toBeNull();
  });

  it('should throw "outside" for path traversal', () => {
    expect(() =>
      assertPathSegmentsAreSafe(tmpDir, join(tmpDir, '..', 'outside.txt'), buildTestError)
    ).toThrow('outside');
  });

  it('should throw "symlink" when a segment is a symbolic link', () => {
    const realDir = join(tmpDir, 'real');
    mkdirSync(realDir);
    writeFileSync(join(realDir, 'target.txt'), 'content');
    const linkDir = join(tmpDir, 'linked');
    symlinkSync(realDir, linkDir);

    expect(() =>
      assertPathSegmentsAreSafe(tmpDir, join(linkDir, 'target.txt'), buildTestError)
    ).toThrow('symlink');
  });

  it('should throw "symlink" when the final segment is a symbolic link', () => {
    const target = join(tmpDir, 'real.txt');
    writeFileSync(target, 'content');
    const link = join(tmpDir, 'link.txt');
    symlinkSync(target, link);

    expect(() =>
      assertPathSegmentsAreSafe(tmpDir, link, buildTestError)
    ).toThrow('symlink');
  });

  it('should throw "not_directory" when an intermediate segment is not a directory', () => {
    const filePath = join(tmpDir, 'file.txt');
    writeFileSync(filePath, 'content');

    expect(() =>
      assertPathSegmentsAreSafe(tmpDir, join(filePath, 'child.txt'), buildTestError)
    ).toThrow('not_directory');
  });

  it('should reject same path when rejectSamePath is true', () => {
    expect(() =>
      assertPathSegmentsAreSafe(tmpDir, tmpDir, buildTestError, { rejectSamePath: true })
    ).toThrow('outside');
  });

  it('should allow same path when rejectSamePath is not set', () => {
    const stats = assertPathSegmentsAreSafe(tmpDir, tmpDir, buildTestError);

    expect(stats).toBeNull();
  });

  it('should return directory stats for a valid subdirectory', () => {
    const subDir = join(tmpDir, 'subdir');
    mkdirSync(subDir);

    const stats = assertPathSegmentsAreSafe(tmpDir, subDir, buildTestError);

    expect(stats).not.toBeNull();
    expect(stats?.isDirectory()).toBe(true);
  });

  it('should return non-symlink stats after passing all checks', () => {
    const nested = join(tmpDir, 'a', 'b');
    mkdirSync(join(tmpDir, 'a'));
    mkdirSync(nested);
    const filePath = join(nested, 'file.txt');
    writeFileSync(filePath, 'content');

    const stats = assertPathSegmentsAreSafe(tmpDir, filePath, buildTestError);

    expect(stats).not.toBeNull();
    expect(stats?.isSymbolicLink()).toBe(false);
    expect(stats?.isFile()).toBe(true);
  });
});

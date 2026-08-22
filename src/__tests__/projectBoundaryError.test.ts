import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectBoundaryError } from '../features/exec/projectLocalFiles.js';
import { readProjectLocalTextFile, writeProjectLocalTextFile } from '../features/exec/projectLocalFiles.js';

describe('ProjectBoundaryError', () => {
  it('should be an instance of Error', () => {
    const error = new ProjectBoundaryError('test message');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ProjectBoundaryError);
  });

  it('should have name set to ProjectBoundaryError', () => {
    const error = new ProjectBoundaryError('test message');

    expect(error.name).toBe('ProjectBoundaryError');
  });

  it('should carry the provided message', () => {
    const message = 'Project-local exec config must stay inside the project and must not use symlinks: /path/to/file';
    const error = new ProjectBoundaryError(message);

    expect(error.message).toBe(message);
  });

  it('should be distinguishable from regular Error via instanceof', () => {
    const boundaryError = new ProjectBoundaryError('boundary violation');
    const regularError = new Error('regular error');

    expect(boundaryError instanceof ProjectBoundaryError).toBe(true);
    expect(regularError instanceof ProjectBoundaryError).toBe(false);
  });
});

describe('ProjectBoundaryError thrown from boundary violations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'takt-boundary-error-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should throw ProjectBoundaryError when reading a file with a symlink in the path', () => {
    const externalDir = mkdtempSync(join(tmpdir(), 'takt-boundary-external-'));
    try {
      const symlinkPath = join(tmpDir, 'linked-dir');
      symlinkSync(externalDir, symlinkPath);
      const filePath = join(symlinkPath, 'file.txt');

      expect(() => readProjectLocalTextFile(tmpDir, filePath, 'test resource'))
        .toThrow(ProjectBoundaryError);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('should throw ProjectBoundaryError when reading a file outside the project boundary', () => {
    const outsidePath = join(tmpDir, '..', 'outside-file.txt');

    expect(() => readProjectLocalTextFile(tmpDir, outsidePath, 'test resource'))
      .toThrow(ProjectBoundaryError);
  });

  it('should throw ProjectBoundaryError when writing to a path with a symlink', () => {
    const externalDir = mkdtempSync(join(tmpdir(), 'takt-boundary-write-'));
    try {
      const symlinkPath = join(tmpDir, 'linked-dir');
      symlinkSync(externalDir, symlinkPath);
      const filePath = join(symlinkPath, 'file.txt');

      expect(() => writeProjectLocalTextFile(tmpDir, filePath, 'content', 'test resource'))
        .toThrow(ProjectBoundaryError);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('should retain "Project-local" prefix in error message for existing catch patterns', () => {
    const outsidePath = join(tmpDir, '..', 'outside-file.txt');

    let caughtError: Error | undefined;
    try {
      readProjectLocalTextFile(tmpDir, outsidePath, 'exec config');
    } catch (error) {
      caughtError = error as Error;
    }

    expect(caughtError).toBeInstanceOf(ProjectBoundaryError);
    expect(caughtError?.message).toMatch(/^Project-local /);
  });
});

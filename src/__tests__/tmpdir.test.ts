import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureCurrentTmpDirExists } from '../shared/utils/tmpdir.js';

const temporaryDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

describe('ensureCurrentTmpDirExists', () => {
  afterEach(() => {
    for (const dir of temporaryDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Given TMPDIR points to a missing directory, When ensuring current tmpdir, Then the directory is created and returned', () => {
    const originalTmpDir = process.env.TMPDIR;
    const parentDir = createTempDir('takt-tmpdir-parent-');
    const missingTmpDir = join(parentDir, 'missing', 'tmp');
    process.env.TMPDIR = missingTmpDir;

    try {
      const ensuredTmpDir = ensureCurrentTmpDirExists();

      expect(ensuredTmpDir).toBe(missingTmpDir);
      expect(existsSync(missingTmpDir)).toBe(true);
      expect(statSync(missingTmpDir).isDirectory()).toBe(true);
    } finally {
      if (originalTmpDir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpDir;
      }
    }
  });
});

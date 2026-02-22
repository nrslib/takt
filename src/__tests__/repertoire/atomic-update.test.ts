/**
 * Tests for atomic package update (overwrite install).
 *
 * Covers:
 * - cleanupResiduals: pre-existing .tmp/ and .bak/ are removed before install
 * - atomicReplace: normal success path (new → .bak → rename)
 * - atomicReplace: validation failure → .tmp/ is removed, existing package preserved
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cleanupResiduals,
  atomicReplace,
  type AtomicReplaceOptions,
} from '../../features/repertoire/atomic-update.js';

// ---------------------------------------------------------------------------
// cleanupResiduals
// ---------------------------------------------------------------------------

describe('cleanupResiduals', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-atomic-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should remove pre-existing .tmp directory', () => {
    // Given: a .tmp directory remains from a previous failed install
    const packageDir = join(tempDir, 'takt-fullstack');
    const tmpDir = join(tempDir, 'takt-fullstack.tmp');
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'stale.yaml'), 'stale');

    // When: cleanup is performed
    cleanupResiduals(packageDir);

    // Then: .tmp directory is removed
    expect(existsSync(tmpDir)).toBe(false);
  });

  it('should remove pre-existing .bak directory', () => {
    // Given: a .bak directory remains from a previous failed install
    const packageDir = join(tempDir, 'takt-fullstack');
    const bakDir = join(tempDir, 'takt-fullstack.bak');
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(bakDir, { recursive: true });
    writeFileSync(join(bakDir, 'old.yaml'), 'old');

    // When: cleanup is performed
    cleanupResiduals(packageDir);

    // Then: .bak directory is removed
    expect(existsSync(bakDir)).toBe(false);
  });

  it('should succeed even when neither .tmp nor .bak exist', () => {
    // Given: no residual directories
    const packageDir = join(tempDir, 'takt-fullstack');
    mkdirSync(packageDir, { recursive: true });

    // When: cleanup is performed
    // Then: no error thrown
    expect(() => cleanupResiduals(packageDir)).not.toThrow();
  });

  it('should remove both .tmp and .bak when both exist', () => {
    // Given: both residuals exist
    const packageDir = join(tempDir, 'takt-fullstack');
    const tmpDirPath = join(tempDir, 'takt-fullstack.tmp');
    const bakDir = join(tempDir, 'takt-fullstack.bak');
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(tmpDirPath, { recursive: true });
    mkdirSync(bakDir, { recursive: true });

    // When: cleanup is performed
    cleanupResiduals(packageDir);

    // Then: both are removed
    expect(existsSync(tmpDirPath)).toBe(false);
    expect(existsSync(bakDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// atomicReplace
// ---------------------------------------------------------------------------

describe('atomicReplace', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-atomic-replace-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should replace existing package and delete .bak on success', async () => {
    // Given: an existing package directory
    const packageDir = join(tempDir, 'takt-fullstack');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'old.yaml'), 'old content');

    const options: AtomicReplaceOptions = {
      packageDir,
      install: async () => {
        // Simulate successful install into packageDir
        writeFileSync(join(packageDir, 'new.yaml'), 'new content');
      },
    };

    // When: atomicReplace is executed
    await atomicReplace(options);

    // Then: new content is in place, .bak is cleaned up
    expect(existsSync(join(packageDir, 'new.yaml'))).toBe(true);
    expect(existsSync(join(tempDir, 'takt-fullstack.bak'))).toBe(false);
  });

  it('should preserve existing package when install throws (validation failure)', async () => {
    // Given: an existing package with content
    const packageDir = join(tempDir, 'takt-fullstack');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'existing.yaml'), 'existing');

    const options: AtomicReplaceOptions = {
      packageDir,
      install: async () => {
        // Simulate validation failure
        throw new Error('Validation failed: empty package');
      },
    };

    // When: atomicReplace is executed with a failing install
    await expect(atomicReplace(options)).rejects.toThrow('Validation failed');

    // Then: existing package is preserved
    expect(existsSync(join(packageDir, 'existing.yaml'))).toBe(true);
    // .tmp directory should be cleaned up
    expect(existsSync(join(tempDir, 'takt-fullstack.tmp'))).toBe(false);
  });
});

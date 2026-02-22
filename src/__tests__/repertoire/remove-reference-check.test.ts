/**
 * Tests for reference integrity check during repertoire remove.
 *
 * Covers:
 * - shouldRemoveOwnerDir(): returns true when owner dir has no other packages
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shouldRemoveOwnerDir } from '../../features/repertoire/remove.js';

// ---------------------------------------------------------------------------
// shouldRemoveOwnerDir
// ---------------------------------------------------------------------------

describe('shouldRemoveOwnerDir', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-owner-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return true when owner dir has no other packages', () => {
    // Given: owner dir with only one package (the one being removed)
    const ownerDir = join(tempDir, '@nrslib');
    mkdirSync(join(ownerDir, 'takt-fullstack'), { recursive: true });

    // When: checking if owner dir should be removed (after deleting takt-fullstack)
    const result = shouldRemoveOwnerDir(ownerDir, 'takt-fullstack');

    // Then: owner dir can be removed (no other packages)
    expect(result).toBe(true);
  });

  it('should return false when owner dir has other packages', () => {
    // Given: owner dir with two packages
    const ownerDir = join(tempDir, '@nrslib');
    mkdirSync(join(ownerDir, 'takt-fullstack'), { recursive: true });
    mkdirSync(join(ownerDir, 'takt-security-facets'), { recursive: true });

    // When: checking if owner dir should be removed (after deleting takt-fullstack)
    const result = shouldRemoveOwnerDir(ownerDir, 'takt-fullstack');

    // Then: owner dir should NOT be removed (other package remains)
    expect(result).toBe(false);
  });

  it('should return true when owner dir is empty after removal', () => {
    // Given: owner dir with just the target package
    const ownerDir = join(tempDir, '@acme-corp');
    mkdirSync(join(ownerDir, 'takt-backend'), { recursive: true });

    // When: checking for acme-corp owner dir
    const result = shouldRemoveOwnerDir(ownerDir, 'takt-backend');

    // Then: empty → can be removed
    expect(result).toBe(true);
  });
});

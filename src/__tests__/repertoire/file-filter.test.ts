/**
 * Tests for file filtering during package copy operations.
 *
 * Covers:
 * - Allowed extensions (.md, .yaml, .yml)
 * - Disallowed extensions (.sh, .js, .env, .ts, etc.)
 * - collectCopyTargets: only facets/ and pieces/ directories copied
 * - collectCopyTargets: symbolic links skipped
 * - collectCopyTargets: file count limit (error if exceeds MAX_FILE_COUNT)
 * - collectCopyTargets: path subdirectory scenario
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isAllowedExtension,
  collectCopyTargets,
  MAX_FILE_SIZE,
  MAX_FILE_COUNT,
  ALLOWED_EXTENSIONS,
  ALLOWED_DIRS,
} from '../../features/repertoire/file-filter.js';

// ---------------------------------------------------------------------------
// isAllowedExtension
// ---------------------------------------------------------------------------

describe('isAllowedExtension', () => {
  it('should allow .md files', () => {
    expect(isAllowedExtension('coder.md')).toBe(true);
  });

  it('should allow .yaml files', () => {
    expect(isAllowedExtension('takt-repertoire.yaml')).toBe(true);
  });

  it('should allow .yml files', () => {
    expect(isAllowedExtension('config.yml')).toBe(true);
  });

  it('should reject .sh files', () => {
    expect(isAllowedExtension('setup.sh')).toBe(false);
  });

  it('should reject .js files', () => {
    expect(isAllowedExtension('script.js')).toBe(false);
  });

  it('should reject .env files', () => {
    expect(isAllowedExtension('.env')).toBe(false);
  });

  it('should reject .ts files', () => {
    expect(isAllowedExtension('types.ts')).toBe(false);
  });

  it('should reject files with no extension', () => {
    expect(isAllowedExtension('Makefile')).toBe(false);
  });

  it('should reject .json files', () => {
    expect(isAllowedExtension('package.json')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// collectCopyTargets
// ---------------------------------------------------------------------------

describe('collectCopyTargets', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-collect-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should only include files under facets/ and pieces/ directories', () => {
    // Given: package root with facets/, pieces/, and a README.md at root
    mkdirSync(join(tempDir, 'facets', 'personas'), { recursive: true });
    mkdirSync(join(tempDir, 'pieces'), { recursive: true });
    writeFileSync(join(tempDir, 'facets', 'personas', 'coder.md'), 'Coder persona');
    writeFileSync(join(tempDir, 'pieces', 'expert.yaml'), 'name: expert');
    writeFileSync(join(tempDir, 'README.md'), 'Readme'); // should be excluded

    // When: collectCopyTargets scans the package root
    const targets = collectCopyTargets(tempDir);
    const paths = targets.map((t) => t.relativePath);

    // Then: only facets/ and pieces/ files are included
    expect(paths).toContain(join('facets', 'personas', 'coder.md'));
    expect(paths).toContain(join('pieces', 'expert.yaml'));
    expect(paths.some((p) => p === 'README.md')).toBe(false);
  });

  it('should skip symbolic links during scan', () => {
    // Given: facets/ with a symlink
    mkdirSync(join(tempDir, 'facets', 'personas'), { recursive: true });
    const target = join(tempDir, 'facets', 'personas', 'real.md');
    writeFileSync(target, 'Real content');
    symlinkSync(target, join(tempDir, 'facets', 'personas', 'link.md'));

    // When: collectCopyTargets scans
    const targets = collectCopyTargets(tempDir);
    const paths = targets.map((t) => t.relativePath);

    // Then: symlink is excluded
    expect(paths.some((p) => p.includes('link.md'))).toBe(false);
    expect(paths.some((p) => p.includes('real.md'))).toBe(true);
  });

  it('should throw when file count exceeds MAX_FILE_COUNT', () => {
    // Given: more than MAX_FILE_COUNT files under facets/
    mkdirSync(join(tempDir, 'facets', 'personas'), { recursive: true });
    for (let i = 0; i <= MAX_FILE_COUNT; i++) {
      writeFileSync(join(tempDir, 'facets', 'personas', `file-${i}.md`), 'content');
    }

    // When: collectCopyTargets scans
    // Then: throws because file count limit is exceeded
    expect(() => collectCopyTargets(tempDir)).toThrow();
  });

  it('should skip files exceeding MAX_FILE_SIZE', () => {
    // Given: facets/ with a valid file and a file exceeding the size limit
    mkdirSync(join(tempDir, 'facets', 'personas'), { recursive: true });
    writeFileSync(join(tempDir, 'facets', 'personas', 'coder.md'), 'valid');
    writeFileSync(
      join(tempDir, 'facets', 'personas', 'large.md'),
      Buffer.alloc(MAX_FILE_SIZE + 1),
    );

    // When: collectCopyTargets scans
    const targets = collectCopyTargets(tempDir);
    const paths = targets.map((t) => t.relativePath);

    // Then: large file is skipped, valid file is included
    expect(paths.some((p) => p.includes('large.md'))).toBe(false);
    expect(paths.some((p) => p.includes('coder.md'))).toBe(true);
  });

  it('should adjust copy base when path is "takt" (subdirectory scenario)', () => {
    // Given: package has path: "takt", so facets/ is under takt/facets/
    mkdirSync(join(tempDir, 'takt', 'facets', 'personas'), { recursive: true });
    writeFileSync(join(tempDir, 'takt', 'facets', 'personas', 'coder.md'), 'Coder');

    // When: collectCopyTargets is called with packageRoot = tempDir/takt
    const packageRoot = join(tempDir, 'takt');
    const targets = collectCopyTargets(packageRoot);
    const paths = targets.map((t) => t.relativePath);

    // Then: file is found under facets/personas/
    expect(paths).toContain(join('facets', 'personas', 'coder.md'));
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('ALLOWED_EXTENSIONS should include .md, .yaml, .yml', () => {
    expect(ALLOWED_EXTENSIONS).toContain('.md');
    expect(ALLOWED_EXTENSIONS).toContain('.yaml');
    expect(ALLOWED_EXTENSIONS).toContain('.yml');
  });

  it('ALLOWED_DIRS should include faceted and pieces', () => {
    expect(ALLOWED_DIRS).toContain('facets');
    expect(ALLOWED_DIRS).toContain('pieces');
  });

  it('MAX_FILE_SIZE should be defined as a positive number', () => {
    expect(MAX_FILE_SIZE).toBeGreaterThan(0);
  });

  it('MAX_FILE_COUNT should be defined as a positive number', () => {
    expect(MAX_FILE_COUNT).toBeGreaterThan(0);
  });
});
